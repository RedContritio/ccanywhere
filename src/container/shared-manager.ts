import { logger } from '../log.js';
import { defaultExec, type ExecImpl } from './exec.js';

export class SharedContainerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SharedContainerError';
  }
}

export interface ContainerHealth {
  /** docker considers the container running */
  readonly running: boolean;
  /** `docker exec ... true` succeeds (process namespace responsive) */
  readonly healthy: boolean;
}

export interface SharedContainerOpts {
  /** image:tag to run, e.g. `ccanywhere/user-runtime:latest`. */
  readonly image: string;
  /** container name (per ccanywhere instance, unique). */
  readonly name: string;
  /**
   * Pass `--cap-add NET_ADMIN` so entrypoint's iptables REJECT
   * api.anthropic.com can install. Default true; tests turn off.
   */
  readonly capAddNetAdmin?: boolean;
  /**
   * Extra raw flags appended to `docker run`. Empty by default. Phase
   * 2 may add `-v <workspace>:/home/...` mounts here per call site.
   */
  readonly extraRunArgs?: readonly string[];
  /** Inject for tests; default real docker CLI. */
  readonly execImpl?: ExecImpl;
}

/**
 * Lifecycle wrapper around `ccanywhere/user-runtime` shared container.
 *
 * Idempotent. ccanywhere main server calls `ensureRunning` at boot
 * (after docker-detect says available); `stop` at shutdown. Per-
 * session spawn (`docker exec`) is — this module only owns the
 * outer container lifecycle.
 *
 * container crash recovery comes from docker's `--restart unless-
 * stopped` (set in ensureRunning) + ccanywhere `healthCheck` poll.
 * Repeated unhealthy state outside this module's concern — let
 * DockerDetector + ccanywhere serve.ts decide what to do.
 */
export class SharedContainerManager {
  private readonly image: string;
  private readonly name: string;
  private readonly capAddNetAdmin: boolean;
  private readonly extraRunArgs: readonly string[];
  private readonly exec: ExecImpl;

  constructor(opts: SharedContainerOpts) {
    this.image = opts.image;
    this.name = opts.name;
    this.capAddNetAdmin = opts.capAddNetAdmin ?? true;
    this.extraRunArgs = opts.extraRunArgs ?? [];
    this.exec = opts.execImpl ?? defaultExec;
  }

  /** Idempotent: starts when absent, no-ops when already running. */
  async ensureRunning(): Promise<void> {
    const state = await this.inspectState();
    if (state === 'running') {
      logger.debug({ ctn: this.name }, 'shared container already running');
      return;
    }
    if (state === 'exited' || state === 'created') {
      // Existing but stopped: start it back up (preserves any state in
      // /home/<user> from previous run).
      logger.info({ ctn: this.name }, 'starting existing shared container');
      const r = await this.exec('docker', ['start', this.name]);
      if (r.exitCode !== 0) {
        throw new SharedContainerError(
          `docker start ${this.name} failed: ${r.stderr}`,
        );
      }
      return;
    }
    // Not present: docker run.
    logger.info({ ctn: this.name, image: this.image }, 'creating shared container');
    const args = [
      'run',
      '-d',
      '--name',
      this.name,
      '--restart',
      'unless-stopped',
    ];
    if (this.capAddNetAdmin) {
      args.push('--cap-add', 'NET_ADMIN');
    }
    args.push(...this.extraRunArgs);
    args.push(this.image);
    const r = await this.exec('docker', args);
    if (r.exitCode !== 0) {
      throw new SharedContainerError(
        `docker run ${this.name} failed: ${r.stderr}`,
      );
    }
  }

  async stop(): Promise<void> {
    const r = await this.exec('docker', ['rm', '-f', this.name]);
    if (r.exitCode !== 0) {
      // already gone is OK
      if (/No such container/.test(r.stderr)) return;
      throw new SharedContainerError(
        `docker rm -f ${this.name} failed: ${r.stderr}`,
      );
    }
  }

  async healthCheck(): Promise<ContainerHealth> {
    const state = await this.inspectState();
    const running = state === 'running';
    if (!running) return { running: false, healthy: false };
    const r = await this.exec('docker', ['exec', this.name, 'true'], {
      timeoutMs: 3_000,
    });
    return { running: true, healthy: r.exitCode === 0 };
  }

  /**
   * Returns `'absent' | 'created' | 'running' | 'exited' | 'unknown'`.
   * `docker inspect -f '{{.State.Status}}' <name>` is canonical; if
   * container doesn't exist, exec returns non-zero.
   */
  private async inspectState(): Promise<
    'absent' | 'created' | 'running' | 'exited' | 'unknown'
  > {
    const r = await this.exec('docker', [
      'inspect',
      '-f',
      '{{.State.Status}}',
      this.name,
    ]);
    if (r.exitCode !== 0) return 'absent';
    const s = r.stdout.trim();
    if (s === 'created' || s === 'running' || s === 'exited') return s;
    return 'unknown';
  }
}
