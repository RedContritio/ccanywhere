import { join } from 'node:path';
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

const internalHookToken = INTERNAL_HOOK_TOKEN;
const cliToken = CLI_TOKEN;

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
      injectCcSessionId: false,
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

  it('honors config.cookieName override (multi-instance same-domain isolation)', async () => {
    const customApp = await buildServer({
      config: { ...baseConfig, cookieName: 'ccanywhere_session_e2e' },
      manager: new SessionManager(),
      projectStore: env.projectStore,
      deviceStore: env.deviceStore,
      internalHookToken,
      cliToken,
      webDistDir: null,
      injectCcSessionId: false,
    });
    try {
      // Default cookie name no longer authenticates against this server.
      const wrong = await customApp.inject({
        method: 'GET',
        url: '/api/projects',
        headers: { cookie: env.authCookie }, // 'ccanywhere_session=<id>'
      });
      expect(wrong.statusCode).toBe(401);

      // Custom cookie name with the same sessionId does authenticate.
      const right = await customApp.inject({
        method: 'GET',
        url: '/api/projects',
        headers: { cookie: `ccanywhere_session_e2e=${env.sessionId}` },
      });
      expect(right.statusCode).toBe(200);
    } finally {
      await customApp.close();
    }
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
    expect(body.cwd).toBe(join(env.ownerProjectsRoot, 'fresh'));

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
      payload: { projectId: 'demo', mode: 'create' },
    });
    expect(create.statusCode).toBe(201);
    const session = create.json() as { id: string; mode: string; state: string };
    expect(session.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(session.mode).toBe('create');

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
      payload: { projectId: 'ghost', mode: 'create' },
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
      payload: { projectId: 'demo', mode: 'create' },
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
      payload: { projectId: 'demo', mode: 'create' },
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
      payload: { projectId: 'demo', mode: 'create' },
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
      payload: { projectId: 'demo', mode: 'create' },
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

describe('healthz isolation field', () => {
  let env: TestProjectsEnv;

  beforeEach(() => {
    env = setupProjects();
  });

  afterEach(() => {
    env.cleanup();
  });

  it('omits isolation field when buildServer opt not provided', async () => {
    const mgr = new SessionManager();
    const app = await buildServer({
      config: baseConfig,
      manager: mgr,
      projectStore: env.projectStore,
      deviceStore: env.deviceStore,
      internalHookToken,
      cliToken,
      webDistDir: null,
      injectCcSessionId: false,
    });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.json()).toEqual({ ok: true });
    await mgr.killAll();
    await app.close();
  });

  it('exposes isolation in healthz when provided (strict ready)', async () => {
    const mgr = new SessionManager();
    const app = await buildServer({
      config: baseConfig,
      manager: mgr,
      projectStore: env.projectStore,
      deviceStore: env.deviceStore,
      internalHookToken,
      cliToken,
      webDistDir: null,
      injectCcSessionId: false,
      isolation: { mode: 'strict', ready: true },
    });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.json()).toEqual({
      ok: true,
      isolation: { mode: 'strict', ready: true },
    });
    await mgr.killAll();
    await app.close();
  });

  it('exposes host-only mode in healthz', async () => {
    const mgr = new SessionManager();
    const app = await buildServer({
      config: baseConfig,
      manager: mgr,
      projectStore: env.projectStore,
      deviceStore: env.deviceStore,
      internalHookToken,
      cliToken,
      webDistDir: null,
      injectCcSessionId: false,
      isolation: { mode: 'host-only', ready: true },
    });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.json()).toEqual({
      ok: true,
      isolation: { mode: 'host-only', ready: true },
    });
    await mgr.killAll();
    await app.close();
  });
});
