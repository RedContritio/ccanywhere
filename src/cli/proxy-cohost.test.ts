import { describe, expect, it } from 'vitest';
import {
  startProxyCohost,
  type ProxyCohostOpts,
  type SpawnImpl,
  type SpawnLike,
} from './proxy-cohost.js';

interface FakeChild extends SpawnLike {
  emitExit(code: number | null, signal: NodeJS.Signals | null): void;
  killCalls: NodeJS.Signals[];
}

function mkChild(pid = 12345): FakeChild {
  const exitCbs: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  const killCalls: NodeJS.Signals[] = [];
  const child: FakeChild = {
    pid,
    kill(signal) {
      killCalls.push(signal);
      return true;
    },
    on(event, cb) {
      if (event === 'exit') exitCbs.push(cb);
      return child;
    },
    emitExit(code, signal) {
      for (const cb of exitCbs.splice(0)) cb(code, signal);
    },
    killCalls,
  };
  return child;
}

function mkSpawn(children: FakeChild[]): SpawnImpl {
  let i = 0;
  return () => {
    const c = children[i] ?? children[children.length - 1];
    if (c === undefined) throw new Error('no fake child provided');
    i++;
    return c;
  };
}

describe('startProxyCohost', () => {
  it('spawns proxy CLI subprocess on start with correct args', () => {
    const calls: Array<{ cmd: string; args: readonly string[] }> = [];
    const child = mkChild();
    const spawnImpl: SpawnImpl = (cmd, args) => {
      calls.push({ cmd, args });
      return child;
    };
    const handle = startProxyCohost({
      cliBinPath: '/path/to/dist/cli.js',
      configPath: '/path/to/config.json',
      logPath: '/tmp/proxy.log',
      spawnImpl,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual([
      '/path/to/dist/cli.js',
      'proxy',
      'serve',
      '--config',
      '/path/to/config.json',
    ]);
    // cleanup
    void handle.shutdown();
  });

  it('shutdown sends SIGTERM and waits for child to exit before resolving', async () => {
    const child = mkChild();
    const handle = startProxyCohost({
      cliBinPath: '/cli.js',
      configPath: '/cfg.json',
      logPath: '/tmp/proxy.log',
      spawnImpl: mkSpawn([child]),
    });

    let resolved = false;
    const shutdownPromise = handle.shutdown().then(() => {
      resolved = true;
    });

    // microtask flush — shutdown should have sent SIGTERM but still be
    // pending (waiting for child to exit)
    await new Promise((r) => setImmediate(r));
    expect(child.killCalls).toEqual(['SIGTERM']);
    expect(resolved).toBe(false);

    // child exits gracefully
    child.emitExit(0, 'SIGTERM');
    await shutdownPromise;
    expect(resolved).toBe(true);
  });

  it('shutdown sends SIGKILL after grace if child does not exit', async () => {
    const child = mkChild();
    const scheduled: Array<{ cb: () => void; ms: number }> = [];
    const setTimeoutImpl: NonNullable<ProxyCohostOpts['setTimeoutImpl']> = (
      cb,
      ms,
    ) => {
      scheduled.push({ cb, ms });
      return 0 as unknown as NodeJS.Timeout;
    };
    const handle = startProxyCohost({
      cliBinPath: '/cli.js',
      configPath: '/cfg.json',
      logPath: '/tmp/proxy.log',
      spawnImpl: mkSpawn([child]),
      setTimeoutImpl,
      shutdownGraceMs: 5000,
    });

    let resolved = false;
    const shutdownPromise = handle.shutdown().then(() => {
      resolved = true;
    });
    await new Promise((r) => setImmediate(r));

    expect(child.killCalls).toEqual(['SIGTERM']);
    // grace timeout scheduled
    const grace = scheduled.find((s) => s.ms === 5000);
    expect(grace).toBeDefined();

    // grace fires before child exit → SIGKILL
    grace?.cb();
    expect(child.killCalls).toEqual(['SIGTERM', 'SIGKILL']);
    expect(resolved).toBe(false);

    // child finally exits (e.g. kernel killed it)
    child.emitExit(null, 'SIGKILL');
    await shutdownPromise;
    expect(resolved).toBe(true);
  });

  it('gives up after maxCrashesInWindow consecutive crashes', () => {
    const children = [mkChild(1), mkChild(2), mkChild(3)];
    let spawnCount = 0;
    const spawnImpl: SpawnImpl = () => {
      const c = children[spawnCount];
      spawnCount++;
      if (c === undefined) throw new Error('out of fake children');
      return c;
    };
    const scheduled: Array<{ cb: () => void }> = [];
    const setTimeoutImpl: NonNullable<ProxyCohostOpts['setTimeoutImpl']> = (
      cb,
    ) => {
      scheduled.push({ cb });
      return 0 as unknown as NodeJS.Timeout;
    };

    startProxyCohost({
      cliBinPath: '/cli.js',
      configPath: '/cfg.json',
      logPath: '/tmp/proxy.log',
      spawnImpl,
      setTimeoutImpl,
      backoffSequence: [10],
      maxCrashesInWindow: 3,
    });

    expect(spawnCount).toBe(1);

    // crash 1: respawn schedule + fire
    children[0]?.emitExit(1, null);
    expect(scheduled).toHaveLength(1);
    scheduled.shift()?.cb();
    expect(spawnCount).toBe(2);

    // crash 2: respawn
    children[1]?.emitExit(1, null);
    expect(scheduled).toHaveLength(1);
    scheduled.shift()?.cb();
    expect(spawnCount).toBe(3);

    // crash 3: HIT maxCrashesInWindow → give up, no further respawn
    children[2]?.emitExit(1, null);
    expect(scheduled).toHaveLength(0);
    expect(spawnCount).toBe(3);
  });

  it('does not respawn child if it exits during shutdown', async () => {
    const child = mkChild();
    const c2 = mkChild(2);
    let spawnCount = 0;
    const spawnImpl: SpawnImpl = () => {
      spawnCount++;
      return spawnCount === 1 ? child : c2;
    };
    const setTimeoutImpl: NonNullable<ProxyCohostOpts['setTimeoutImpl']> = (
      cb,
    ) => {
      // We intentionally ignore the scheduled callback — the test should
      // not need to fire grace or respawn timers.
      void cb;
      return 0 as unknown as NodeJS.Timeout;
    };
    const handle = startProxyCohost({
      cliBinPath: '/cli.js',
      configPath: '/cfg.json',
      logPath: '/tmp/proxy.log',
      spawnImpl,
      setTimeoutImpl,
    });
    expect(spawnCount).toBe(1);

    const sd = handle.shutdown();
    // child exits in response to SIGTERM (graceful)
    child.emitExit(0, 'SIGTERM');
    await sd;

    // spawnOne's exit listener checks shuttingDown and returns; no respawn
    expect(spawnCount).toBe(1);
  });

  it('respawns child after crash, with backoff delay', () => {
    const c1 = mkChild(1001);
    const c2 = mkChild(1002);
    const spawnImpl = mkSpawn([c1, c2]);
    const scheduled: Array<{ cb: () => void; ms: number }> = [];
    const setTimeoutImpl: ProxyCohostOpts['setTimeoutImpl'] = (cb, ms) => {
      scheduled.push({ cb, ms });
      return 0 as unknown as NodeJS.Timeout;
    };
    const handle = startProxyCohost({
      cliBinPath: '/cli.js',
      configPath: '/cfg.json',
      logPath: '/tmp/proxy.log',
      spawnImpl,
      setTimeoutImpl,
      backoffSequence: [1000, 2000, 5000],
    });

    // child 1 crashes (exit code 1)
    c1.emitExit(1, null);

    // Should schedule a respawn after first backoff (1000ms), not spawn immediately
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.ms).toBe(1000);

    // Fire the scheduled respawn
    scheduled[0]?.cb();

    // child 2 should now be spawned
    expect(c2.killCalls).toEqual([]);
    expect(c1.killCalls).toEqual([]);
    // (spawn was called for c2 — implicit via mkSpawn handing out c2 on 2nd call)

    void handle.shutdown();
  });
});
