import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../config/schema.js';
import { DeviceStore } from '../devices/store.js';
import { ProjectStore } from '../projects/store.js';
import { SessionManager } from '../session/manager.js';
import { encodeProjectCwd } from './history.js';
import { buildServer } from './server.js';

const internalHookToken = 'h'.repeat(32);
const cliToken = 'c'.repeat(32);

interface TestProjectsEnv {
  projectsRoot: string;
  projectStore: ProjectStore;
  deviceStore: DeviceStore;
  demoCwd: string;
  /** Cookie header value pre-formatted for `headers.cookie`. */
  authCookie: string;
  /** sessionId extracted from authCookie. */
  sessionId: string;
  cleanup: () => void;
}

function setupProjects(): TestProjectsEnv {
  const projectsRoot = mkdtempSync(join(tmpdir(), 'ccanywhere-projects-'));
  mkdirSync(join(projectsRoot, 'demo'));
  const statePath = join(projectsRoot, '.projects-state.json');
  const projectStore = new ProjectStore({ projectsRoot, statePath });
  const deviceStore = new DeviceStore({
    statePath: join(projectsRoot, '.devices.json'),
  });
  const { sessionId } = deviceStore.__seedActiveDevice('test-device');
  return {
    projectsRoot,
    projectStore,
    deviceStore,
    demoCwd: join(projectsRoot, 'demo'),
    authCookie: `ccanywhere_session=${sessionId}`,
    sessionId,
    cleanup: () => rmSync(projectsRoot, { recursive: true, force: true }),
  };
}

const baseConfig: Config = {
  port: 7878,
  bindHost: '127.0.0.1',
  claudeBin: 'sh',
  scrollbackBytes: 4096,
  deletedSessionTtlMs: 600_000,
  wsHeartbeat: { intervalMs: 30_000, timeoutMs: 60_000 },
  outputFps: 60,
  // Placeholder: each describe block creates a real tmp dir + ProjectStore;
  // buildServer reads from projectStore, not config.projectsRoot.
  projectsRoot: '/tmp/ccanywhere-test-placeholder',
  webOrigin: 'http://localhost:7878',
};

describe('REST API', () => {
  let mgr: SessionManager;
  let app: FastifyInstance;
  let env: TestProjectsEnv;

  beforeEach(async () => {
    env = setupProjects();
    mgr = new SessionManager();
    app = await buildServer({
      config: baseConfig,
      manager: mgr,
      projectStore: env.projectStore,
      deviceStore: env.deviceStore,
      internalHookToken,
      cliToken,
      webDistDir: null,
    });
  });

  afterEach(async () => {
    await mgr.killAll();
    await app.close();
    env.cleanup();
  });

  it('healthz is public', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('rejects requests without a session cookie', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects requests with an invalid session cookie', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { cookie: 'ccanywhere_session=notavalidsession' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('lists projects with a valid session cookie', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { cookie: env.authCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { projects: Array<{ id: string; name: string; cwd: string }> };
    expect(body.projects).toHaveLength(1);
    expect(body.projects[0]?.id).toBe('demo');
  });

  it('history endpoint returns array even when no on-disk history', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects/demo/history',
      headers: { cookie: env.authCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { history: unknown[] };
    expect(Array.isArray(body.history)).toBe(true);
  });

  it('history endpoint 404s for unknown project', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects/nope/history',
      headers: { cookie: env.authCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /api/projects creates a new subdir under projectsRoot', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie: env.authCookie, 'content-type': 'application/json' },
      payload: { name: 'fresh' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; name: string; cwd: string };
    expect(body.id).toBe('fresh');
    expect(body.cwd).toBe(join(env.projectsRoot, 'fresh'));

    const list = await app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { cookie: env.authCookie },
    });
    const ids = (list.json() as { projects: Array<{ id: string }> }).projects.map(
      (p) => p.id,
    );
    expect(ids).toContain('fresh');
  });

  it('POST /api/projects 400 on invalid body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie: env.authCookie, 'content-type': 'application/json' },
      payload: { name: '' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/projects 400 on path traversal attempt', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie: env.authCookie, 'content-type': 'application/json' },
      payload: { name: '../escape' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/projects 409 when name already exists', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie: env.authCookie, 'content-type': 'application/json' },
      payload: { name: 'demo' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('DELETE /api/projects/:id hides the project (does not delete on disk)', async () => {
    const del = await app.inject({
      method: 'DELETE',
      url: '/api/projects/demo',
      headers: { cookie: env.authCookie },
    });
    expect(del.statusCode).toBe(204);

    const list = await app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { cookie: env.authCookie },
    });
    const ids = (list.json() as { projects: Array<{ id: string }> }).projects.map(
      (p) => p.id,
    );
    expect(ids).not.toContain('demo');
  });

  it('DELETE /api/projects/:id 404 for unknown id', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/projects/ghost',
      headers: { cookie: env.authCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('creates a fresh session, lists it, and deletes it', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: env.authCookie, 'content-type': 'application/json' },
      payload: { projectId: 'demo', mode: 'fresh' },
    });
    expect(create.statusCode).toBe(201);
    const session = create.json() as { id: string; mode: string; state: string };
    expect(session.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(session.mode).toBe('fresh');

    const list = await app.inject({
      method: 'GET',
      url: '/api/sessions',
      headers: { cookie: env.authCookie },
    });
    const listBody = list.json() as { sessions: Array<{ id: string }> };
    expect(listBody.sessions).toHaveLength(1);
    expect(listBody.sessions[0]?.id).toBe(session.id);

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/sessions/${session.id}`,
      headers: { cookie: env.authCookie },
    });
    expect(del.statusCode).toBe(204);
  });

  it('rejects invalid create body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: env.authCookie, 'content-type': 'application/json' },
      payload: { projectId: 'demo', mode: 'resume' /* missing sessionId */ },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects unknown projectId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: env.authCookie, 'content-type': 'application/json' },
      payload: { projectId: 'ghost', mode: 'fresh' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('delete returns 404 for unknown session', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/sessions/00000000-0000-0000-0000-000000000000',
      headers: { cookie: env.authCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('hook endpoint rejects user token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/hook/abc/Stop',
      headers: { cookie: env.authCookie },
    });
    expect(res.statusCode).toBe(401);
  });

  it('hook endpoint with internal token returns 404 for unknown session', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/hook/missing-session-id/Stop',
      headers: { Authorization: `Bearer ${internalHookToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('hook endpoint rejects unknown event names', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: env.authCookie, 'content-type': 'application/json' },
      payload: { projectId: 'demo', mode: 'fresh' },
    });
    const sid = (create.json() as { id: string }).id;

    const res = await app.inject({
      method: 'POST',
      url: `/api/hook/${sid}/MadeUpEvent`,
      headers: { Authorization: `Bearer ${internalHookToken}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('hook endpoint accepts valid Stop for live session', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: env.authCookie, 'content-type': 'application/json' },
      payload: { projectId: 'demo', mode: 'fresh' },
    });
    const sid = (create.json() as { id: string }).id;

    const res = await app.inject({
      method: 'POST',
      url: `/api/hook/${sid}/Stop`,
      headers: { Authorization: `Bearer ${internalHookToken}` },
    });
    expect(res.statusCode).toBe(204);
  });

  it('hook events drive the session state machine', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: env.authCookie, 'content-type': 'application/json' },
      payload: { projectId: 'demo', mode: 'fresh' },
    });
    const sid = (create.json() as { id: string }).id;
    const session = mgr.get(sid);
    expect(session?.state).toBe('idle');

    await app.inject({
      method: 'POST',
      url: `/api/hook/${sid}/PreToolUse`,
      headers: { Authorization: `Bearer ${internalHookToken}` },
    });
    expect(mgr.get(sid)?.state).toBe('busy');

    await app.inject({
      method: 'POST',
      url: `/api/hook/${sid}/Stop`,
      headers: { Authorization: `Bearer ${internalHookToken}` },
    });
    expect(mgr.get(sid)?.state).toBe('idle');

    await app.inject({
      method: 'POST',
      url: `/api/hook/${sid}/UserPromptSubmit`,
      headers: { Authorization: `Bearer ${internalHookToken}` },
    });
    expect(mgr.get(sid)?.state).toBe('busy');

    await app.inject({
      method: 'POST',
      url: `/api/hook/${sid}/Notification`,
      headers: { Authorization: `Bearer ${internalHookToken}` },
    });
    // Notification does not flip state.
    expect(mgr.get(sid)?.state).toBe('busy');
  });

  it('DELETE marks the session as deletedAt and is idempotent', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: env.authCookie, 'content-type': 'application/json' },
      payload: { projectId: 'demo', mode: 'fresh' },
    });
    const sid = (create.json() as { id: string }).id;

    const del1 = await app.inject({
      method: 'DELETE',
      url: `/api/sessions/${sid}`,
      headers: { cookie: env.authCookie },
    });
    expect(del1.statusCode).toBe(204);

    const list = await app.inject({
      method: 'GET',
      url: '/api/sessions',
      headers: { cookie: env.authCookie },
    });
    const sessions = (list.json() as { sessions: Array<{ id: string; deletedAt: number | null }> })
      .sessions;
    const found = sessions.find((s) => s.id === sid);
    expect(found).toBeDefined();
    expect(found?.deletedAt).toBeGreaterThan(0);

    // Second DELETE on the same id is a no-op (no 404, idempotent).
    const del2 = await app.inject({
      method: 'DELETE',
      url: `/api/sessions/${sid}`,
      headers: { cookie: env.authCookie },
    });
    expect(del2.statusCode).toBe(204);

    // Genuine miss (id never existed) still 404.
    const del3 = await app.inject({
      method: 'DELETE',
      url: '/api/sessions/00000000-0000-0000-0000-000000000000',
      headers: { cookie: env.authCookie },
    });
    expect(del3.statusCode).toBe(404);
  });
});

describe('REST API with historyRoot for resume validation', () => {
  let mgr: SessionManager;
  let app: FastifyInstance;
  let historyRoot: string;
  let env: TestProjectsEnv;

  beforeEach(async () => {
    env = setupProjects();
    historyRoot = mkdtempSync(join(tmpdir(), 'ccanywhere-srv-hist-'));
    const projDir = join(historyRoot, encodeProjectCwd(env.demoCwd));
    mkdirSync(projDir, { recursive: true });
    writeFileSync(
      join(projDir, 'known-session.jsonl'),
      JSON.stringify({ type: 'user', message: { content: 'old' } }) + '\n',
    );

    mgr = new SessionManager();
    app = await buildServer({
      config: baseConfig,
      manager: mgr,
      projectStore: env.projectStore,
      deviceStore: env.deviceStore,
      internalHookToken,
      cliToken,
      historyRoot,
      webDistDir: null,
    });
  });

  afterEach(async () => {
    await mgr.killAll();
    await app.close();
    rmSync(historyRoot, { recursive: true, force: true });
    env.cleanup();
  });

  it('accepts resume when sessionId exists in history', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: env.authCookie, 'content-type': 'application/json' },
      payload: { projectId: 'demo', mode: 'resume', sessionId: 'known-session' },
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { mode: string }).mode).toBe('resume');
  });

  it('rejects resume when sessionId is not in history (boundary)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: env.authCookie, 'content-type': 'application/json' },
      payload: { projectId: 'demo', mode: 'resume', sessionId: 'never-was' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('invalid_resume');
  });
});

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
      internalHookToken,
      cliToken,
      idempotencyTtlMs: 60_000,
      webDistDir: null,
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
    const a = await post(env.authCookie, null, { projectId: 'demo', mode: 'fresh' });
    const b = await post(env.authCookie, null, { projectId: 'demo', mode: 'fresh' });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect((a.json() as { id: string }).id).not.toBe((b.json() as { id: string }).id);
  });

  it('rejects malformed Idempotency-Key', async () => {
    const res = await post(env.authCookie, 'has space', { projectId: 'demo', mode: 'fresh' });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('invalid_idempotency_key');
  });

  it('replays cached response for same key + body', async () => {
    const a = await post(env.authCookie, 'KEY-1', { projectId: 'demo', mode: 'fresh' });
    expect(a.statusCode).toBe(201);
    expect(a.headers['idempotency-stored']).toBe('true');
    const idA = (a.json() as { id: string }).id;

    const b = await post(env.authCookie, 'KEY-1', { projectId: 'demo', mode: 'fresh' });
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
    await post(env.authCookie, 'KEY-2', { projectId: 'demo', mode: 'fresh' });
    const conflict = await post(env.authCookie, 'KEY-2', {
      projectId: 'demo',
      mode: 'fresh',
      cols: 200,
    });
    expect(conflict.statusCode).toBe(409);
    expect((conflict.json() as { error: { code: string } }).error.code).toBe(
      'idempotency_conflict',
    );
  });

  it('isolates idempotency-key namespace per device', async () => {
    const a = await post(env.authCookie, 'SHARED', { projectId: 'demo', mode: 'fresh' });
    const b = await post(otherCookie, 'SHARED', { projectId: 'demo', mode: 'fresh' });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect((a.json() as { id: string }).id).not.toBe((b.json() as { id: string }).id);
  });

  it('caches 4xx errors so retried bad requests are stable', async () => {
    const a = await post(env.authCookie, 'BAD-1', { projectId: 'ghost', mode: 'fresh' });
    const b = await post(env.authCookie, 'BAD-1', { projectId: 'ghost', mode: 'fresh' });
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

describe('REST API SPA fallback', () => {
  let mgr: SessionManager;
  let app: FastifyInstance;
  let webDistDir: string;
  let env: TestProjectsEnv;

  beforeEach(async () => {
    env = setupProjects();
    webDistDir = mkdtempSync(join(tmpdir(), 'ccanywhere-web-'));
    writeFileSync(
      join(webDistDir, 'index.html'),
      '<!doctype html><html><body data-test="spa">spa-marker</body></html>',
    );
    mgr = new SessionManager();
    app = await buildServer({
      config: baseConfig,
      manager: mgr,
      projectStore: env.projectStore,
      deviceStore: env.deviceStore,
      internalHookToken,
      cliToken,
      webDistDir,
    });
  });

  afterEach(async () => {
    await mgr.killAll();
    await app.close();
    rmSync(webDistDir, { recursive: true, force: true });
    env.cleanup();
  });

  it('GET / serves index.html when web/dist exists', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('spa-marker');
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });

  it('unknown SPA path falls back to index.html', async () => {
    const res = await app.inject({ method: 'GET', url: '/workspace/abc-123' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('spa-marker');
  });

  it('does not affect /api/* priority', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { cookie: env.authCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('healthz still returns JSON', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});

describe('REST API without web/dist', () => {
  let mgr: SessionManager;
  let app: FastifyInstance;
  let env: TestProjectsEnv;

  beforeEach(async () => {
    env = setupProjects();
    mgr = new SessionManager();
    app = await buildServer({
      config: baseConfig,
      manager: mgr,
      projectStore: env.projectStore,
      deviceStore: env.deviceStore,
      internalHookToken,
      cliToken,
      webDistDir: null,
    });
  });

  afterEach(async () => {
    await mgr.killAll();
    await app.close();
    env.cleanup();
  });

  it('unknown route still returns envelope when SPA disabled', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/somewhere',
      headers: { cookie: env.authCookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'not_found' } });
  });
});
