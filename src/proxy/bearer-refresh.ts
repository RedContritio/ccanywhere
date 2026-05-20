import type { FastifyInstance } from 'fastify';
import type { TokenIssuer } from './tokens.js';

export interface BearerRefreshDeps {
  readonly tokenIssuer: TokenIssuer;
}

/**
 *  C5c: `POST /ccanywhere/bearer-refresh`.
 *
 * cc's `apiKeyHelper` rotates the short-TTL ANTHROPIC_AUTH_TOKEN when
 * the previous one 401s upstream. The helper script in the container
 * presents a long-lived (24h) "helper bearer" issued at session spawn
 * and receives a fresh 5-min bearer here.
 *
 * Authentication: any token the TokenIssuer can verify (helper bearer
 * OR short-TTL bearer — both ride the same HMAC). userId is taken from
 * the verified payload; refreshed bearer is scoped to the same user
 * with the default 5-min TTL.
 *
 * Threat model: helper bearer leak ⇒ attacker can refresh short bearers
 * indefinitely while the long token's TTL remains. Cost is still
 * gated by per-user quota in the forward path ( D3);
 * D6 trust model accepts this (alt-account-only shared container).
 */
export function registerBearerRefreshRoute(
  app: FastifyInstance,
  deps: BearerRefreshDeps,
): void {
  app.post('/ccanywhere/bearer-refresh', async (req, reply) => {
    const auth = req.headers.authorization;
    if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) {
      await reply
        .code(401)
        .send({ error: { code: 'unauthorized', message: 'missing bearer' } });
      return;
    }
    const presented = auth.slice('Bearer '.length).trim();
    const verified = deps.tokenIssuer.verify(presented);
    if (verified === null) {
      await reply.code(401).send({
        error: { code: 'unauthorized', message: 'invalid or expired bearer' },
      });
      return;
    }
    const fresh = deps.tokenIssuer.issue(verified.userId);
    await reply.code(200).send({
      token: fresh.token,
      expiresAt: fresh.expiresAt,
    });
  });
}
