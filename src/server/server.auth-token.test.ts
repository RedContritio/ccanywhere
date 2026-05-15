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
 * Integration tests for token-based user login (#44 m-multi-user).
 *
 * Covers:
 *   POST /api/auth/token  — happy path / wrong token / revoked / short body
 *   GET  /api/me/quota    — owner null limits / user returns quota / no cookie 401
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
        workspace: env.workspace,
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
    const { user, plaintext } = env.createUserWithToken('alice');

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
    expect(body.user.kind).toBe('user');

    const setCookie = res.headers['set-cookie'];
    const cookieHeader = Array.isArray(setCookie) ? setCookie.join('; ') : setCookie ?? '';
    expect(cookieHeader).toContain(`ccanywhere_session=${plaintext}`);
    expect(cookieHeader).toContain('HttpOnly');

    // touchLogin side effect: lastLoginAt updated from null
    const refreshed = env.userStore.findById(user.id);
    expect(refreshed?.lastLoginAt).not.toBeNull();
  });

  it('POST /api/auth/token wrong token → 401', async () => {
    env.createUserWithToken('alice');
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/token',
      headers: { 'content-type': 'application/json' },
      payload: { token: 'a'.repeat(64) }, // valid length, not a real token
    });
    expect(res.statusCode).toBe(401);
  });

  it('POST /api/auth/token revoked token → 401', async () => {
    const { token, plaintext } = env.createUserWithToken('alice');
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

  it('GET /api/me/quota with user cookie → 200 + quota object', async () => {
    const { authCookie } = env.createUserWithToken('alice', {
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
    expect(body.kind).toBe('user');
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

  it('GET /api/auth/me with user cookie → 200 + kind=user', async () => {
    const { user, authCookie } = env.createUserWithToken('alice');
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: authCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      id: string;
      label: string;
      kind: string;
      lastUsedAt: number | null;
    };
    expect(body.kind).toBe('user');
    expect(body.id).toBe(user.id);
    expect(body.label).toBe('alice');
  });

  it('GET /api/auth/me with owner cookie → 200 + kind=owner; label=owner.username', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: env.authCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { kind: string; label: string };
    expect(body.kind).toBe('owner');
    // /me now surfaces the user identity, not the device label.
    expect(body.label).toBe('owner');
  });

  it('GET /api/auth/me without cookie → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(res.statusCode).toBe(401);
  });

  it('GET /api/me/preferences with user cookie → 200 + empty by default', async () => {
    const { authCookie } = env.createUserWithToken('alice');
    const res = await app.inject({
      method: 'GET',
      url: '/api/me/preferences',
      headers: { cookie: authCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({});
  });

  it('PUT /api/me/preferences round-trips a toolbar layout', async () => {
    const { authCookie } = env.createUserWithToken('alice');
    const layout = {
      rows: 1,
      cols: 3,
      cells: [
        { id: 'esc', label: 'Esc', action: 'plain', payload: '' },
        null,
        { id: 'c', label: '^C', action: 'ctrl-letter', payload: 'c' },
      ],
    };
    const put = await app.inject({
      method: 'PUT',
      url: '/api/me/preferences',
      headers: { cookie: authCookie, 'content-type': 'application/json' },
      payload: { toolbar: layout },
    });
    expect(put.statusCode).toBe(200);

    const get = await app.inject({
      method: 'GET',
      url: '/api/me/preferences',
      headers: { cookie: authCookie },
    });
    const body = get.json() as { toolbar?: typeof layout };
    expect(body.toolbar).toEqual(layout);
  });

  it('PUT /api/me/preferences { toolbar: null } clears the override', async () => {
    const { authCookie } = env.createUserWithToken('alice');
    await app.inject({
      method: 'PUT',
      url: '/api/me/preferences',
      headers: { cookie: authCookie, 'content-type': 'application/json' },
      payload: {
        toolbar: { rows: 1, cols: 3, cells: [null, null, null] },
      },
    });
    const clear = await app.inject({
      method: 'PUT',
      url: '/api/me/preferences',
      headers: { cookie: authCookie, 'content-type': 'application/json' },
      payload: { toolbar: null },
    });
    expect(clear.statusCode).toBe(200);
    expect(clear.json()).toEqual({});
  });

  it('PUT /api/me/preferences invalid rows → 400', async () => {
    const { authCookie } = env.createUserWithToken('alice');
    const res = await app.inject({
      method: 'PUT',
      url: '/api/me/preferences',
      headers: { cookie: authCookie, 'content-type': 'application/json' },
      payload: { toolbar: { rows: 9, cols: 3, cells: [] } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('PUT /api/me/preferences ctrl-letter payload must be a..z → 400', async () => {
    const { authCookie } = env.createUserWithToken('alice');
    const res = await app.inject({
      method: 'PUT',
      url: '/api/me/preferences',
      headers: { cookie: authCookie, 'content-type': 'application/json' },
      payload: {
        toolbar: {
          rows: 1,
          cols: 3,
          cells: [
            null,
            null,
            { id: 'bad', label: 'X', action: 'ctrl-letter', payload: 'CC' },
          ],
        },
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET /api/me/active-session → 200 + null by default', async () => {
    const { authCookie } = env.createUserWithToken('alice');
    const res = await app.inject({
      method: 'GET',
      url: '/api/me/active-session',
      headers: { cookie: authCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sessionId: null });
  });

  it('PUT /api/me/active-session round-trips id and clears with null', async () => {
    const { authCookie } = env.createUserWithToken('alice');
    const sid = '11111111-2222-3333-4444-555555555555';
    const put = await app.inject({
      method: 'PUT',
      url: '/api/me/active-session',
      headers: { cookie: authCookie, 'content-type': 'application/json' },
      payload: { sessionId: sid },
    });
    expect(put.statusCode).toBe(200);

    const get = await app.inject({
      method: 'GET',
      url: '/api/me/active-session',
      headers: { cookie: authCookie },
    });
    expect(get.json()).toEqual({ sessionId: sid });

    const clear = await app.inject({
      method: 'PUT',
      url: '/api/me/active-session',
      headers: { cookie: authCookie, 'content-type': 'application/json' },
      payload: { sessionId: null },
    });
    expect(clear.json()).toEqual({ sessionId: null });
  });

  it('owner can also set preferences + active-session', async () => {
    // owner uses the test-helpers device session cookie
    const layout = {
      rows: 1,
      cols: 3,
      cells: [
        { id: 'up', label: 'Up', action: 'plain', payload: '[A' },
        null,
        null,
      ],
    };
    const put = await app.inject({
      method: 'PUT',
      url: '/api/me/preferences',
      headers: { cookie: env.authCookie, 'content-type': 'application/json' },
      payload: { toolbar: layout },
    });
    expect(put.statusCode).toBe(200);

    const get = await app.inject({
      method: 'GET',
      url: '/api/me/preferences',
      headers: { cookie: env.authCookie },
    });
    expect((get.json() as { toolbar?: object }).toolbar).toEqual(layout);
  });
});
