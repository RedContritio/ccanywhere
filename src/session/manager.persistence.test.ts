import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionManager, type Session, type SpawnOptions } from './manager.js';
import { SessionRegistry } from './registry.js';

const baseSpawn: Omit<SpawnOptions, 'command' | 'args'> = {
  projectId: 'demo',
  cwd: process.cwd(),
  scrollbackBytes: 4096,
  mode: 'create',
  userId: 'test-owner-id',
};

function spawnCreated(m: SessionManager, opts: SpawnOptions): Session {
  const result = m.spawn(opts);
  if (result.kind !== 'created') {
    throw new Error(`expected created spawn, got ${result.kind}`);
  }
  return result.session;
}

async function flush(mgr: SessionManager): Promise<void> {
  // Drain pending fire-and-forget writes triggered during the test.
  await mgr.detach();
}

describe('SessionManager × persistence', () => {
  let dir: string;
  let registry: SessionRegistry;
  let mgr: SessionManager;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cc-mgr-persist-'));
    registry = new SessionRegistry(dir);
    mgr = new SessionManager({ registry });
  });

  afterEach(async () => {
    await mgr.killAll();
    await mgr.detach();
    await rm(dir, { recursive: true, force: true });
  });

  it('spawn writes metadata; exit writes screen snapshot to disk', async () => {
    const session = spawnCreated(mgr, {
      ...baseSpawn,
      command: 'sh',
      args: ['-c', 'echo hello; sleep 30'],
    });
    await flush(mgr);
    expect(existsSync(join(dir, `${session.info.id}.json`))).toBe(true);

    // kill() resolves when pty.onExit fires (see session-impl.ts); by
    // then handleSessionExit has already migrated the row + queued
    // saveScreen. flush() drains that pending IO.
    await session.kill();
    await flush(mgr);

    expect(existsSync(join(dir, `${session.info.id}.screen.txt`))).toBe(true);
    expect(mgr.get(session.info.id)).toBeUndefined();
    expect(mgr.findRow(session.info.id)?.state).toBe('dead');
  });

  it('markDeleted persists deletedAt eagerly (crash safety)', async () => {
    const session = spawnCreated(mgr, {
      ...baseSpawn,
      command: 'sh',
      args: ['-c', 'sleep 30'],
    });
    mgr.markDeleted(session.info.id);
    await flush(mgr);

    const text = await readFile(join(dir, `${session.info.id}.json`), 'utf8');
    const parsed = JSON.parse(text) as { deletedAt: number | null };
    expect(parsed.deletedAt).not.toBeNull();
  });

  it('loadDeadStubs hard-deletes entries past ttl', async () => {
    // Seed registry directly: ancient deletedAt.
    const ancientInfo = {
      id: 'old',
      projectId: 'demo',
      cwd: '/tmp',
      mode: 'create' as const,
      createdAt: 1_000_000,
      userId: 'u',
    };
    await registry.save(ancientInfo, 1_000_000);
    await registry.saveScreen('old', 'stale');

    const tinyMgr = new SessionManager({
      deletedSessionTtlMs: 1_000,
      registry,
    });
    tinyMgr.loadDeadStubs(Date.now());
    await tinyMgr.detach();

    expect(tinyMgr.findRow('old')).toBeUndefined();
    expect(existsSync(join(dir, 'old.json'))).toBe(false);
    expect(existsSync(join(dir, 'old.screen.txt'))).toBe(false);
  });

  it('loadDeadStubs keeps fresh non-deleted entries as dead stubs', async () => {
    const info = {
      id: 'fresh',
      projectId: 'demo',
      cwd: '/tmp',
      mode: 'create' as const,
      createdAt: 1_700_000_000_000,
      userId: 'u',
    };
    await registry.save(info, null);
    await registry.saveScreen('fresh', 'banner line\nprompt > ');

    const fresh = new SessionManager({ registry });
    fresh.loadDeadStubs(Date.now());

    const stub = fresh.getDeadStub('fresh');
    expect(stub).toBeDefined();
    expect(stub!.lastScreen).toBe('banner line\nprompt > ');
    expect(fresh.findRow('fresh')?.state).toBe('dead');
    expect(fresh.list().map((r) => r.info.id)).toContain('fresh');
  });

  it('markDeleted on a dead stub stamps deletedAt + persists', async () => {
    const info = {
      id: 'stub-mark',
      projectId: 'demo',
      cwd: '/tmp',
      mode: 'create' as const,
      createdAt: 1_700_000_000_000,
      userId: 'u',
    };
    await registry.save(info, null);

    const m = new SessionManager({ registry });
    m.loadDeadStubs(Date.now());
    expect(m.markDeleted('stub-mark')).toBe(true);
    await m.detach();

    expect(m.findRow('stub-mark')?.deletedAt).not.toBeNull();
    const text = await readFile(join(dir, 'stub-mark.json'), 'utf8');
    expect((JSON.parse(text) as { deletedAt: number | null }).deletedAt).not.toBeNull();
  });

  it('list() merges active sessions and dead stubs', async () => {
    const a = spawnCreated(mgr, {
      ...baseSpawn,
      command: 'sh',
      args: ['-c', 'sleep 30'],
    });
    // Seed registry with a pre-existing dead stub from a "previous boot".
    const stubInfo = {
      id: 'prev',
      projectId: 'demo',
      cwd: '/tmp',
      mode: 'create' as const,
      createdAt: 1,
      userId: 'u',
    };
    await registry.save(stubInfo, null);
    await registry.saveScreen('prev', 'x');
    mgr.loadDeadStubs(Date.now());

    const ids = mgr.list().map((r) => r.info.id).sort();
    expect(ids).toEqual([a.info.id, 'prev'].sort());
  });

  it('resumeDeadStub spawns a new PTY reusing the original id; old screen file purged', async () => {
    // Seed a dead stub
    const info = {
      id: 'to-resume',
      projectId: 'demo',
      cwd: process.cwd(),
      mode: 'create' as const,
      createdAt: 1_700_000_000_000,
      userId: 'u',
    };
    await registry.save(info, null);
    await registry.saveScreen('to-resume', 'old frame');
    mgr.loadDeadStubs(Date.now());
    expect(mgr.getDeadStub('to-resume')).toBeDefined();

    const result = mgr.resumeDeadStub('to-resume', {
      command: 'sh',
      args: ['-c', 'sleep 30'],
      scrollbackBytes: 4096,
    });

    expect(result.kind).toBe('created');
    if (result.kind !== 'created') throw new Error('unreachable');
    expect(result.session.info.id).toBe('to-resume');
    expect(result.session.info.mode).toBe('resume');
    expect(mgr.getDeadStub('to-resume')).toBeUndefined();
    expect(mgr.get('to-resume')?.info.id).toBe('to-resume');
    await flush(mgr);
    expect(existsSync(join(dir, 'to-resume.screen.txt'))).toBe(false);
  });

  it('resumeDeadStub throws on soft-deleted stub', async () => {
    const info = {
      id: 'soft',
      projectId: 'demo',
      cwd: '/tmp',
      mode: 'create' as const,
      createdAt: 1_700_000_000_000,
      userId: 'u',
    };
    await registry.save(info, 1_700_000_500_000);
    mgr.loadDeadStubs(1_700_000_500_001);

    expect(() =>
      mgr.resumeDeadStub('soft', {
        command: 'sh',
        args: ['-c', 'sleep 30'],
        scrollbackBytes: 4096,
      }),
    ).toThrow(/soft-deleted/);
  });

  it('gc hard-deletes dead stubs past ttl + cleans registry', async () => {
    const tinyMgr = new SessionManager({
      deletedSessionTtlMs: 1_000,
      registry,
    });
    const info = {
      id: 'expired',
      projectId: 'demo',
      cwd: '/tmp',
      mode: 'create' as const,
      createdAt: 1,
      userId: 'u',
    };
    await registry.save(info, 5_000);
    await registry.saveScreen('expired', 'x');
    tinyMgr.loadDeadStubs(5_000); // still within ttl
    expect(tinyMgr.findRow('expired')).toBeDefined();

    tinyMgr.gc(10_000); // past ttl
    await tinyMgr.detach();

    expect(tinyMgr.findRow('expired')).toBeUndefined();
    expect(existsSync(join(dir, 'expired.json'))).toBe(false);
    expect(existsSync(join(dir, 'expired.screen.txt'))).toBe(false);
  });
});
