import type { Session, SessionMode } from './types.js';
import type { SessionRegistry } from './registry.js';

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
  /** : User.id that owns this PTY session. */
  readonly userId: string;
  /**
   * #46 quota: caller-provided session id, threaded both into SessionInfo.id
   * and into the cc CLI via `--session-id <uuid>` (caller is responsible for
   * adding that flag to `args`). When set, cc writes its jsonl as
   * `<id>.jsonl` matching ccanywhere's session id, so quota check can
   * derive the jsonl path without ambiguity. Tests using non-cc binaries
   * (e.g. `sh`) MUST NOT pass this — manager falls back to randomUUID.
   *
   * also used by `resumeDeadStub` to reuse the
   * original ccanywhere id (and thus the original cc jsonl).
   */
  readonly forcedSessionId?: string;
  /**
   * runtime sandbox.
   * - `host` (default, omitted = host): spawn `command` directly via
   * node-pty (owner path + admin-trusted multi-user)
   * - `shared-container`: wrap spawn as `docker exec -it -u <user>
   * -e KEY=VAL ... <container.name> <command> ...args`. caller
   * (sessions.ts) sources from user.runtime config + a live
   * SharedContainerManager + ContainerUserSync
   *
   * When `shared-container`, `container` MUST be set.
   */
  readonly runtime?: 'host' | 'shared-container';
  /**
   * Required when `runtime === 'shared-container'`. caller is
   * responsible for ensuring the container is running (shared-
   * manager.ensureRunning) and the unix user exists in it
   * (user-sync.ensureUser) BEFORE calling spawn.
   */
  readonly container?: {
    readonly name: string;
    readonly unixUser: string;
    /**
     * Container-internal cwd for `docker exec -w <path>`. caller
     * (session-runtime) computes by translating host project.cwd via
     * SessionContainerDeps.hostWorkspace mount path. Without this,
     * claude lands in container WORKDIR (/) and can't see project files.
     */
    readonly workingDir?: string;
  };
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

/**
 * optional per-session lifecycle observer, decoupled
 * from QuotaWatcher class via this interface so SessionManager doesn't
 * import the quota module. Manager calls `start` after spawn /
 * resumeDeadStub, and `stop` on PTY exit + markDeleted teardown. Used
 * for jsonl fs.watch → setQuotaUsage refresh; future observers (e.g.
 * audit log, metrics) can plug in via the same shape.
 */
export interface SessionLifecycleObserver {
  start(session: Session): void;
  stop(sessionId: string): void;
}

export interface SessionManagerOptions {
  /**
   * Time after `deletedAt` a soft-deleted session is physically removed
   * from the manager's map. Defaults to 10 minutes. GC runs
   * opportunistically on spawn / list calls.
   */
  readonly deletedSessionTtlMs?: number;
  /**
   * Optional disk persistence. When set, spawn/markDeleted/exit/gc all
   * write to disk so the next `loadDeadStubs` can recover the session
   * list. Tests with no persistence needs
   * leave this undefined.
   */
  readonly registry?: SessionRegistry;
  /**
   * Optional per-session lifecycle observer. When set,
   * `start(session)` fires after each successful spawn and `stop(id)`
   * fires on PTY exit and on markDeleted teardown.
   */
  readonly lifecycleObserver?: SessionLifecycleObserver;
}

export function buildEnv(
  extra: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') out[k] = v;
  }
  if (extra) {
    for (const [k, v] of Object.entries(extra)) out[k] = v;
  }
  return out;
}
