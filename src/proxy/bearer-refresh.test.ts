import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TokenIssuer } from './tokens.js';
import { registerBearerRefreshRoute } from './bearer-refresh.js';
import Fastify from 'fastify';

function mkApp(issuer: TokenIssuer) {
  const app = Fastify({ logger: false });
  registerBearerRefreshRoute(app, { tokenIssuer: issuer });
  return app;
}

describe('POST /ccanywhere/bearer-refresh', () => {
  it('issues fresh short-TTL bearer when caller presents valid helper-token', async () => {
    const issuer = new TokenIssuer({ secret: randomBytes(32) });
    // helper-token: long-lived (24h) bearer scoped to a user
    const helper = issuer.issue('user-alice', 24 * 60 * 60 * 1000);
    const app = mkApp(issuer);

    const r = await app.inject({
      method: 'POST',
      url: '/ccanywhere/bearer-refresh',
      headers: { authorization: `Bearer ${helper.token}` },
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body) as { token: string; expiresAt: number };
    expect(body.token).toMatch(/^cca\./);
    // freshly issued bearer should expire ~5min later, well before helper
    expect(body.expiresAt).toBeLessThan(helper.expiresAt);
    expect(body.expiresAt).toBeGreaterThan(Date.now());
    // refreshed bearer is for the same user
    const v = issuer.verify(body.token);
    expect(v?.userId).toBe('user-alice');
  });

  it('rejects unauthenticated requests with 401', async () => {
    const issuer = new TokenIssuer({ secret: randomBytes(32) });
    const app = mkApp(issuer);

    const r = await app.inject({
      method: 'POST',
      url: '/ccanywhere/bearer-refresh',
    });
    expect(r.statusCode).toBe(401);
  });

  it('rejects malformed bearer with 401 (no info leak)', async () => {
    const issuer = new TokenIssuer({ secret: randomBytes(32) });
    const app = mkApp(issuer);

    const r = await app.inject({
      method: 'POST',
      url: '/ccanywhere/bearer-refresh',
      headers: { authorization: 'Bearer not.a.real.token' },
    });
    expect(r.statusCode).toBe(401);
  });

  it('rejects expired bearer with 401', async () => {
    const issuer = new TokenIssuer({ secret: randomBytes(32) });
    const expired = issuer.issue('user-alice', -1000); // expired 1s ago
    const app = mkApp(issuer);

    const r = await app.inject({
      method: 'POST',
      url: '/ccanywhere/bearer-refresh',
      headers: { authorization: `Bearer ${expired.token}` },
    });
    expect(r.statusCode).toBe(401);
  });
});
