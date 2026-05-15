import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Session } from '../session/manager.js';
import { UserStore } from '../users/store.js';
import { ccJsonlPathOf } from './path.js';
import { QuotaWatcher } from './watcher.js';

/**
 * Mocks a `Session` object with just the fields QuotaWatcher inspects.
 * We don't need a real PTY — the watcher only reads `info.{id,cwd,
 * userId,resumeSessionId}` and never spawns or signals anything.
 */
function fakeSession(info: {
  id: string;
  userId: string;
  cwd: string;
  resumeSessionId?: string;
}): Session {
  return {
    info: {
      id: info.id,
      userId: info.userId,
      cwd: info.cwd,
      projectId: 'p1',
      mode: 'create',
      createdAt: 0,
      ...(info.resumeSessionId !== undefined ? { resumeSessionId: info.resumeSessionId } : {}),
    },
  } as unknown as Session;
}

/**
 * Build the on-disk jsonl content from `tokens` worth of input, recorded
 * in cc's actual format (one assistant line per round, timestamp set to
 * just-after `since` so ccusageCalc counts it).
 */
function jsonlAssistantLine(tokens: number, since: number, model = 'claude-sonnet-4-5'): string {
  const ts = new Date(since + 1000).toISOString();
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: {
      model,
      usage: { input_tokens: tokens },
    },
  });
}

describe('QuotaWatcher', () => {
  let workspace: string;
  let homeDir: string;
  let userStore: UserStore;
  let watcher: QuotaWatcher;
  let originalHome: string | undefined;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'qw-workspace-'));
    homeDir = mkdtempSync(join(tmpdir(), 'qw-home-'));
    originalHome = process.env['HOME'];
    process.env['HOME'] = homeDir;
    mkdirSync(join(homeDir, '.claude', 'projects'), { recursive: true });
    userStore = new UserStore({
      statePath: join(workspace, '.users.json'),
      workspace,
    });
    watcher = new QuotaWatcher({ userStore, debounceMs: 30 });
  });

  afterEach(() => {
    watcher.closeAll();
    if (originalHome !== undefined) process.env['HOME'] = originalHome;
    else delete process.env['HOME'];
    rmSync(workspace, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });

  function createUserAndCwd(name: string, costLimitUsd = 100): {
    userId: string;
    cwd: string;
    jsonlPath: string;
    sessionId: string;
  } {
    const user = userStore.createUser({ username: name, costLimitUsd, tokensLimit: 100_000 });
    const cwd = join(workspace, name);
    const sessionId = '11111111-2222-3333-4444-555555555555';
    const jsonlPath = ccJsonlPathOf(cwd, sessionId);
    // Pre-create the parent dir so jsonl can be appended; ccJsonlPathOf
    // returns `<home>/.claude/projects/<encoded-cwd>/<id>.jsonl`.
    mkdirSync(join(jsonlPath, '..'), { recursive: true });
    return { userId: user.id, cwd, jsonlPath, sessionId };
  }

  it('appending to jsonl triggers setQuotaUsage after debounce', async () => {
    const { userId, cwd, jsonlPath, sessionId } = createUserAndCwd('alice');
    watcher.start(fakeSession({ id: sessionId, userId, cwd }));

    const since = userStore.findById(userId)!.createdAt;
    writeFileSync(jsonlPath, jsonlAssistantLine(1234, since) + '\n');
    await watcher.flush(sessionId);

    const after = userStore.findById(userId)!;
    expect(after.quota.tokens.used).toBe(1234);
    expect(after.quota.cost.usedUsd).toBeGreaterThan(0);
  });

  it('owner kind: start is a no-op (no watcher allocated)', async () => {
    const owner = userStore.getOwner();
    const cwd = join(workspace, 'owner');
    mkdirSync(cwd);
    watcher.start(fakeSession({ id: 'sid-owner', userId: owner.id, cwd }));
    // No throw on flush — entry was never registered.
    await watcher.flush('sid-owner');
    expect(userStore.findById(owner.id)!.quota.tokens.used).toBe(0);
  });

  it('debounce window collapses multiple appends to one recompute', async () => {
    const { userId, cwd, jsonlPath, sessionId } = createUserAndCwd('alice');
    watcher.start(fakeSession({ id: sessionId, userId, cwd }));
    const since = userStore.findById(userId)!.createdAt;

    // Three quick appends within debounce window — final state has 600 tokens
    writeFileSync(jsonlPath, jsonlAssistantLine(100, since) + '\n');
    appendFileSync(jsonlPath, jsonlAssistantLine(200, since) + '\n');
    appendFileSync(jsonlPath, jsonlAssistantLine(300, since) + '\n');
    await watcher.flush(sessionId);

    expect(userStore.findById(userId)!.quota.tokens.used).toBe(600);
  });

  it('stop after schedule cancels pending recompute', async () => {
    const { userId, cwd, jsonlPath, sessionId } = createUserAndCwd('alice');
    watcher.start(fakeSession({ id: sessionId, userId, cwd }));
    const since = userStore.findById(userId)!.createdAt;
    writeFileSync(jsonlPath, jsonlAssistantLine(500, since) + '\n');

    // Stop before debounce timer fires — used must remain 0.
    watcher.stop(sessionId);
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(userStore.findById(userId)!.quota.tokens.used).toBe(0);
  });

  it('start is idempotent for the same sessionId', () => {
    const { userId, cwd, sessionId } = createUserAndCwd('alice');
    watcher.start(fakeSession({ id: sessionId, userId, cwd }));
    // Second start: same id, no throw, no extra watcher leaked
    watcher.start(fakeSession({ id: sessionId, userId, cwd }));
    expect(true).toBe(true);
  });

  it('resume mode: jsonl path uses resumeSessionId, not info.id', async () => {
    const { userId, cwd } = createUserAndCwd('alice');
    const webId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const ccId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    watcher.start(fakeSession({ id: webId, userId, cwd, resumeSessionId: ccId }));

    const ccJsonlPath = ccJsonlPathOf(cwd, ccId);
    mkdirSync(join(ccJsonlPath, '..'), { recursive: true });
    const since = userStore.findById(userId)!.createdAt;
    writeFileSync(ccJsonlPath, jsonlAssistantLine(777, since) + '\n');
    await watcher.flush(webId);

    expect(userStore.findById(userId)!.quota.tokens.used).toBe(777);
  });
});
