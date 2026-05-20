import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
 *  reframe: hook is now pure state-machine (busy↔idle).
 * Quota enforcement was moved to the inline ws input gate (see
 * `src/ws/server.ts`) and `setQuotaUsage` is refreshed by `QuotaWatcher`
 * (see `src/quota/watcher.ts`). This file therefore only verifies:
 *   - state transitions for known events
 *   - 400 / 404 on bad input
 *   - hook works without UserStore (legacy fixture)
 *   - non-UserPromptSubmit events run the state machine without throwing
 *
 * Quota path is exercised by `src/quota/watcher.test.ts` (unit) and
 * `src/server/server.multi-user.test.ts` (input gate integration).
 */
describe('REST API: hook state machine', () => {
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

  function spawnFor(userId: string, sessionId: string, cwd: string): void {
    mgr.spawn({
      projectId: 'demo',
      cwd,
      command: 'sh',
      args: [],
      scrollbackBytes: 4096,
      mode: 'create',
      userId,
      forcedSessionId: sessionId,
    });
  }

  it('UserPromptSubmit transitions session to busy', async () => {
    const sid = '00000000-0000-4000-8000-000000000001';
    spawnFor(env.owner.id, sid, env.demoCwd);

    const res = await app.inject({
      method: 'POST',
      url: `/api/hook/${sid}/UserPromptSubmit`,
      headers: { Authorization: `Bearer ${INTERNAL_HOOK_TOKEN}` },
    });
    expect(res.statusCode).toBe(204);
    expect(mgr.get(sid)?.state).toBe('busy');
  });

  it('Stop transitions session back to idle', async () => {
    const sid = '00000000-0000-4000-8000-000000000002';
    spawnFor(env.owner.id, sid, env.demoCwd);
    mgr.get(sid)?.setState('busy');

    const res = await app.inject({
      method: 'POST',
      url: `/api/hook/${sid}/Stop`,
      headers: { Authorization: `Bearer ${INTERNAL_HOOK_TOKEN}` },
    });
    expect(res.statusCode).toBe(204);
    expect(mgr.get(sid)?.state).toBe('idle');
  });

  it('PostToolUse / Notification do NOT change state', async () => {
    const sid = '00000000-0000-4000-8000-000000000003';
    spawnFor(env.owner.id, sid, env.demoCwd);
    const before = mgr.get(sid)?.state;

    for (const event of ['PostToolUse', 'Notification']) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/hook/${sid}/${event}`,
        headers: { Authorization: `Bearer ${INTERNAL_HOOK_TOKEN}` },
      });
      expect(res.statusCode).toBe(204);
    }
    expect(mgr.get(sid)?.state).toBe(before);
  });

  it('unknown event → 400 invalid_event', async () => {
    const sid = '00000000-0000-4000-8000-000000000004';
    spawnFor(env.owner.id, sid, env.demoCwd);

    const res = await app.inject({
      method: 'POST',
      url: `/api/hook/${sid}/Bogus`,
      headers: { Authorization: `Bearer ${INTERNAL_HOOK_TOKEN}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('unknown sessionId → 404 not_found', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/hook/ghost-sid/UserPromptSubmit`,
      headers: { Authorization: `Bearer ${INTERNAL_HOOK_TOKEN}` },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('REST API: hook handler without userStore (legacy)', () => {
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

  it('UserPromptSubmit without userStore → 204 state→busy (no quota path)', async () => {
    const sid = '00000000-0000-4000-8000-00000000000a';
    mgr.spawn({
      projectId: 'demo',
      cwd: env.demoCwd,
      command: 'sh',
      args: [],
      scrollbackBytes: 4096,
      mode: 'create',
      userId: 'legacy-no-user',
      forcedSessionId: sid,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/hook/${sid}/UserPromptSubmit`,
      headers: { Authorization: `Bearer ${INTERNAL_HOOK_TOKEN}` },
    });
    expect(res.statusCode).toBe(204);
    expect(mgr.get(sid)?.state).toBe('busy');
  });
});

describe('runStartupSanityCheck logger integration (smoke)', () => {
  it('does not throw on the real ~/.claude/projects (or empty layout)', async () => {
    const { runStartupSanityCheck } = await import('../quota/path.js');
    const logger = { info: vi.fn(), warn: vi.fn() };
    const projectsRoot = mkdtempSync(join(tmpdir(), 'ccanywhere-serve-sanity-'));
    try {
      const result = runStartupSanityCheck({ projectsRoot, logger });
      expect(['verified', 'skipped']).toContain(result.kind);
    } finally {
      rmSync(projectsRoot, { recursive: true, force: true });
    }
  });
});
