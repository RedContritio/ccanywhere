import { mkdirSync } from 'node:fs';
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
 * (#44 m-multi-user). Covers cwd guard, GET filter, and DELETE 404 mask.
 *
 * Strategy: alice sessions are injected via `mgr.spawn` directly with
 * `userId: alice.id`. The HTTP POST happy-path for alice (cwd inside her
 * guest root) requires a per-user ProjectStore which is out of scope for
 * v12.1 — limited users cannot create projects through the public API
 * yet. We only verify the guard fires for owner-owned projects.
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

  it('POST /api/sessions as limited user with owner project → 403', async () => {
    const { authCookie } = env.createLimitedUserWithToken('alice');

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: authCookie, 'content-type': 'application/json' },
      payload: { projectId: 'demo', mode: 'create' },
    });

    expect(res.statusCode).toBe(403);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('forbidden');
  });

  it('GET /api/sessions filters by user.id', async () => {
    const { user: alice, authCookie: aliceCookie } =
      env.createLimitedUserWithToken('alice');

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
    const aliceProjectDir = join(env.guestProjectsRoot, alice.username, 'p1');
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
      env.createLimitedUserWithToken('alice');

    const ownerCreate = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: env.authCookie, 'content-type': 'application/json' },
      payload: { projectId: 'demo', mode: 'create' },
    });
    const ownerSid = (ownerCreate.json() as { id: string }).id;

    const aliceProjectDir = join(env.guestProjectsRoot, alice.username, 'p1');
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

  it('DELETE /api/sessions own session → 204', async () => {
    const { user: alice, authCookie: aliceCookie } =
      env.createLimitedUserWithToken('alice');

    const aliceProjectDir = join(env.guestProjectsRoot, alice.username, 'p1');
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
