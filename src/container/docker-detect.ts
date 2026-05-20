import { defaultExec, type ExecImpl } from './exec.js';

export interface DockerStatus {
  readonly available: boolean;
  /** populated when `available: false` to help log diagnostics. */
  readonly reason?: string;
}

export interface DockerDetectorOpts {
  /** Inject for tests; default real `docker` CLI via child_process. */
  readonly execImpl?: ExecImpl;
  /** Periodic health-check interval (ms). Default 30_000. */
  readonly intervalMs?: number;
  /** Inject for tests. Default global setInterval/clearInterval. */
  readonly setIntervalImpl?: (
    cb: () => void,
    ms: number,
  ) => NodeJS.Timeout | number;
  readonly clearIntervalImpl?: (h: NodeJS.Timeout | number) => void;
}

/**
 * Detects whether the host docker daemon is reachable. Used by
 * `` D6:
 *   - strict + unavailable → fatal (serve.ts decides)
 *   - fallback + unavailable → override all user.runtime → 'host'
 *   - host-only → detection skipped entirely
 *
 * `detect()` runs `docker info` (cheap, no container spawn). On-going
 * health is via `startMonitoring(onChange)` — fires the callback only
 * when status flips (not on every tick).
 */
export class DockerDetector {
  private readonly execImpl: ExecImpl;
  private readonly intervalMs: number;
  private readonly setIntervalFn: NonNullable<DockerDetectorOpts['setIntervalImpl']>;
  private readonly clearIntervalFn: NonNullable<DockerDetectorOpts['clearIntervalImpl']>;

  private timer: NodeJS.Timeout | number | null = null;
  private lastStatus: DockerStatus | null = null;

  constructor(opts: DockerDetectorOpts = {}) {
    this.execImpl = opts.execImpl ?? defaultExec;
    this.intervalMs = opts.intervalMs ?? 30_000;
    this.setIntervalFn = opts.setIntervalImpl ?? setInterval;
    this.clearIntervalFn = opts.clearIntervalImpl ?? clearInterval;
  }

  async detect(): Promise<DockerStatus> {
    const r = await this.execImpl('docker', ['info'], { timeoutMs: 5_000 });
    if (r.exitCode === 0) return { available: true };
    const firstLine = (r.stderr || r.stdout).split('\n')[0]?.trim() ?? '';
    return {
      available: false,
      reason: firstLine.length > 0 ? firstLine : `exit code ${r.exitCode}`,
    };
  }

  /**
   * Begin periodic detection. Fires `onChange` only when status
   * transitions (available ↔ unavailable), not on every poll. First
   * poll runs immediately so callers don't wait `intervalMs` for
   * initial signal.
   */
  startMonitoring(onChange: (status: DockerStatus) => void): void {
    if (this.timer !== null) return;
    const tick = async (): Promise<void> => {
      const status = await this.detect();
      if (
        this.lastStatus === null ||
        this.lastStatus.available !== status.available
      ) {
        this.lastStatus = status;
        onChange(status);
      } else {
        this.lastStatus = status;
      }
    };
    void tick();
    this.timer = this.setIntervalFn(() => void tick(), this.intervalMs);
  }

  stopMonitoring(): void {
    if (this.timer === null) return;
    this.clearIntervalFn(this.timer);
    this.timer = null;
  }
}
