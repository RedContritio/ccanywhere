import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
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

describe('REST API idempotency', () => {
  let mgr: SessionManager;
  let app: FastifyInstance;
  let env: TestProjectsEnv;

  /** Second device used to exercise per-device idempotency scoping. */
  let otherCookie: string;

  beforeEach(async () => {
    env = setupProjects();
    const seeded = env.deviceStore.__seedActiveDevice('other-device');
    otherCookie = `ccanywhere_session=${seeded.sessionId}`;
    mgr = new SessionManager();
    app = await buildServer({
      config: baseConfig,
      manager: mgr,
      projectStore: env.projectStore,
      deviceStore: env.deviceStore,
      internalHookToken: INTERNAL_HOOK_TOKEN,
      cliToken: CLI_TOKEN,
      idempotencyTtlMs: 60_000,
      webDistDir: null,
      injectCcSessionId: false,
    });
  });

  afterEach(async () => {
    await mgr.killAll();
    await app.close();
    env.cleanup();
  });

  async function post(
    cookie: string,
    key: string | null,
    payload: object,
  ): Promise<LightMyRequestResponse> {
    const headers: Record<string, string> = {
      cookie,
      'content-type': 'application/json',
    };
    if (key !== null) headers['idempotency-key'] = key;
    return await app.inject({ method: 'POST', url: '/api/sessions', headers, payload });
  }

  it('without Idempotency-Key behaves like before', async () => {
    const a = await post(env.authCookie, null, { projectId: 'demo', mode: 'create' });
    const b = await post(env.authCookie, null, { projectId: 'demo', mode: 'create' });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect((a.json() as { id: string }).id).not.toBe((b.json() as { id: string }).id);
  });

  it('rejects malformed Idempotency-Key', async () => {
    const res = await post(env.authCookie, 'has space', { projectId: 'demo', mode: 'create' });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('invalid_idempotency_key');
  });

  it('replays cached response for same key + body', async () => {
    const a = await post(env.authCookie, 'KEY-1', { projectId: 'demo', mode: 'create' });
    expect(a.statusCode).toBe(201);
    expect(a.headers['idempotency-stored']).toBe('true');
    const idA = (a.json() as { id: string }).id;

    const b = await post(env.authCookie, 'KEY-1', { projectId: 'demo', mode: 'create' });
    expect(b.statusCode).toBe(201);
    expect(b.headers['idempotency-replayed']).toBe('true');
    expect((b.json() as { id: string }).id).toBe(idA);

    // Only ONE actual session was spawned.
    const list = await app.inject({
      method: 'GET',
      url: '/api/sessions',
      headers: { cookie: env.authCookie },
    });
    expect((list.json() as { sessions: unknown[] }).sessions).toHaveLength(1);
  });

  it('returns 409 on same key with different body', async () => {
    await post(env.authCookie, 'KEY-2', { projectId: 'demo', mode: 'create' });
    const conflict = await post(env.authCookie, 'KEY-2', {
      projectId: 'demo',
      mode: 'create',
      cols: 200,
    });
    expect(conflict.statusCode).toBe(409);
    expect((conflict.json() as { error: { code: string } }).error.code).toBe(
      'idempotency_conflict',
    );
  });

  it('isolates idempotency-key namespace per device', async () => {
    const a = await post(env.authCookie, 'SHARED', { projectId: 'demo', mode: 'create' });
    const b = await post(otherCookie, 'SHARED', { projectId: 'demo', mode: 'create' });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect((a.json() as { id: string }).id).not.toBe((b.json() as { id: string }).id);
  });

  it('caches 4xx errors so retried bad requests are stable', async () => {
    const a = await post(env.authCookie, 'BAD-1', { projectId: 'ghost', mode: 'create' });
    const b = await post(env.authCookie, 'BAD-1', { projectId: 'ghost', mode: 'create' });
    expect(a.statusCode).toBe(404);
    expect(b.statusCode).toBe(404);
    expect(b.headers['idempotency-replayed']).toBe('true');
  });

  it('404 for unknown route returns standard error envelope', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/nope',
      headers: { cookie: env.authCookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: { code: 'not_found', message: 'route not found' },
    });
  });
});
