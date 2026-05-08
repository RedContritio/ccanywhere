import { afterEach, describe, expect, it } from 'vitest';
import { SessionManager, type SpawnOptions } from './manager.js';

const baseSpawn: Omit<SpawnOptions, 'command' | 'args'> = {
  projectId: 'demo',
  cwd: process.cwd(),
  scrollbackBytes: 4096,
  mode: 'fresh',
};

describe('SessionManager', () => {
  const mgr = new SessionManager();

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

  it('kills a process and emits exit + status=dead', async () => {
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
    expect(mgr.get(session.info.id)).toBeUndefined();
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

  it('list returns active sessions only', async () => {
    const a = mgr.spawn({ ...baseSpawn, command: 'sh', args: ['-c', 'sleep 30'] });
    const b = mgr.spawn({ ...baseSpawn, command: 'sh', args: ['-c', 'sleep 30'] });
    expect(mgr.list().map((s) => s.info.id).sort()).toEqual([a.info.id, b.info.id].sort());
    await a.kill();
    expect(mgr.list().map((s) => s.info.id)).toEqual([b.info.id]);
  });
});
