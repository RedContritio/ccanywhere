import { randomUUID } from 'node:crypto';
import { spawn as ptySpawn } from 'node-pty';
import { logger } from '../log.js';
import { ScreenState } from './screen-state.js';
import { Scrollback } from './scrollback.js';
import { SessionImpl } from './session-impl.js';
import type { Session, SessionInfo, SessionMode } from './types.js';

export type { Session } from './types.js';

export interface SpawnOptions {
  readonly projectId: string;
  readonly cwd: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cols?: number;
  readonly rows?: number;
  readonly env?: Readonly<Record<string, string>>;
  readonly scrollbackBytes: number;
  readonly mode: SessionMode;
  readonly resumeSessionId?: string;
  /** m-multi-user: User.id that owns this PTY session. */
  readonly userId: string;
  /**
   * #46 quota: caller-provided session id, threaded both into SessionInfo.id
   * and into the cc CLI via `--session-id <uuid>` (caller is responsible for
   * adding that flag to `args`). When set, cc writes its jsonl as
   * `<id>.jsonl` matching ccanywhere's session id, so quota check can
   * derive the jsonl path without ambiguity. Tests using non-cc binaries
   * (e.g. `sh`) MUST NOT pass this — manager falls back to randomUUID.
   */
  readonly forcedSessionId?: string;
}

/**
 * Discriminated result of `SessionManager.spawn`. `attached` means a prior
 * web-session is already alive for the same cc resumeSessionId — caller
 * should idempotently return that existing session row instead of treating
 * this as a "new" creation. Without this guard, two cc processes end up
 * writing the same `~/.claude/projects/<cwd>/<X>.jsonl` and the history
 * file is corrupted (anthropics/claude-code#26964).
 */
export type SpawnResult =
  | { readonly kind: 'created'; readonly session: Session }
  | { readonly kind: 'attached'; readonly existingId: string };

function buildEnv(extra: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') out[k] = v;
  }
  if (extra) {
    for (const [k, v] of Object.entries(extra)) out[k] = v;
  }
  return out;
}

export interface SessionManagerOptions {
  /**
   * Time after `deletedAt` a soft-deleted session is physically removed from the
   * manager's map. Defaults to 10 minutes. GC runs opportunistically on spawn / list calls.
   */
  readonly deletedSessionTtlMs?: number;
}

const DEFAULT_DELETED_TTL_MS = 10 * 60 * 1000;

export class SessionManager {
  private readonly sessions = new Map<string, SessionImpl>();
  // Tracks which cc resumeSessionId is currently being driven by which
  // active web-session. Same cc-X MUST NOT have two concurrent cc
  // processes — they'd interleave jsonl writes (anthropics/claude-code#26964).
  // Map can briefly hold stale entries during the markDeleted → kill →
  // exit window; spawn() rechecks the candidate is still active before
  // honoring an attach, so stale entries never leak to callers.
  private readonly _activeResumeTargets = new Map<string, string>();
  private readonly deletedSessionTtlMs: number;

  constructor(options: SessionManagerOptions = {}) {
    this.deletedSessionTtlMs = options.deletedSessionTtlMs ?? DEFAULT_DELETED_TTL_MS;
    if (this.deletedSessionTtlMs <= 0) {
      throw new RangeError(
        `deletedSessionTtlMs must be positive, got ${this.deletedSessionTtlMs}`,
      );
    }
  }

  spawn(opts: SpawnOptions): SpawnResult {
    this.gc(Date.now());

    // Idempotent attach: if cc-X is already being driven by an active
    // web-session, hand the caller that webSessionId instead of spawning
    // a second cc process for the same jsonl history file.
    if (opts.mode === 'resume' && opts.resumeSessionId !== undefined) {
      const existingId = this._activeResumeTargets.get(opts.resumeSessionId);
      if (existingId !== undefined) {
        const existing = this.sessions.get(existingId);
        if (
          existing !== undefined &&
          existing.deletedAt === null &&
          existing.state !== 'dead'
        ) {
          return { kind: 'attached', existingId };
        }
        // Stale: candidate has been deleted or its PTY has exited but the
        // exit listener hasn't fired yet. Drop the stale entry and fall through.
        this._activeResumeTargets.delete(opts.resumeSessionId);
      }
    }

    const id = opts.forcedSessionId ?? randomUUID();
    const cols = opts.cols ?? 100;
    const rows = opts.rows ?? 30;

    // Inherit parent process environment (HOME, PATH, …) so cc reads
    // ~/.claude/ for auth + settings. MUST NOT override CLAUDE_CONFIG_DIR
    // — earlier auto-injection (M5) shadowed user auth.
    const env = buildEnv(opts.env);

    const pty = ptySpawn(opts.command, [...opts.args], {
      cwd: opts.cwd,
      cols,
      rows,
      env,
      name: 'xterm-256color',
    });

    const info: SessionInfo =
      opts.resumeSessionId === undefined
        ? {
            id,
            projectId: opts.projectId,
            cwd: opts.cwd,
            mode: opts.mode,
            createdAt: Date.now(),
            userId: opts.userId,
          }
        : {
            id,
            projectId: opts.projectId,
            cwd: opts.cwd,
            mode: opts.mode,
            resumeSessionId: opts.resumeSessionId,
            createdAt: Date.now(),
            userId: opts.userId,
          };

    const session = new SessionImpl(
      info,
      pty,
      new Scrollback(opts.scrollbackBytes),
      new ScreenState(cols, rows),
    );
    this.sessions.set(id, session);

    if (opts.mode === 'resume' && opts.resumeSessionId !== undefined) {
      const lockKey = opts.resumeSessionId;
      this._activeResumeTargets.set(lockKey, id);
      // Identity check on release: if same lockKey was reclaimed by a newer
      // web-session, this stale exit must not wipe the new owner's entry.
      session.on('exit', () => {
        if (this._activeResumeTargets.get(lockKey) === id) {
          this._activeResumeTargets.delete(lockKey);
        }
      });
    }

    session.setState('idle');
    logger.debug(
      {
        sessionId: id,
        projectId: info.projectId,
        cwd: opts.cwd,
        mode: opts.mode,
        resumeSessionId: opts.resumeSessionId ?? null,
        cols,
        rows,
        envOverrides: Object.keys(opts.env ?? {}),
      },
      'session spawned',
    );

    return { kind: 'created', session };
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  list(): Session[] {
    this.gc(Date.now());
    return [...this.sessions.values()];
  }

  listActive(): Session[] {
    this.gc(Date.now());
    return [...this.sessions.values()].filter((s) => s.deletedAt === null);
  }

  /**
   * Remove soft-deleted sessions whose deletedAt + ttl has elapsed.
   * `now` is injectable for tests; production callers pass Date.now().
   */
  gc(now: number): void {
    const ttl = this.deletedSessionTtlMs;
    for (const [id, s] of this.sessions) {
      if (s.deletedAt !== null && s.deletedAt + ttl < now) {
        this.sessions.delete(id);
      }
    }
  }

  async killAll(): Promise<void> {
    await Promise.all(this.list().map((s) => s.kill()));
  }
}
