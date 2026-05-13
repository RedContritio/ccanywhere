import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionManager } from '../session/manager.js';
import { SessionRegistry } from '../session/registry.js';
import { buildServer } from './server.js';
import {
  baseConfig,
  CLI_TOKEN,
  INTERNAL_HOOK_TOKEN,
  setupProjects,
  type TestProjectsEnv,
} from './server.test-helpers.js';

/**
 * Endpoints covered:
 *   POST /api/sessions/:id/resume — dead stub → active session
 *   GET  /api/sessions/:id/screen — last screen text from dead stub
 */
describe('Dead stub resume + screen endpoints', () => {
  let env: TestProjectsEnv;
  let regDir: string;
  let registry: SessionRegistry;
  let mgr: SessionManager;
  let app: FastifyInstance;
  let projectId: string;

  beforeEach(async () => {
    env = setupProjects();
    projectId = 'demo';
    regDir = await mkdtemp(join(tmpdir(), 'cc-resume-routes-'));
    registry = new SessionRegistry(regDir);
    mgr = new SessionManager({ registry });
    app = await buildServer({
      config: baseConfig,
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
    await mgr.detach();
    await app.close();
    await rm(regDir, { recursive: true, force: true });
    env.cleanup();
  });

  async function seedDeadStub(opts: {
    id: string;
    userId?: string;
    deletedAt?: number | null;
    lastScreen?: string;
  }): Promise<void> {
    const info = {
      id: opts.id,
      projectId,
      cwd: env.demoCwd,
      mode: 'create' as const,
      createdAt: 1_700_000_000_000,
      userId: opts.userId ?? env.owner.id,
    };
    await registry.save(info, opts.deletedAt ?? null);
    if (opts.lastScreen !== undefined) {
      await registry.saveScreen(opts.id, opts.lastScreen);
    }
    // Reload so deadStubs map sees the seeded files.
    mgr.loadDeadStubs(Date.now());
  }

  describe('POST /api/sessions/:id/resume', () => {
    it('404 on unknown id', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions/does-not-exist/resume',
        headers: { cookie: env.authCookie, 'content-type': 'application/json' },
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    });

    it('409 already_active when session is alive', async () => {
      // Spawn a real session so manager.get(id) is defined.
      const r = mgr.spawn({
        projectId,
        cwd: env.demoCwd,
        command: 'sh',
        args: ['-c', 'sleep 30'],
        scrollbackBytes: 4096,
        mode: 'create',
        userId: env.owner.id,
      });
      if (r.kind !== 'created') throw new Error('expected created');
      const id = r.session.info.id;

      const res = await app.inject({
        method: 'POST',
        url: `/api/sessions/${id}/resume`,
        headers: { cookie: env.authCookie, 'content-type': 'application/json' },
        payload: {},
      });
      expect(res.statusCode).toBe(409);
      expect((res.json() as { error: { code: string } }).error.code).toBe(
        'already_active',
      );
    });

    it('409 soft_deleted when stub has deletedAt set', async () => {
      // deletedAt close to now so loadDeadStubs doesn't GC it past ttl.
      await seedDeadStub({ id: 'soft', deletedAt: Date.now() - 1_000 });
      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions/soft/resume',
        headers: { cookie: env.authCookie, 'content-type': 'application/json' },
        payload: {},
      });
      expect(res.statusCode).toBe(409);
      expect((res.json() as { error: { code: string } }).error.code).toBe(
        'soft_deleted',
      );
    });

    it('404 when caller is not the owner', async () => {
      const other = env.createLimitedUserWithToken('intruder');
      await seedDeadStub({ id: 'guarded' });
      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions/guarded/resume',
        headers: { cookie: other.authCookie, 'content-type': 'application/json' },
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    });

    it('404 project_gone when owning project was removed', async () => {
      await seedDeadStub({ id: 'orphan' });
      // Remove the project the stub points to.
      env.projectStore.hide(projectId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions/orphan/resume',
        headers: { cookie: env.authCookie, 'content-type': 'application/json' },
        payload: {},
      });
      expect(res.statusCode).toBe(404);
      expect((res.json() as { error: { code: string } }).error.code).toBe(
        'project_gone',
      );
    });

    it('201 spawns new PTY reusing original id; deadStubs map cleared', async () => {
      await seedDeadStub({ id: 'reborn', lastScreen: 'old' });
      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions/reborn/resume',
        headers: { cookie: env.authCookie, 'content-type': 'application/json' },
        payload: { cols: 80, rows: 24, webTheme: 'dark' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as { id: string; mode: string; state: string };
      expect(body.id).toBe('reborn');
      expect(body.mode).toBe('resume');
      expect(mgr.get('reborn')?.info.id).toBe('reborn');
      expect(mgr.getDeadStub('reborn')).toBeUndefined();
      await mgr.detach(); // flush pending IO
      expect(existsSync(join(regDir, 'reborn.screen.txt'))).toBe(false);
    });
  });

  describe('GET /api/sessions/:id/screen', () => {
    it('returns 404 when no snapshot exists', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/sessions/no-such/screen',
        headers: { cookie: env.authCookie },
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns text/plain body for a dead stub the caller owns', async () => {
      await seedDeadStub({ id: 'with-screen', lastScreen: 'banner\nprompt> ' });
      const res = await app.inject({
        method: 'GET',
        url: '/api/sessions/with-screen/screen',
        headers: { cookie: env.authCookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/plain/);
      expect(res.body).toBe('banner\nprompt> ');
    });

    it('404 cross-user', async () => {
      const other = env.createLimitedUserWithToken('peeper');
      await seedDeadStub({ id: 'private-frame', lastScreen: 'secret' });
      const res = await app.inject({
        method: 'GET',
        url: '/api/sessions/private-frame/screen',
        headers: { cookie: other.authCookie },
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
