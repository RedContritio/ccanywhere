import type { FastifyInstance } from 'fastify';
import type { Device } from '../devices/types.js';
import type { DeviceStore } from '../devices/store.js';
import { logger } from '../log.js';
import { SESSION_COOKIE_NAME } from './routes/auth.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the cookie session middleware on /api/* and /ws/* requests. */
    authDevice?: Device;
    /** Legacy: filled when the request's bearer matches an internalHookToken. */
    authTokenLabel?: string;
  }
}

export interface RegisterAuthOptions {
  readonly store: DeviceStore;
  readonly internalHookToken: string;
  readonly cliToken: string;
}

function extractBearer(authHeader: unknown): string | null {
  if (typeof authHeader !== 'string') return null;
  if (!authHeader.startsWith('Bearer ')) return null;
  const v = authHeader.slice('Bearer '.length).trim();
  return v.length > 0 ? v : null;
}

/**
 * URL prefixes that bypass cookie auth — they handle their own challenge/
 * response flow or are intentionally public.
 */
const AUTH_PUBLIC_PREFIXES: ReadonlyArray<string> = [
  '/api/auth/register-init',
  '/api/auth/register-complete',
  '/api/auth/register-status',
  '/api/auth/login-init',
  '/api/auth/login-complete',
];

export async function registerAuth(
  app: FastifyInstance,
  opts: RegisterAuthOptions,
): Promise<void> {
  if (opts.internalHookToken.length < 16) {
    throw new Error('internalHookToken must be at least 16 chars');
  }
  if (opts.cliToken.length < 16) {
    throw new Error('cliToken must be at least 16 chars');
  }

  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0] ?? '';

    const isUpgrade =
      typeof req.headers.upgrade === 'string' &&
      req.headers.upgrade.toLowerCase() === 'websocket';

    const rejectUpgrade = (status: number, message: string): void => {
      const socket = req.raw.socket;
      const body = `HTTP/1.1 ${status} Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`;
      try {
        socket.write(body);
      } catch {
        // ignore
      }
      socket.destroy();
      void reply.hijack();
      logger.debug({ url, message }, 'ws upgrade rejected');
    };

    // 1) Hook receiver — its own bearer-token domain.
    if (url.startsWith('/api/hook/')) {
      const token = extractBearer(req.headers.authorization);
      if (token !== opts.internalHookToken) {
        await reply
          .code(401)
          .send({ error: { code: 'unauthorized', message: 'invalid hook token' } });
      }
      return;
    }

    // 2) CLI internal RPC — only reachable from local mac CLI with the
    //    cliToken file (mode 0600 in ~/.config/ccanywhere/).
    if (url.startsWith('/api/internal/')) {
      const token = extractBearer(req.headers.authorization);
      if (token !== opts.cliToken) {
        await reply
          .code(401)
          .send({ error: { code: 'unauthorized', message: 'invalid cli token' } });
      }
      return;
    }

    // 3) Public auth flow endpoints.
    if (AUTH_PUBLIC_PREFIXES.some((p) => url === p || url.startsWith(`${p}?`))) {
      return;
    }

    // 4) Non-API routes are public (SPA, /healthz, SPA fallback).
    if (!url.startsWith('/api/') && !url.startsWith('/ws/')) {
      return;
    }

    // 5) Everything else is gated by cookie session.
    const sessionId = req.cookies[SESSION_COOKIE_NAME];
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      if (isUpgrade) {
        rejectUpgrade(401, 'missing session cookie');
      } else {
        await reply
          .code(401)
          .send({ error: { code: 'unauthorized', message: 'missing session' } });
      }
      return;
    }
    const device = opts.store.authenticateSession(sessionId);
    if (!device) {
      if (isUpgrade) {
        rejectUpgrade(401, 'invalid or expired session');
      } else {
        await reply
          .code(401)
          .send({ error: { code: 'unauthorized', message: 'invalid or expired session' } });
      }
      return;
    }
    req.authDevice = device;
  });
}
