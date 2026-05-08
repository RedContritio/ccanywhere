import websocketPlugin from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { logger } from '../log.js';
import type { Session, SessionManager } from '../session/manager.js';
import { attachHeartbeatToWs, type HeartbeatConfig } from './heartbeat.js';
import { ClientFrameSchema, type ServerFrame } from './protocol.js';

export interface WebSocketRoutesOptions {
  readonly heartbeat?: HeartbeatConfig;
  /**
   * Trailing-flush window in ms. Effective frame rate = 1000 / value.
   * Defaults to ~60fps (17ms) when omitted.
   */
  readonly outputFlushIntervalMs?: number;
}

// Default frame-aligned with 60Hz displays so the trailing flush lands
// on the next paintable tick. Override via config.outputFps (passed
// through WebSocketRoutesOptions.outputFlushIntervalMs).
const DEFAULT_FLUSH_INTERVAL_MS = 17;
const MAX_BUFFERED_BYTES = 1 << 20; // 1 MB

function sendFrame(ws: WebSocket, frame: ServerFrame): void {
  if (ws.readyState === ws.CLOSING || ws.readyState === ws.CLOSED) return;
  if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
    logger.warn(
      { buffered: ws.bufferedAmount },
      'ws backpressure exceeded, closing client',
    );
    try {
      ws.close(1009, 'backpressure');
    } catch {
      // ignore
    }
    return;
  }
  try {
    ws.send(JSON.stringify(frame));
  } catch (err) {
    logger.warn({ err, frameType: frame.type }, 'ws send failed');
  }
}

interface SessionBundle {
  readonly session: Session;
  readonly clients: Set<WebSocket>;
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

  function flush(bundle: SessionBundle): void {
    if (bundle.pending.length === 0) return;
    const frame: ServerFrame = { type: 'output', data: bundle.pending };
    bundle.pending = '';
    for (const c of bundle.clients) sendFrame(c, frame);
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
    for (const c of bundle.clients) {
      try {
        c.close(1000, 'session ended');
      } catch {
        // ignore
      }
    }
    bundle.clients.clear();
    bundles.delete(bundle.session.info.id);
  }

  function attach(session: Session): SessionBundle {
    const existing = bundles.get(session.info.id);
    if (existing) return existing;
    const bundle: SessionBundle = {
      session,
      clients: new Set(),
      pending: '',
      flushTimer: null,
      disposers: [],
    };
    bundles.set(session.info.id, bundle);

    bundle.disposers.push(
      session.on('data', ({ data }) => {
        bundle.pending += data;
        // Leading-edge debounce: when no timer is armed (this is the
        // first byte after an idle period), flush immediately so the
        // user never waits FLUSH_INTERVAL_MS for keyboard echo. Then
        // arm a window for any rapid-fire follow-up bytes (Ink TUI
        // repaint storms) to be batched into a single trailing frame.
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
        for (const c of bundle.clients) sendFrame(c, frame);
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
      if (!session) {
        sendFrame(sock, { type: 'error', message: 'session not found' });
        sock.close(1008, 'session not found');
        return;
      }

      const bundle = attach(session);
      bundle.clients.add(sock);

      const detachHeartbeat = options.heartbeat
        ? attachHeartbeatToWs(sock, options.heartbeat)
        : null;

      sendFrame(sock, { type: 'snapshot', data: session.scrollback.snapshot() });
      sendFrame(sock, { type: 'status', state: session.state });

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
          case 'input':
            session.write(f.data);
            return;
          case 'resize':
            try {
              session.resize(f.cols, f.rows);
            } catch (err) {
              sendFrame(sock, {
                type: 'error',
                message: err instanceof Error ? err.message : 'resize error',
              });
            }
            return;
          case 'ping':
            sendFrame(sock, { type: 'pong' });
            return;
        }
      });

      sock.on('close', () => {
        bundle.clients.delete(sock);
        detachHeartbeat?.();
      });

      sock.on('error', (err: Error) => {
        logger.warn({ err, sessionId }, 'websocket error');
      });
    },
  );
}
