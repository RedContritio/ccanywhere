import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
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
 * #46 m-quota-cost-tracking: integration tests for the UserPromptSubmit hook
 * quota enforcement path. Builds the server with userStore + tokenStore
 * wired (multi-user mode) and exercises:
 *   - owner skip (state-machine only)
 *   - first-prompt edge (no jsonl → no block, no persist)
 *   - under-limit (persist usage, no block)
 *   - over cost limit → block JSON
 *   - over tokens limit → block JSON
 *   - double limit "first to trip" semantics
 *
 * Strategy: directly inject ccanywhere sessions via `mgr.spawn` with
 * known cwd + forcedSessionId so the test controls the jsonl path. We
 * shim a fixture jsonl directly under ~/.claude/projects/<encoded>/ —
 * cleanup removes the dir afterwards.
 */

interface UsageBlock {
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheCreation?: number;
}

function assistantLine(model: string, timestamp: string, usage: UsageBlock): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp,
    message: {
      model,
      usage: {
        input_tokens: usage.input ?? 0,
        output_tokens: usage.output ?? 0,
        cache_read_input_tokens: usage.cacheRead ?? 0,
        cache_creation_input_tokens: usage.cacheCreation ?? 0,
      },
    },
  });
}

describe('REST API: UserPromptSubmit hook quota enforcement', () => {
  let mgr: SessionManager;
  let app: FastifyInstance;
  let env: TestProjectsEnv;
  /** Tracks fixture dirs we create under ~/.claude/projects/ for cleanup. */
  const createdProjectDirs: string[] = [];

  function writeJsonl(cwd: string, sessionId: string, lines: string[]): string {
    const dir = join(homedir(), '.claude', 'projects', cwd.replace(/\//g, '-'));
    mkdirSync(dir, { recursive: true });
    createdProjectDirs.push(dir);
    const path = join(dir, `${sessionId}.jsonl`);
    writeFileSync(path, lines.join('\n') + '\n');
    return path;
  }

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
    for (const dir of createdProjectDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    createdProjectDirs.length = 0;
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

  it('owner UserPromptSubmit → 204 state→busy, no quota interaction', async () => {
    const sid = '00000000-0000-4000-8000-000000000001';
    spawnFor(env.owner.id, sid, env.demoCwd);
    // Fixture jsonl with HUGE usage to confirm owner skip ignores it
    writeJsonl(env.demoCwd, sid, [
      assistantLine('claude-opus-4-7', '2099-01-01T00:00:00.000Z', { input: 1_000_000 }),
    ]);

    const res = await app.inject({
      method: 'POST',
      url: `/api/hook/${sid}/UserPromptSubmit`,
      headers: { Authorization: `Bearer ${INTERNAL_HOOK_TOKEN}` },
    });
    expect(res.statusCode).toBe(204);
    expect(mgr.get(sid)?.state).toBe('busy');
    // Owner quota.usedUsd remains 0 (no persist for owner)
    expect(env.userStore.findById(env.owner.id)?.quota.cost.usedUsd).toBe(0);
  });

  it('first-prompt edge: jsonl missing → no block, no persist (treat as 0)', async () => {
    const { user: alice } = env.createUserWithToken('alice', { costLimitUsd: 5 });
    const sid = '00000000-0000-4000-8000-000000000002';
    spawnFor(alice.id, sid, env.demoCwd);
    // No jsonl written — confirm 204 + state machine still runs

    const res = await app.inject({
      method: 'POST',
      url: `/api/hook/${sid}/UserPromptSubmit`,
      headers: { Authorization: `Bearer ${INTERNAL_HOOK_TOKEN}` },
    });
    expect(res.statusCode).toBe(204);
    expect(mgr.get(sid)?.state).toBe('busy');
    expect(env.userStore.findById(alice.id)?.quota.cost.usedUsd).toBe(0);
  });

  it('under-limit limited user → 204, usage persisted, state→busy', async () => {
    const { user: alice } = env.createUserWithToken('alice', { costLimitUsd: 100 });
    const sid = '00000000-0000-4000-8000-000000000003';
    spawnFor(alice.id, sid, env.demoCwd);
    // Sonnet 1000 input + 500 output = (1000*3 + 500*15) / 1e6 = 0.0105 USD
    const ts = new Date(alice.createdAt + 1000).toISOString();
    writeJsonl(env.demoCwd, sid, [
      assistantLine('claude-sonnet-4-6', ts, { input: 1000, output: 500 }),
    ]);

    const res = await app.inject({
      method: 'POST',
      url: `/api/hook/${sid}/UserPromptSubmit`,
      headers: { Authorization: `Bearer ${INTERNAL_HOOK_TOKEN}` },
    });
    expect(res.statusCode).toBe(204);
    expect(mgr.get(sid)?.state).toBe('busy');
    const refreshed = env.userStore.findById(alice.id);
    expect(refreshed?.quota.cost.usedUsd).toBeCloseTo(0.0105, 6);
    expect(refreshed?.quota.tokens.used).toBe(1500);
  });

  it('over cost limit → block JSON with cost message, state stays idle', async () => {
    const { user: alice } = env.createUserWithToken('alice', { costLimitUsd: 5 });
    const sid = '00000000-0000-4000-8000-000000000004';
    spawnFor(alice.id, sid, env.demoCwd);
    // Opus 1M input @ 15 USD / 1M = $15 (>> $5 limit)
    const ts = new Date(alice.createdAt + 1000).toISOString();
    writeJsonl(env.demoCwd, sid, [
      assistantLine('claude-opus-4-7', ts, { input: 1_000_000 }),
    ]);

    const res = await app.inject({
      method: 'POST',
      url: `/api/hook/${sid}/UserPromptSubmit`,
      headers: { Authorization: `Bearer ${INTERNAL_HOOK_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      decision: string;
      reason: string;
      continue: boolean;
      stopReason: string;
    };
    expect(body.decision).toBe('block');
    expect(body.reason).toMatch(/cost quota exhausted/);
    expect(body.continue).toBe(false);
    expect(body.stopReason).toBe(body.reason);
    // State machine NOT transitioned (still idle pre-block)
    expect(mgr.get(sid)?.state).toBe('idle');
  });

  it('over tokens limit → block JSON with tokens message', async () => {
    const { user: alice } = env.createUserWithToken('alice', {
      costLimitUsd: null,
      tokensLimit: 1000,
    });
    const sid = '00000000-0000-4000-8000-000000000005';
    spawnFor(alice.id, sid, env.demoCwd);
    const ts = new Date(alice.createdAt + 1000).toISOString();
    writeJsonl(env.demoCwd, sid, [
      assistantLine('claude-sonnet-4-6', ts, { input: 2000 }),
    ]);

    const res = await app.inject({
      method: 'POST',
      url: `/api/hook/${sid}/UserPromptSubmit`,
      headers: { Authorization: `Bearer ${INTERNAL_HOOK_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { decision: string; reason: string };
    expect(body.decision).toBe('block');
    expect(body.reason).toMatch(/tokens quota exhausted/);
  });

  it('double limit: cost trips first → cost reason returned', async () => {
    const { user: alice } = env.createUserWithToken('alice', {
      costLimitUsd: 1,
      tokensLimit: 10_000_000,
    });
    const sid = '00000000-0000-4000-8000-000000000006';
    spawnFor(alice.id, sid, env.demoCwd);
    // 1M sonnet input @ $3/M = $3 (>> $1 cost limit, way < 10M token limit)
    const ts = new Date(alice.createdAt + 1000).toISOString();
    writeJsonl(env.demoCwd, sid, [
      assistantLine('claude-sonnet-4-6', ts, { input: 1_000_000 }),
    ]);

    const res = await app.inject({
      method: 'POST',
      url: `/api/hook/${sid}/UserPromptSubmit`,
      headers: { Authorization: `Bearer ${INTERNAL_HOOK_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { reason: string }).reason).toMatch(/cost quota exhausted/);
  });

  it('double limit: tokens trips first → tokens reason returned', async () => {
    const { user: alice } = env.createUserWithToken('alice', {
      costLimitUsd: 1_000_000,
      tokensLimit: 100,
    });
    const sid = '00000000-0000-4000-8000-000000000007';
    spawnFor(alice.id, sid, env.demoCwd);
    // 500 sonnet input @ $3/M = $0.0015 (< $1M cost limit, > 100 token limit)
    const ts = new Date(alice.createdAt + 1000).toISOString();
    writeJsonl(env.demoCwd, sid, [
      assistantLine('claude-sonnet-4-6', ts, { input: 500 }),
    ]);

    const res = await app.inject({
      method: 'POST',
      url: `/api/hook/${sid}/UserPromptSubmit`,
      headers: { Authorization: `Bearer ${INTERNAL_HOOK_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { reason: string }).reason).toMatch(/tokens quota exhausted/);
  });

  it('jsonl lines older than user.createdAt are excluded from totals', async () => {
    const { user: alice } = env.createUserWithToken('alice', { costLimitUsd: 5 });
    const sid = '00000000-0000-4000-8000-000000000008';
    spawnFor(alice.id, sid, env.demoCwd);
    // Pre-alice line with $$$$ usage (must be excluded), post-alice tiny line
    const preTs = new Date(alice.createdAt - 24 * 60 * 60 * 1000).toISOString();
    const postTs = new Date(alice.createdAt + 1000).toISOString();
    writeJsonl(env.demoCwd, sid, [
      assistantLine('claude-opus-4-7', preTs, { input: 1_000_000 }),
      assistantLine('claude-sonnet-4-6', postTs, { input: 100 }),
    ]);

    const res = await app.inject({
      method: 'POST',
      url: `/api/hook/${sid}/UserPromptSubmit`,
      headers: { Authorization: `Bearer ${INTERNAL_HOOK_TOKEN}` },
    });
    expect(res.statusCode).toBe(204);
    const refreshed = env.userStore.findById(alice.id);
    // Only post-alice 100 tokens counted
    expect(refreshed?.quota.tokens.used).toBe(100);
  });

  it('non-UserPromptSubmit events bypass quota check entirely', async () => {
    const { user: alice } = env.createUserWithToken('alice', { costLimitUsd: 0.01 });
    const sid = '00000000-0000-4000-8000-000000000009';
    spawnFor(alice.id, sid, env.demoCwd);
    const ts = new Date(alice.createdAt + 1000).toISOString();
    // Huge usage that WOULD block UserPromptSubmit
    writeJsonl(env.demoCwd, sid, [
      assistantLine('claude-opus-4-7', ts, { input: 1_000_000 }),
    ]);

    // PreToolUse / Stop / SessionStart MUST NOT trigger quota check
    for (const event of ['PreToolUse', 'Stop', 'SessionStart']) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/hook/${sid}/${event}`,
        headers: { Authorization: `Bearer ${INTERNAL_HOOK_TOKEN}` },
      });
      expect(res.statusCode).toBe(204);
    }
  });
});

describe('REST API: hook handler without userStore (legacy)', () => {
  let mgr: SessionManager;
  let app: FastifyInstance;
  let env: TestProjectsEnv;

  beforeEach(async () => {
    env = setupProjects();
    mgr = new SessionManager();
    // Build server WITHOUT userStore/tokenStore — hook handler should
    // fall through to pure state-machine mode.
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
    // Use the test fixture's seeded device session via mgr.spawn directly
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
