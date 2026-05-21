import { existsSync, mkdirSync, statSync } from 'node:fs';
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

/**
 * Integration tests for cross-user isolation on the REST surface
 * (#44 + ). Covers cwd guard,
 * GET filter, DELETE 404 mask, and per-user ProjectStore resolution
 * (limited user sees only `<guestProjectsRoot>/<username>/`).
 */
describe('REST API: cross-user isolation (multi-user)', () => {
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

  it('POST /api/sessions as limited user with owner project → 403', async () => {
    const { authCookie } = env.createUserWithToken('alice');

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: authCookie, 'content-type': 'application/json' },
      payload: { projectId: 'demo', mode: 'create' },
    });

    // store isolation masks cwd guard. alice's store
    // doesn't contain owner's 'demo' → 404 not_found before cwd check fires.
    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });

  it('GET /api/sessions filters by user.id', async () => {
    const { user: alice, authCookie: aliceCookie } =
      env.createUserWithToken('alice');

    // Owner session via HTTP (real PTY in demo cwd).
    const ownerCreate = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: env.authCookie, 'content-type': 'application/json' },
      payload: { projectId: 'demo', mode: 'create' },
    });
    expect(ownerCreate.statusCode).toBe(201);
    const ownerSid = (ownerCreate.json() as { id: string }).id;

    // Alice session injected directly through manager (cwd inside her
    // guest root, no HTTP gate). createLimitedUser already mkdir'd
    // <guestProjectsRoot>/alice/ — make a project subdir to use as cwd.
    const aliceProjectDir = join(env.workspace, alice.username, 'p1');
    mkdirSync(aliceProjectDir);
    const spawn = mgr.spawn({
      projectId: 'alice-p1',
      cwd: aliceProjectDir,
      command: 'sh',
      args: [],
      scrollbackBytes: 4096,
      mode: 'create',
      userId: alice.id,
    });
    if (spawn.kind !== 'created') throw new Error('expected created');
    const aliceSid = spawn.session.info.id;

    // Owner GET → only owner's session
    const ownerList = await app.inject({
      method: 'GET',
      url: '/api/sessions',
      headers: { cookie: env.authCookie },
    });
    const ownerSessions = (ownerList.json() as { sessions: Array<{ id: string }> }).sessions;
    expect(ownerSessions.map((s) => s.id)).toEqual([ownerSid]);

    // Alice GET → only alice's session
    const aliceList = await app.inject({
      method: 'GET',
      url: '/api/sessions',
      headers: { cookie: aliceCookie },
    });
    const aliceSessions = (aliceList.json() as { sessions: Array<{ id: string }> }).sessions;
    expect(aliceSessions.map((s) => s.id)).toEqual([aliceSid]);
  });

  it('DELETE /api/sessions cross-user → 404 (mask as not-found)', async () => {
    const { user: alice, authCookie: aliceCookie } =
      env.createUserWithToken('alice');

    const ownerCreate = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: env.authCookie, 'content-type': 'application/json' },
      payload: { projectId: 'demo', mode: 'create' },
    });
    const ownerSid = (ownerCreate.json() as { id: string }).id;

    const aliceProjectDir = join(env.workspace, alice.username, 'p1');
    mkdirSync(aliceProjectDir);
    const spawn = mgr.spawn({
      projectId: 'alice-p1',
      cwd: aliceProjectDir,
      command: 'sh',
      args: [],
      scrollbackBytes: 4096,
      mode: 'create',
      userId: alice.id,
    });
    if (spawn.kind !== 'created') throw new Error('expected created');
    const aliceSid = spawn.session.info.id;

    // Alice tries to DELETE owner's session → 404 (mask not-found, do not
    // leak that the id exists but belongs to another user).
    const aliceDelOwner = await app.inject({
      method: 'DELETE',
      url: `/api/sessions/${ownerSid}`,
      headers: { cookie: aliceCookie },
    });
    expect(aliceDelOwner.statusCode).toBe(404);

    // Owner tries to DELETE alice's session → 404 (same mask).
    const ownerDelAlice = await app.inject({
      method: 'DELETE',
      url: `/api/sessions/${aliceSid}`,
      headers: { cookie: env.authCookie },
    });
    expect(ownerDelAlice.statusCode).toBe(404);

    // Both sessions still exist (markDeleted was NOT called).
    expect(mgr.get(ownerSid)?.deletedAt).toBeNull();
    expect(mgr.get(aliceSid)?.deletedAt).toBeNull();
  });

  // projects 路由 4 个 endpoint 必须按
  // req.user 解析对应的 ProjectStore。owner 走注入的单例（含 demo），
  // limited user 走 lazy 构造的 `<guestRoot>/<username>/` store。

  it('GET /api/projects: limited user 看不到 owner 项目', async () => {
    const { authCookie: aliceCookie } = env.createUserWithToken('alice');

    const ownerList = await app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { cookie: env.authCookie },
    });
    const ownerIds = (ownerList.json() as { projects: Array<{ id: string }> }).projects.map(
      (p) => p.id,
    );
    expect(ownerIds).toContain('demo');

    const aliceList = await app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { cookie: aliceCookie },
    });
    const aliceIds = (aliceList.json() as { projects: Array<{ id: string }> }).projects.map(
      (p) => p.id,
    );
    expect(aliceIds).not.toContain('demo');
    // alice 的 root 初始为空（createLimitedUser mkdir 了 root 但不放任何项目）
    expect(aliceIds).toEqual([]);
  });

  it('POST /api/projects: limited user 创建项目落 guest 子树', async () => {
    const { user: alice, authCookie: aliceCookie } =
      env.createUserWithToken('alice');

    const create = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie: aliceCookie, 'content-type': 'application/json' },
      payload: { name: 'p1' },
    });
    expect(create.statusCode).toBe(201);
    const body = create.json() as { id: string; cwd: string };
    expect(body.id).toBe('p1');
    const expectedCwd = join(env.workspace, alice.username, 'p1');
    expect(body.cwd).toBe(expectedCwd);
    expect(existsSync(expectedCwd)).toBe(true);
    expect(statSync(expectedCwd).isDirectory()).toBe(true);

    // owner 视角不应看到 alice 的项目
    const ownerList = await app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { cookie: env.authCookie },
    });
    const ownerIds = (ownerList.json() as { projects: Array<{ id: string }> }).projects.map(
      (p) => p.id,
    );
    expect(ownerIds).not.toContain('p1');

    // alice 视角应看到刚创建的项目
    const aliceList = await app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { cookie: aliceCookie },
    });
    const aliceIds = (aliceList.json() as { projects: Array<{ id: string }> }).projects.map(
      (p) => p.id,
    );
    expect(aliceIds).toEqual(['p1']);
  });

  it('DELETE /api/projects/:id: limited user 拿 owner project id → 404', async () => {
    const { authCookie: aliceCookie } = env.createUserWithToken('alice');

    const aliceDelOwner = await app.inject({
      method: 'DELETE',
      url: '/api/projects/demo',
      headers: { cookie: aliceCookie },
    });
    expect(aliceDelOwner.statusCode).toBe(404);

    // owner 的 demo 仍可见（未被软删）
    const ownerList = await app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { cookie: env.authCookie },
    });
    const ownerIds = (ownerList.json() as { projects: Array<{ id: string }> }).projects.map(
      (p) => p.id,
    );
    expect(ownerIds).toContain('demo');
  });

  it('GET /api/projects/:id/history: limited user 拿 owner project id → 404', async () => {
    const { authCookie: aliceCookie } = env.createUserWithToken('alice');

    const res = await app.inject({
      method: 'GET',
      url: '/api/projects/demo/history',
      headers: { cookie: aliceCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  // §6.1: end-to-end positive case — user creates own
  // project then spawns a session in it (would have hit project_not_found
  // before reframe because sessions.ts used owner singleton store).
  it('POST /api/sessions for own project → 201', async () => {
    const { authCookie: aliceCookie } = env.createUserWithToken('alice');

    const create = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie: aliceCookie, 'content-type': 'application/json' },
      payload: { name: 'p1' },
    });
    expect(create.statusCode).toBe(201);

    const spawn = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: aliceCookie, 'content-type': 'application/json' },
      payload: { projectId: 'p1', mode: 'create' },
    });
    expect(spawn.statusCode).toBe(201);
    const body = spawn.json() as { id: string; projectId: string };
    expect(body.projectId).toBe('p1');
  });

  // §6.5: owner can self-issue + use a token (auth-multi-user
  // route no longer hardcodes `kind === 'limited'`). Owner-via-token still
  // sees owner's projects.
  it('owner token login + GET /api/projects → still sees owner projects', async () => {
    const { plaintext: ownerToken } = env.tokenStore.issue({
      userId: env.owner.id,
      ttlMs: 60_000,
    });

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/token',
      headers: { 'content-type': 'application/json' },
      payload: { token: ownerToken },
    });
    expect(login.statusCode).toBe(200);
    const loginBody = login.json() as { user: { username: string; kind: string } };
    expect(loginBody.user.kind).toBe('owner');

    const ownerCookie = `ccanywhere_session=${ownerToken}`;
    const list = await app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { cookie: ownerCookie },
    });
    const ids = (list.json() as { projects: Array<{ id: string }> }).projects.map(
      (p) => p.id,
    );
    expect(ids).toContain('demo');
  });

  it('DELETE /api/sessions own session → 204', async () => {
    const { user: alice, authCookie: aliceCookie } =
      env.createUserWithToken('alice');

    const aliceProjectDir = join(env.workspace, alice.username, 'p1');
    mkdirSync(aliceProjectDir);
    const spawn = mgr.spawn({
      projectId: 'alice-p1',
      cwd: aliceProjectDir,
      command: 'sh',
      args: [],
      scrollbackBytes: 4096,
      mode: 'create',
      userId: alice.id,
    });
    if (spawn.kind !== 'created') throw new Error('expected created');
    const aliceSid = spawn.session.info.id;

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/sessions/${aliceSid}`,
      headers: { cookie: aliceCookie },
    });
    expect(del.statusCode).toBe(204);
    expect(mgr.get(aliceSid)?.deletedAt).not.toBeNull();
  });
});
