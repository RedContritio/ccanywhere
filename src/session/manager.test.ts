import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionManager, type Session, type SpawnOptions } from './manager.js';

const baseSpawn: Omit<SpawnOptions, 'command' | 'args'> = {
  projectId: 'demo',
  cwd: process.cwd(),
  scrollbackBytes: 4096,
  mode: 'create',
  userId: 'test-owner-id',
};

// Adapter for the existing `const session = spawnCreated(mgr,...)` pattern. The
// real spawn returns a discriminated union (`created` | `attached`) since
// resume-singleton — most existing tests only exercise the `create` path,
// so they want the Session out, asserting it's not an attach. The internal
// call uses `m` rather than `mgr`/`tiny` so the bulk replace below
// doesn't recurse into this helper.
function spawnCreated(m: SessionManager, opts: SpawnOptions): Session {
  const result = m.spawn(opts);
  if (result.kind !== 'created') {
    throw new Error(`expected created spawn, got ${result.kind}`);
  }
  return result.session;
}

describe('SessionManager', () => {
  let mgr: SessionManager;

  beforeEach(() => {
    mgr = new SessionManager();
  });

  afterEach(async () => {
    await mgr.killAll();
  });

  it('spawns a process and emits data events', async () => {
    const session = spawnCreated(mgr,{
      ...baseSpawn,
      command: 'sh',
      args: ['-c', 'echo hello-world; sleep 30'],
    });
    expect(session.info.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(session.info.mode).toBe('create');
    expect(session.state).toBe('idle');

    const seen = await new Promise<string>((resolve) => {
      let buf = '';
      session.on('data', ({ data }) => {
        buf += data;
        if (buf.includes('hello-world')) resolve(buf);
      });
    });
    expect(seen).toContain('hello-world');
  });

  it('records resumeSessionId only when provided', () => {
    const a = spawnCreated(mgr,{ ...baseSpawn, command: 'sh', args: ['-c', 'sleep 30'] });
    const b = spawnCreated(mgr,{
      ...baseSpawn,
      mode: 'resume',
      resumeSessionId: 'prev-uuid',
      command: 'sh',
      args: ['-c', 'sleep 30'],
    });
    expect(a.info.resumeSessionId).toBeUndefined();
    expect(b.info.resumeSessionId).toBe('prev-uuid');
    expect(b.info.mode).toBe('resume');
  });

  it('kills a process and emits exit + status=dead, but stays in manager', async () => {
    const session = spawnCreated(mgr,{
      ...baseSpawn,
      command: 'sh',
      args: ['-c', 'sleep 60'],
    });
    const exited = new Promise<void>((resolve) => {
      session.on('exit', () => resolve());
    });
    const statusDead = new Promise<void>((resolve) => {
      session.on('status', ({ state }) => {
        if (state === 'dead') resolve();
      });
    });
    await session.kill();
    await Promise.all([exited, statusDead]);
    expect(session.state).toBe('dead');
    // Dead row migrates to the dead-stub map;
    // findRow/list still surface it so DELETE stays idempotent.
    expect(mgr.get(session.info.id)).toBeUndefined();
    expect(mgr.findRow(session.info.id)?.state).toBe('dead');
    expect(mgr.getDeadStub(session.info.id)?.info.id).toBe(session.info.id);
    expect(session.deletedAt).toBeNull();
  });

  it('markDeleted sets deletedAt, kills the PTY, and is idempotent', async () => {
    const session = spawnCreated(mgr,{
      ...baseSpawn,
      command: 'sh',
      args: ['-c', 'sleep 60'],
    });
    expect(session.deletedAt).toBeNull();

    session.markDeleted();
    const t1 = session.deletedAt;
    expect(t1).not.toBeNull();

    // Second call is a no-op (timestamp does not move).
    session.markDeleted();
    expect(session.deletedAt).toBe(t1);

    // PTY is being torn down.
    await new Promise<void>((resolve) => session.on('exit', () => resolve()));
    expect(session.state).toBe('dead');
  });

  it('listActive excludes deleted sessions; list includes all', async () => {
    const a = spawnCreated(mgr,{ ...baseSpawn, command: 'sh', args: ['-c', 'sleep 60'] });
    const b = spawnCreated(mgr,{ ...baseSpawn, command: 'sh', args: ['-c', 'sleep 60'] });
    a.markDeleted();
    expect(mgr.listActive().map((s) => s.info.id)).toEqual([b.info.id]);
    expect(mgr.list().map((s) => s.info.id).sort()).toEqual(
      [a.info.id, b.info.id].sort(),
    );
  });

  describe('GC of soft-deleted sessions', () => {
    it('keeps deleted sessions before ttl elapses', () => {
      const tiny = new SessionManager({ deletedSessionTtlMs: 60_000 });
      const a = spawnCreated(tiny,{ ...baseSpawn, command: 'sh', args: ['-c', 'sleep 60'] });
      a.markDeleted();
      const deletedAt = a.deletedAt;
      expect(deletedAt).not.toBeNull();
      tiny.gc(deletedAt! + 30_000);
      expect(tiny.get(a.info.id)?.info.id).toBe(a.info.id);
    });

    it('removes deleted sessions once ttl elapses', () => {
      const tiny = new SessionManager({ deletedSessionTtlMs: 60_000 });
      const a = spawnCreated(tiny,{ ...baseSpawn, command: 'sh', args: ['-c', 'sleep 60'] });
      a.markDeleted();
      const deletedAt = a.deletedAt;
      tiny.gc(deletedAt! + 60_001);
      expect(tiny.get(a.info.id)).toBeUndefined();
      expect(tiny.list().map((s) => s.info.id)).not.toContain(a.info.id);
    });

    it('never collects sessions that were not deleted', () => {
      const tiny = new SessionManager({ deletedSessionTtlMs: 60_000 });
      const live = spawnCreated(tiny,{ ...baseSpawn, command: 'sh', args: ['-c', 'sleep 60'] });
      tiny.gc(Date.now() + 365 * 24 * 60 * 60 * 1000);
      expect(tiny.get(live.info.id)?.info.id).toBe(live.info.id);
    });

    it('list() opportunistically triggers gc', () => {
      const tiny = new SessionManager({ deletedSessionTtlMs: 1 });
      const a = spawnCreated(tiny,{ ...baseSpawn, command: 'sh', args: ['-c', 'sleep 60'] });
      a.markDeleted();
      // wait beyond ttl, then list should trigger gc internally.
      const before = a.deletedAt!;
      // Force the perceived "now" to be far in the future by directly mutating deletedAt
      // is not possible (readonly via interface); instead we drive via a small ttl + busy wait.
      const start = Date.now();
       
      while (Date.now() - start < 5) {}
      void before;
      const ids = tiny.list().map((s) => s.info.id);
      expect(ids).not.toContain(a.info.id);
    });
  });

  it('resize accepts valid sizes and rejects non-positive', () => {
    const session = spawnCreated(mgr,{
      ...baseSpawn,
      command: 'sh',
      args: ['-c', 'sleep 30'],
    });
    expect(() => session.resize(120, 40)).not.toThrow();
    expect(() => session.resize(0, 40)).toThrow(RangeError);
    expect(() => session.resize(80, -1)).toThrow(RangeError);
  });

  it('scrollback respects byte limit while writing fast output', async () => {
    const session = spawnCreated(mgr,{
      ...baseSpawn,
      scrollbackBytes: 2048,
      command: 'sh',
      args: ['-c', 'awk \'BEGIN{ for(i=0;i<6000;i++) printf "a" }\'; sleep 30'],
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for scrollback >= 2048')), 8000);
      const stop = session.on('data', () => {
        if (session.scrollback.bytes >= 2048) {
          clearTimeout(timer);
          stop();
          resolve();
        }
      });
    });
    expect(session.scrollback.bytes).toBeLessThanOrEqual(2048);
  });

  it('setState fires status events but ignores transitions from dead', async () => {
    const session = spawnCreated(mgr,{
      ...baseSpawn,
      command: 'sh',
      args: ['-c', 'sleep 30'],
    });
    const states: string[] = [];
    session.on('status', ({ state }) => states.push(state));
    session.setState('busy');
    session.setState('busy'); // no-op (same)
    session.setState('idle');
    expect(states).toEqual(['busy', 'idle']);

    await session.kill();
    states.length = 0;
    session.setState('idle');
    expect(states).toEqual([]);
  });

  it('list keeps dead sessions (so DELETE stays idempotent)', async () => {
    const a = spawnCreated(mgr,{ ...baseSpawn, command: 'sh', args: ['-c', 'sleep 30'] });
    const b = spawnCreated(mgr,{ ...baseSpawn, command: 'sh', args: ['-c', 'sleep 30'] });
    expect(mgr.list().map((s) => s.info.id).sort()).toEqual([a.info.id, b.info.id].sort());
    await a.kill();
    expect(mgr.list().map((s) => s.info.id).sort()).toEqual([a.info.id, b.info.id].sort());
    expect(a.state).toBe('dead');
    expect(a.deletedAt).toBeNull();
  });

  describe('resume singleton', () => {
    const resumeOpts = (resumeSessionId: string): SpawnOptions => ({
      ...baseSpawn,
      mode: 'resume' as const,
      resumeSessionId,
      command: 'sh',
      args: ['-c', 'sleep 30'],
    });

    it('second resume of the same cc-X attaches to the existing web-session', () => {
      const first = mgr.spawn(resumeOpts('cc-X'));
      expect(first.kind).toBe('created');
      if (first.kind !== 'created') throw new Error('unreachable');
      const w1Id = first.session.info.id;

      const second = mgr.spawn(resumeOpts('cc-X'));
      expect(second.kind).toBe('attached');
      if (second.kind !== 'attached') throw new Error('unreachable');
      expect(second.existingId).toBe(w1Id);
      // No second cc process spawned — list still has one entry.
      expect(mgr.list()).toHaveLength(1);
    });

    it('after PTY exit the lock releases and a fresh resume spawns new', async () => {
      const first = mgr.spawn(resumeOpts('cc-Y'));
      if (first.kind !== 'created') throw new Error('unreachable');
      const w1Id = first.session.info.id;

      const exited = new Promise<void>((resolve) =>
        first.session.on('exit', () => resolve()),
      );
      await first.session.kill();
      await exited;

      const second = mgr.spawn(resumeOpts('cc-Y'));
      expect(second.kind).toBe('created');
      if (second.kind !== 'created') throw new Error('unreachable');
      expect(second.session.info.id).not.toBe(w1Id);
    });

    it('create mode never touches resume lock', () => {
      const first = mgr.spawn({
        ...baseSpawn,
        mode: 'create',
        command: 'sh',
        args: ['-c', 'sleep 30'],
      });
      expect(first.kind).toBe('created');
      // A subsequent resume of any cc-X must still spawn (no spurious lock).
      const second = mgr.spawn(resumeOpts('cc-Z'));
      expect(second.kind).toBe('created');
    });

    it('markDeleted clears stale lock synchronously on next resume', () => {
      const first = mgr.spawn(resumeOpts('cc-W'));
      if (first.kind !== 'created') throw new Error('unreachable');
      const w1Id = first.session.info.id;

      // markDeleted sets deletedAt + triggers async kill, but the exit
      // listener has not fired yet — without the active-check guard, the
      // second spawn would attach to a dying session.
      first.session.markDeleted();
      expect(first.session.deletedAt).not.toBeNull();
      // Same synchronous task, do NOT await exit:
      const second = mgr.spawn(resumeOpts('cc-W'));
      expect(second.kind).toBe('created');
      if (second.kind !== 'created') throw new Error('unreachable');
      expect(second.session.info.id).not.toBe(w1Id);
    });

    it('stale exit listener does not wipe new owner of the same lock', async () => {
      const first = mgr.spawn(resumeOpts('cc-V'));
      if (first.kind !== 'created') throw new Error('unreachable');
      const w1 = first.session;

      // Simulate the markDeleted-immediate-respawn race: spawn a new
      // resume(cc-V) before the first PTY actually exits. Stale-lock
      // cleanup inside spawn drops the old entry; the new spawn re-claims it.
      w1.markDeleted();
      const second = mgr.spawn(resumeOpts('cc-V'));
      if (second.kind !== 'created') throw new Error('unreachable');
      const w2 = second.session;
      expect(w2.info.id).not.toBe(w1.info.id);

      // Now the first PTY finally exits — its listener must NOT touch the
      // lock, since it now points at w2.
      await new Promise<void>((resolve) => w1.on('exit', () => resolve()));

      // Verify: a third resume(cc-V) still attaches to w2 (lock intact).
      const third = mgr.spawn(resumeOpts('cc-V'));
      expect(third.kind).toBe('attached');
      if (third.kind !== 'attached') throw new Error('unreachable');
      expect(third.existingId).toBe(w2.info.id);
    });
  });
});
