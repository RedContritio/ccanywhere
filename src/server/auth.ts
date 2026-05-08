import type { FastifyInstance } from 'fastify';
import type { Token } from '../config/schema.js';
import { logger } from '../log.js';

declare module 'fastify' {
  interface FastifyRequest {
    authTokenLabel?: string;
  }
}

const PUBLIC_PATHS = new Set<string>(['/healthz']);

function extractBearer(authHeader: unknown): string | null {
  if (typeof authHeader !== 'string') return null;
  if (!authHeader.startsWith('Bearer ')) return null;
  const v = authHeader.slice('Bearer '.length).trim();
  return v.length > 0 ? v : null;
}

function extractQueryToken(query: unknown): string | null {
  if (typeof query !== 'object' || query === null) return null;
  const q = query as Record<string, unknown>;
  const t = q['token'];
  return typeof t === 'string' && t.length > 0 ? t : null;
}

export async function registerAuth(
  app: FastifyInstance,
  tokens: ReadonlyArray<Token>,
  internalHookToken: string,
): Promise<void> {
  if (internalHookToken.length < 16) {
    throw new Error('internalHookToken must be at least 16 chars');
  }
  const userTokens = new Map<string, Token>();
  for (const t of tokens) userTokens.set(t.token, t);

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
      // Suppress fastify reply
      void reply.hijack();
      logger.debug({ url, message }, 'ws upgrade rejected');
    };

    if (url.startsWith('/api/hook/')) {
      const token = extractBearer(req.headers.authorization);
      if (token !== internalHookToken) {
        await reply
          .code(401)
          .send({ error: { code: 'unauthorized', message: 'invalid hook token' } });
      }
      return;
    }

    if (PUBLIC_PATHS.has(url)) return;

    const token = extractBearer(req.headers.authorization) ?? extractQueryToken(req.query);
    if (token === null) {
      if (isUpgrade) {
        rejectUpgrade(401, 'missing token');
      } else {
        await reply
          .code(401)
          .send({ error: { code: 'unauthorized', message: 'missing token' } });
      }
      return;
    }
    const found = userTokens.get(token);
    if (!found) {
      if (isUpgrade) {
        rejectUpgrade(401, 'invalid token');
      } else {
        await reply
          .code(401)
          .send({ error: { code: 'unauthorized', message: 'invalid token' } });
      }
      return;
    }
    req.authTokenLabel = found.label;
  });
}
