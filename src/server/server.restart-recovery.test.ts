import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionManager, type Session } from '../session/manager.js';
import { SessionRegistry } from '../session/registry.js';
import { buildServer } from './server.js';
import {
  baseConfig,
  CLI_TOKEN,
  INTERNAL_HOOK_TOKEN,
  setupProjects,
  type TestProjectsEnv,
} from './server.test-helpers.js';

interface Snapshot {
  readonly id: string;
  readonly state: Session['state'];
  readonly deletedAt: number | null;
}

async function listSessions(
  app: FastifyInstance,
  cookie: string,
): Promise<Snapshot[]> {
  const res = await app.inject({
    method: 'GET',
    url: '/api/sessions',
    headers: { cookie },
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { sessions: Snapshot[] }).sessions;
}

/**
 *  end-to-end: simulates a ccanywhere restart.
 *
 *   1. boot server1 (fresh registry dir)
 *   2. POST /api/sessions → creates active session, manager1 spawns PTY
 *   3. simulate shutdown: PTY → SIGINT → onExit writes snapshot;
 *      manager1.detach awaits pending IO; app.close
 *   4. boot server2 with new manager2 + same registry dir
 *   5. manager2.loadDeadStubs replays metadata → session shows up as
 *      dead in GET /api/sessions
 *   6. POST /api/sessions/:id/resume → 201, same id, state=idle,
 *      mode=resume
 */
describe('restart recovery (server-level)', () => {
  let env: TestProjectsEnv;
  let regDir: string;
  let registry1: SessionRegistry;
  let mgr1: SessionManager;
  let app1: FastifyInstance;

  beforeEach(async () => {
    env = setupProjects();
    regDir = await mkdtemp(join(tmpdir(), 'cc-restart-'));
    registry1 = new SessionRegistry(regDir);
    mgr1 = new SessionManager({ registry: registry1 });
    app1 = await buildServer({
      config: {
        ...baseConfig,
        workspace: env.workspace,
      },
      manager: mgr1,
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
    await mgr1.killAll();
    await mgr1.detach();
    await app1.close();
    await rm(regDir, { recursive: true, force: true });
    env.cleanup();
  });

  it('survives a simulated restart: active → dead → resume', async () => {
    const createRes = await app1.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: env.authCookie, 'content-type': 'application/json' },
      payload: { projectId: 'demo', mode: 'create' },
    });
    expect(createRes.statusCode).toBe(201);
    const original = createRes.json() as Snapshot;
    expect(original.state).toBe('idle');

    const live = await listSessions(app1, env.authCookie);
    expect(live.map((s) => s.id)).toEqual([original.id]);

    // Simulate shutdown: kill PTY (triggers onExit → snapshot write),
    // detach drains pending writes, close app.
    await mgr1.killAll();
    await mgr1.detach();
    await app1.close();

    // Boot a fresh server with a brand-new manager but the same registry dir.
    const registry2 = new SessionRegistry(regDir);
    const mgr2 = new SessionManager({ registry: registry2 });
    mgr2.loadDeadStubs(Date.now());
    const app2 = await buildServer({
      config: {
        ...baseConfig,
        workspace: env.workspace,
      },
      manager: mgr2,
      projectStore: env.projectStore,
      deviceStore: env.deviceStore,
      userStore: env.userStore,
      tokenStore: env.tokenStore,
      internalHookToken: INTERNAL_HOOK_TOKEN,
      cliToken: CLI_TOKEN,
      webDistDir: null,
      injectCcSessionId: false,
    });

    try {
      const afterRestart = await listSessions(app2, env.authCookie);
      expect(afterRestart).toHaveLength(1);
      expect(afterRestart[0]!.id).toBe(original.id);
      expect(afterRestart[0]!.state).toBe('dead');
      expect(afterRestart[0]!.deletedAt).toBeNull();

      // Override the resume cc binary to `sh` so the test doesn't need
      // claude installed; baseConfig.claudeBin is already 'sh', so the
      // resume route's `sh --resume <id> --session-id <id>` will print
      // garbage and exit — that's fine, we only assert the spawn happened
      // and the row transitioned out of dead.
      const resumeRes = await app2.inject({
        method: 'POST',
        url: `/api/sessions/${original.id}/resume`,
        headers: { cookie: env.authCookie, 'content-type': 'application/json' },
        payload: {},
      });
      expect(resumeRes.statusCode).toBe(201);
      const revived = resumeRes.json() as Snapshot;
      expect(revived.id).toBe(original.id);

      expect(mgr2.get(original.id)).toBeDefined();
      expect(mgr2.getDeadStub(original.id)).toBeUndefined();
    } finally {
      await mgr2.killAll();
      await mgr2.detach();
      await app2.close();
    }
  });
});
