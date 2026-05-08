import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionManager, type SpawnOptions } from './manager.js';

const baseSpawn: Omit<SpawnOptions, 'command' | 'args'> = {
  projectId: 'demo',
  cwd: process.cwd(),
  scrollbackBytes: 4096,
  mode: 'fresh',
};

describe('SessionManager', () => {
  let mgr: SessionManager;

  beforeEach(() => {
    mgr = new SessionManager();
  });

  afterEach(async () => {
    await mgr.killAll();
  });

  it('spawns a process and emits data events', async () => {
    const session = mgr.spawn({
      ...baseSpawn,
      command: 'sh',
      args: ['-c', 'echo hello-world; sleep 30'],
    });
    expect(session.info.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(session.info.mode).toBe('fresh');
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
    const a = mgr.spawn({ ...baseSpawn, command: 'sh', args: ['-c', 'sleep 30'] });
    const b = mgr.spawn({
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
    const session = mgr.spawn({
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
    // Session is preserved (not removed) so DELETE is idempotent.
    expect(mgr.get(session.info.id)?.state).toBe('dead');
    expect(session.deletedAt).toBeNull();
  });

  it('markDeleted sets deletedAt, kills the PTY, and is idempotent', async () => {
    const session = mgr.spawn({
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
    const a = mgr.spawn({ ...baseSpawn, command: 'sh', args: ['-c', 'sleep 60'] });
    const b = mgr.spawn({ ...baseSpawn, command: 'sh', args: ['-c', 'sleep 60'] });
    a.markDeleted();
    expect(mgr.listActive().map((s) => s.info.id)).toEqual([b.info.id]);
    expect(mgr.list().map((s) => s.info.id).sort()).toEqual(
      [a.info.id, b.info.id].sort(),
    );
  });

  describe('GC of soft-deleted sessions', () => {
    it('keeps deleted sessions before ttl elapses', () => {
      const tiny = new SessionManager({ deletedSessionTtlMs: 60_000 });
      const a = tiny.spawn({ ...baseSpawn, command: 'sh', args: ['-c', 'sleep 60'] });
      a.markDeleted();
      const deletedAt = a.deletedAt;
      expect(deletedAt).not.toBeNull();
      tiny.gc(deletedAt! + 30_000);
      expect(tiny.get(a.info.id)?.info.id).toBe(a.info.id);
    });

    it('removes deleted sessions once ttl elapses', () => {
      const tiny = new SessionManager({ deletedSessionTtlMs: 60_000 });
      const a = tiny.spawn({ ...baseSpawn, command: 'sh', args: ['-c', 'sleep 60'] });
      a.markDeleted();
      const deletedAt = a.deletedAt;
      tiny.gc(deletedAt! + 60_001);
      expect(tiny.get(a.info.id)).toBeUndefined();
      expect(tiny.list().map((s) => s.info.id)).not.toContain(a.info.id);
    });

    it('never collects sessions that were not deleted', () => {
      const tiny = new SessionManager({ deletedSessionTtlMs: 60_000 });
      const live = tiny.spawn({ ...baseSpawn, command: 'sh', args: ['-c', 'sleep 60'] });
      tiny.gc(Date.now() + 365 * 24 * 60 * 60 * 1000);
      expect(tiny.get(live.info.id)?.info.id).toBe(live.info.id);
    });

    it('list() opportunistically triggers gc', () => {
      const tiny = new SessionManager({ deletedSessionTtlMs: 1 });
      const a = tiny.spawn({ ...baseSpawn, command: 'sh', args: ['-c', 'sleep 60'] });
      a.markDeleted();
      // wait beyond ttl, then list should trigger gc internally.
      const before = a.deletedAt!;
      // Force the perceived "now" to be far in the future by directly mutating deletedAt
      // is not possible (readonly via interface); instead we drive via a small ttl + busy wait.
      const start = Date.now();
      // eslint-disable-next-line no-empty
      while (Date.now() - start < 5) {}
      void before;
      const ids = tiny.list().map((s) => s.info.id);
      expect(ids).not.toContain(a.info.id);
    });
  });

  it('resize accepts valid sizes and rejects non-positive', () => {
    const session = mgr.spawn({
      ...baseSpawn,
      command: 'sh',
      args: ['-c', 'sleep 30'],
    });
    expect(() => session.resize(120, 40)).not.toThrow();
    expect(() => session.resize(0, 40)).toThrow(RangeError);
    expect(() => session.resize(80, -1)).toThrow(RangeError);
  });

  it('scrollback respects byte limit while writing fast output', async () => {
    const session = mgr.spawn({
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
    const session = mgr.spawn({
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
    const a = mgr.spawn({ ...baseSpawn, command: 'sh', args: ['-c', 'sleep 30'] });
    const b = mgr.spawn({ ...baseSpawn, command: 'sh', args: ['-c', 'sleep 30'] });
    expect(mgr.list().map((s) => s.info.id).sort()).toEqual([a.info.id, b.info.id].sort());
    await a.kill();
    expect(mgr.list().map((s) => s.info.id).sort()).toEqual([a.info.id, b.info.id].sort());
    expect(a.state).toBe('dead');
    expect(a.deletedAt).toBeNull();
  });
});
