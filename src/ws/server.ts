import websocketPlugin from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { logger } from '../log.js';
import type { Session, SessionManager } from '../session/manager.js';
import type { UserStore } from '../users/store.js';
import { attachHeartbeatToWs, type HeartbeatConfig } from './heartbeat.js';
import { ClientFrameSchema, type ServerFrame } from './protocol.js';
import { evaluateQuotaGate } from './quota-gate.js';
import { sendFrame } from './send-frame.js';

export interface WebSocketRoutesOptions {
  readonly heartbeat?: HeartbeatConfig;
  /**
   * Trailing-flush window in ms. Effective frame rate = 1000 / value.
   * Defaults to ~60fps (17ms) when omitted.
   */
  readonly outputFlushIntervalMs?: number;
  /**
   * m-quota-inline: when set, every input frame is gated by
   * `evaluateQuotaGate(userStore, session)` before being written to the
   * PTY. Owner kind / unknown userId pass through. Without userStore the
   * gate is disabled (legacy / fixture mode).
   */
  readonly userStore?: UserStore;
}

// 17ms ≈ 60Hz; trailing flush lands on next paintable tick. Override via config.outputFps.
const DEFAULT_FLUSH_INTERVAL_MS = 17;

interface SessionBundle {
  readonly session: Session;
  readonly clients: Set<WebSocket>;
  // Buffers broadcast frames in the [attach, sendInitialState] window;
  // drained at end of sendInitialState (seq <= snapshot.upToSeq dropped,
  // status dropped) to keep "snapshot first then write" client contract.
  readonly pendingClients: Map<WebSocket, ServerFrame[]>;
  pending: string;
  flushTimer: NodeJS.Timeout | null;
  disposers: Array<() => void>;
}

export async function registerWebSocketRoutes(
  app: FastifyInstance,
  manager: SessionManager,
  options: WebSocketRoutesOptions = {},
): Promise<void> {
  await app.register(websocketPlugin);

  const flushIntervalMs = options.outputFlushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const bundles = new Map<string, SessionBundle>();

  function deliver(bundle: SessionBundle, c: WebSocket, frame: ServerFrame): void {
    const queue = bundle.pendingClients.get(c);
    if (queue !== undefined) queue.push(frame);
    else sendFrame(c, frame);
  }

  function flush(bundle: SessionBundle): void {
    if (bundle.pending.length === 0) return;
    // headSeq is the cumulative byte counter AFTER everything in pending
    // has been appended to the scrollback (which happens synchronously on
    // PTY data — pending grew from those same data events). Sending it
    // tells the client what `lastSeq` to remember for reconnect.
    const seq = bundle.session.scrollback.headSeq;
    const frame: ServerFrame = { type: 'output', seq, data: bundle.pending };
    bundle.pending = '';
    for (const c of bundle.clients) deliver(bundle, c, frame);
  }

  function teardown(bundle: SessionBundle): void {
    if (bundle.flushTimer !== null) {
      clearTimeout(bundle.flushTimer);
      bundle.flushTimer = null;
    }
    for (const d of bundle.disposers) {
      try {
        d();
      } catch (err) {
        logger.warn({ err }, 'disposer threw');
      }
    }
    bundle.disposers = [];
    // Close code by death cause: 4002 = DELETE-driven teardown (markDeleted
    // set deletedAt pre-kill); 1000 = cc self-exit; 1008 = not-found at
    // upgrade. See openspec/specs/ws-protocol/spec.md "Close code 表".
    const closeCode = bundle.session.deletedAt !== null ? 4002 : 1000;
    const closeReason = bundle.session.deletedAt !== null ? 'session deleted' : 'session ended';
    for (const c of bundle.clients) {
      try {
        c.close(closeCode, closeReason);
      } catch {
        // ignore
      }
    }
    bundle.clients.clear();
    bundle.pendingClients.clear();
    bundles.delete(bundle.session.info.id);
  }

  function attach(session: Session): SessionBundle {
    const existing = bundles.get(session.info.id);
    if (existing) return existing;
    const bundle: SessionBundle = {
      session,
      clients: new Set(),
      pendingClients: new Map(),
      pending: '',
      flushTimer: null,
      disposers: [],
    };
    bundles.set(session.info.id, bundle);

    // Leading-edge debounce: first byte after idle flushes immediately
    // (keyboard echo never waits FLUSH_INTERVAL_MS); rapid follow-up
    // bytes (Ink TUI repaint storms) batch into one trailing frame.
    bundle.disposers.push(
      session.on('data', ({ data }) => {
        bundle.pending += data;
        if (bundle.flushTimer === null) {
          flush(bundle);
          const t = setTimeout(() => {
            bundle.flushTimer = null;
            flush(bundle);
          }, flushIntervalMs);
          t.unref();
          bundle.flushTimer = t;
        }
      }),
    );
    bundle.disposers.push(
      session.on('status', ({ state }) => {
        flush(bundle);
        const frame: ServerFrame = { type: 'status', state };
        for (const c of bundle.clients) deliver(bundle, c, frame);
      }),
    );
    bundle.disposers.push(
      session.on('exit', () => {
        flush(bundle);
        teardown(bundle);
      }),
    );

    return bundle;
  }

  app.get<{ Params: { id: string } }>(
    '/ws/sessions/:id',
    { websocket: true },
    (sock, req) => {
      const sessionId = req.params.id;
      const session = manager.get(sessionId);
      logger.debug(
        { sessionId, deviceId: req.authDevice?.id, ip: req.ip, found: session !== undefined },
        'ws client connected',
      );
      // m-multi-user: cross-user mismatch masked as 1008 (uniform with
      // not-found) — see ws-protocol spec on close codes.
      const userMismatch =
        session !== undefined &&
        req.user !== undefined &&
        session.info.userId !== req.user.id;
      if (session === undefined || userMismatch) {
        sendFrame(sock, { type: 'error', message: 'session not found' });
        sock.close(1008, 'session not found');
        return;
      }

      const bundle = attach(session);
      bundle.clients.add(sock);
      // Gate broadcast frames until sendInitialState delivers snapshot/
      // delta + status — preserves client's "snapshot → reset → write" order.
      bundle.pendingClients.set(sock, []);
      const detachHeartbeat = options.heartbeat
        ? attachHeartbeatToWs(sock, options.heartbeat)
        : null;
      // Initial state delivery, gated on the first 'resize' so screenState
      // cols/rows match client xterm before SerializeAddon emits ANSI. For
      // reconnects with ?lastSeq=N, send incremental delta instead of full.
      const lastSeqRaw = (req.query as { lastSeq?: string } | undefined)?.lastSeq;
      const parsedLastSeq = typeof lastSeqRaw === 'string' ? Number.parseInt(lastSeqRaw, 10) : 0;
      const lastSeq = Number.isFinite(parsedLastSeq) && parsedLastSeq >= 0 ? parsedLastSeq : 0;

      let snapshotSent = false;
      const sendInitialState = (): void => {
        if (snapshotSent) return;
        snapshotSent = true;
        const headSeq = session.scrollback.headSeq;
        if (lastSeq > 0) {
          const delta = session.scrollback.since(lastSeq);
          if (delta === null) {
            // Client's lastSeq is older than our ring; fall back to full
            // snapshot via screenState's minimal-ANSI serialization.
            sendFrame(sock, {
              type: 'snapshot',
              upToSeq: headSeq,
              data: session.screenState.snapshot(),
            });
          } else if (delta.length > 0) {
            // Incremental — client doesn't reset, just appends.
            sendFrame(sock, { type: 'output', seq: headSeq, data: delta });
          }
          // else: nothing missed; status frame is enough.
        } else {
          // First connect — full snapshot.
          sendFrame(sock, {
            type: 'snapshot',
            upToSeq: headSeq,
            data: session.screenState.snapshot(),
          });
        }
        sendFrame(sock, { type: 'status', state: session.state });

        // Drain pending broadcast queue. All buffered output frames have
        // seq <= headSeq because Scrollback.append happens synchronously
        // in PTY onData before 'data' is emitted (single-threaded event
        // loop), so the snapshot/delta path above already covers them —
        // drop. Pre-init status frames are stale; the status frame just
        // sent above carries the current state — drop. Delete map entry
        // first so a sync send error mid-loop doesn't leave it stranded.
        const queue = bundle.pendingClients.get(sock);
        bundle.pendingClients.delete(sock);
        if (queue !== undefined) {
          for (const frame of queue) {
            if (frame.type === 'output' && frame.seq <= headSeq) continue;
            if (frame.type === 'status') continue;
            sendFrame(sock, frame);
          }
        }
      };
      const fallbackTimer = setTimeout(sendInitialState, 1_500);

      sock.on('message', (raw: Buffer) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.toString('utf8'));
        } catch {
          sendFrame(sock, { type: 'error', message: 'invalid json' });
          return;
        }
        const result = ClientFrameSchema.safeParse(parsed);
        if (!result.success) {
          sendFrame(sock, { type: 'error', message: 'invalid frame' });
          return;
        }
        const f = result.data;
        switch (f.type) {
          case 'input': {
            // m-quota-inline: gate before PTY write; cc never sees blocked bytes.
            const gate = evaluateQuotaGate(options.userStore, session, f.data);
            if (gate.blocked) {
              sendFrame(sock, { type: 'quota_exhausted', reason: gate.reason ?? 'quota exhausted' });
              return;
            }
            session.write(f.data);
            return;
          }
          case 'resize':
            try {
              session.resize(f.cols, f.rows);
            } catch (err) {
              sendFrame(sock, {
                type: 'error',
                message: err instanceof Error ? err.message : 'resize error',
              });
              return;
            }
            // First resize after connect: brief delay so cc's SIGWINCH
            // redraw bytes reach screenState before we serialize, else
            // the snapshot carries old cols/rows and the client renders
            // broken row widths.
            if (!snapshotSent) {
              clearTimeout(fallbackTimer);
              setTimeout(sendInitialState, 200);
            }
            return;
          case 'ping':
            sendFrame(sock, { type: 'pong' });
            return;
        }
      });

      sock.on('close', (code: number, reason: Buffer) => {
        bundle.clients.delete(sock);
        bundle.pendingClients.delete(sock);
        detachHeartbeat?.();
        clearTimeout(fallbackTimer);
        logger.debug(
          { sessionId, code, reason: reason.toString('utf8') },
          'ws client closed',
        );
      });

      sock.on('error', (err: Error) => {
        logger.warn({ err, sessionId }, 'websocket error');
      });
    },
  );
}
