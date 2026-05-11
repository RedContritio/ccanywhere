import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionManager } from '../session/manager.js';
import { buildServer } from './server.js';
import {
  baseConfig,
  CLI_TOKEN,
  INTERNAL_HOOK_TOKEN,
  setupProjects,
  type TestProjectsEnv,
} from './server.test-helpers.js';

/**
 * Integration tests for token-based limited-user login (#44 m-multi-user).
 *
 * Covers:
 *   POST /api/auth/token  — happy path / wrong token / revoked / short body
 *   GET  /api/me/quota    — owner null limits / limited returns quota / no cookie 401
 *
 * Builds the server with userStore + tokenStore wired so hookEarlyAuth
 * exercises the token-session path (cookie value === token plaintext).
 */
describe('REST API: /api/auth/token + /api/me/quota (multi-user)', () => {
  let mgr: SessionManager;
  let app: FastifyInstance;
  let env: TestProjectsEnv;

  beforeEach(async () => {
    env = setupProjects();
    mgr = new SessionManager();
    app = await buildServer({
      config: {
        ...baseConfig,
        projectsRoot: env.projectsRoot,
        guestProjectsRoot: env.guestProjectsRoot,
      },
      manager: mgr,
      projectStore: env.projectStore,
      deviceStore: env.deviceStore,
      userStore: env.userStore,
      tokenStore: env.tokenStore,
      internalHookToken: INTERNAL_HOOK_TOKEN,
      cliToken: CLI_TOKEN,
      webDistDir: null,
      injectCcSessionId: false,
    });
  });

  afterEach(async () => {
    await mgr.killAll();
    await app.close();
    env.cleanup();
  });

  it('POST /api/auth/token → 200 + Set-Cookie + user info', async () => {
    const { user, plaintext } = env.createLimitedUserWithToken('alice');

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/token',
      headers: { 'content-type': 'application/json' },
      payload: { token: plaintext },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; user: { username: string; kind: string } };
    expect(body.ok).toBe(true);
    expect(body.user.username).toBe('alice');
    expect(body.user.kind).toBe('limited');

    const setCookie = res.headers['set-cookie'];
    const cookieHeader = Array.isArray(setCookie) ? setCookie.join('; ') : setCookie ?? '';
    expect(cookieHeader).toContain(`ccanywhere_session=${plaintext}`);
    expect(cookieHeader).toContain('HttpOnly');

    // touchLogin side effect: lastLoginAt updated from null
    const refreshed = env.userStore.findById(user.id);
    expect(refreshed?.lastLoginAt).not.toBeNull();
  });

  it('POST /api/auth/token wrong token → 401', async () => {
    env.createLimitedUserWithToken('alice');
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/token',
      headers: { 'content-type': 'application/json' },
      payload: { token: 'a'.repeat(64) }, // valid length, not a real token
    });
    expect(res.statusCode).toBe(401);
  });

  it('POST /api/auth/token revoked token → 401', async () => {
    const { token, plaintext } = env.createLimitedUserWithToken('alice');
    env.tokenStore.revoke(token.id);

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/token',
      headers: { 'content-type': 'application/json' },
      payload: { token: plaintext },
    });
    expect(res.statusCode).toBe(401);
  });

  it('POST /api/auth/token body validation (token < 32) → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/token',
      headers: { 'content-type': 'application/json' },
      payload: { token: 'too-short' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET /api/me/quota with limited cookie → 200 + quota object', async () => {
    const { authCookie } = env.createLimitedUserWithToken('alice', {
      costLimitUsd: 5,
      tokensLimit: 100_000,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/me/quota',
      headers: { cookie: authCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      kind: string;
      cost: { limitUsd: number | null; usedUsd: number };
      tokens: { limit: number | null; used: number };
    };
    expect(body.kind).toBe('limited');
    expect(body.cost.limitUsd).toBe(5);
    expect(body.cost.usedUsd).toBe(0);
    expect(body.tokens.limit).toBe(100_000);
    expect(body.tokens.used).toBe(0);
  });

  it('GET /api/me/quota with owner cookie → 200 + null limits', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/me/quota',
      headers: { cookie: env.authCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      kind: string;
      cost: { limitUsd: number | null };
      tokens: { limit: number | null };
    };
    expect(body.kind).toBe('owner');
    expect(body.cost.limitUsd).toBeNull();
    expect(body.tokens.limit).toBeNull();
  });

  it('GET /api/me/quota without cookie → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/me/quota' });
    expect(res.statusCode).toBe(401);
  });
});
