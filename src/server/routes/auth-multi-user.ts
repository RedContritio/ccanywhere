import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { TokenStore } from '../../tokens/store.js';
import type { UserStore } from '../../users/store.js';

const TokenLoginSchema = z.object({ token: z.string().min(32) });

export interface AuthMultiUserRoutesOptions {
  readonly userStore: UserStore;
  readonly tokenStore: TokenStore;
  readonly cookieName: string;
  readonly cookieOpts: {
    httpOnly: boolean;
    sameSite: 'lax' | 'strict' | 'none';
    secure: boolean;
    path: string;
    maxAge: number;
  };
}

/**
 * m-multi-user (#44) auth routes for token-based limited-user login + the
 * current-user quota endpoint. Mounted by `registerAuthRoutes` only when
 * `userStore` + `tokenStore` are wired.
 */
export async function registerAuthMultiUserRoutes(
  app: FastifyInstance,
  opts: AuthMultiUserRoutesOptions,
): Promise<void> {
  const { userStore, tokenStore, cookieName, cookieOpts } = opts;

  app.post('/api/auth/token', async (req, reply) => {
    const parsed = TokenLoginSchema.safeParse(req.body);
    if (!parsed.success) {
      await reply
        .code(400)
        .send({ error: { code: 'invalid_request', message: 'body validation failed' } });
      return;
    }
    const token = tokenStore.verify(parsed.data.token);
    if (token === null) {
      await reply
        .code(401)
        .send({ error: { code: 'unauthorized', message: 'invalid or expired token' } });
      return;
    }
    const user = userStore.findById(token.userId);
    if (user === null || user.kind !== 'limited') {
      await reply
        .code(401)
        .send({ error: { code: 'unauthorized', message: 'token user invalid' } });
      return;
    }
    userStore.touchLogin(user.id);
    // Cookie value = token plaintext; re-verifies on every request via
    // tokenStore.verify (constant-time). Cookie ttl ≤ token ttl.
    const ttlSec = Math.max(60, Math.floor((token.expiresAt - Date.now()) / 1000));
    void reply.setCookie(cookieName, parsed.data.token, { ...cookieOpts, maxAge: ttlSec });
    await reply.code(200).send({ ok: true, user: { username: user.username, kind: user.kind } });
  });

  app.get('/api/me/quota', async (req, reply) => {
    const user = req.user;
    if (user === undefined) {
      await reply
        .code(401)
        .send({ error: { code: 'unauthorized', message: 'not logged in' } });
      return;
    }
    await reply.code(200).send({
      kind: user.kind,
      cost: user.quota.cost,
      tokens: user.quota.tokens,
    });
  });
}
