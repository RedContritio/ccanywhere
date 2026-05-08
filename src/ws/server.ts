import websocketPlugin from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { logger } from '../log.js';
import type { Session, SessionManager } from '../session/manager.js';
import { ClientFrameSchema, type ServerFrame } from './protocol.js';

const FLUSH_INTERVAL_MS = 100;
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
): Promise<void> {
  await app.register(websocketPlugin);

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
        if (bundle.flushTimer === null) {
          const t = setTimeout(() => {
            bundle.flushTimer = null;
            flush(bundle);
          }, FLUSH_INTERVAL_MS);
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
      });

      sock.on('error', (err: Error) => {
        logger.warn({ err, sessionId }, 'websocket error');
      });
    },
  );
}
