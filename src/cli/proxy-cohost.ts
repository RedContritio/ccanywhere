import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';

export interface SpawnLike {
  readonly pid: number | undefined;
  kill(signal: NodeJS.Signals): boolean;
  on(
    event: 'exit',
    cb: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): SpawnLike;
}

export type SpawnImpl = (cmd: string, args: readonly string[]) => SpawnLike;

function adaptChild(proc: ChildProcess): SpawnLike {
  const adapter: SpawnLike = {
    pid: proc.pid,
    kill(sig) {
      return proc.kill(sig);
    },
    on(_event, cb) {
      proc.on('exit', cb);
      return adapter;
    },
  };
  return adapter;
}

function makeDefaultSpawn(logPath: string): SpawnImpl {
  return (cmd, args) => {
    const fd = openSync(logPath, 'a', 0o600);
    try {
      const proc = nodeSpawn(cmd, [...args], {
        stdio: ['ignore', fd, fd],
      });
      return adaptChild(proc);
    } finally {
      // Parent closes its copy after spawn dup'd the fd into the child.
      closeSync(fd);
    }
  };
}

export interface ProxyCohostOpts {
  readonly cliBinPath: string;
  readonly configPath: string;
  readonly logPath: string;
  readonly spawnImpl?: SpawnImpl;
  readonly setTimeoutImpl?: (cb: () => void, ms: number) => NodeJS.Timeout;
  readonly backoffSequence?: readonly number[];
  readonly shutdownGraceMs?: number;
  /**
   * Stop respawning after this many cumulative crashes; the supervisor
   * gives up and the proxy stays down (logged). main keeps running so
   * owner host paths still work. Default 5.
   */
  readonly maxCrashesInWindow?: number;
}

export interface ProxyCohostHandle {
  shutdown(): Promise<void>;
}

const DEFAULT_BACKOFF: readonly number[] = [1000, 2000, 5000, 10_000, 30_000];

export function startProxyCohost(opts: ProxyCohostOpts): ProxyCohostHandle {
  const spawn = opts.spawnImpl ?? makeDefaultSpawn(opts.logPath);
  const setTimeoutFn: NonNullable<ProxyCohostOpts['setTimeoutImpl']> =
    opts.setTimeoutImpl ?? ((cb, ms) => setTimeout(cb, ms));
  const backoff = opts.backoffSequence ?? DEFAULT_BACKOFF;

  const args: readonly string[] = [
    opts.cliBinPath,
    'proxy',
    'serve',
    '--config',
    opts.configPath,
  ];

  let shuttingDown = false;
  let crashIndex = 0;
  let child: SpawnLike;

  const maxCrashes = opts.maxCrashesInWindow ?? 5;

  const spawnOne = (): void => {
    child = spawn('node', args);
    child.on('exit', () => {
      if (shuttingDown) return;
      const delay =
        backoff[Math.min(crashIndex, backoff.length - 1)] ??
        backoff[backoff.length - 1]!;
      crashIndex++;
      if (crashIndex >= maxCrashes) {
        // too many crashes — give up. main process keeps running so
        // owner host paths still work; proxy stays down until main
        // restart.
        return;
      }
      setTimeoutFn(spawnOne, delay);
    });
  };
  spawnOne();

  const graceMs = opts.shutdownGraceMs ?? 5000;

  return {
    shutdown() {
      shuttingDown = true;
      return new Promise<void>((resolve) => {
        child.on('exit', () => resolve());
        child.kill('SIGTERM');
        // After grace, escalate to SIGKILL. If the child has already
        // exited, this kill returns false (ESRCH) without throwing.
        setTimeoutFn(() => child.kill('SIGKILL'), graceMs);
      });
    },
  };
}
