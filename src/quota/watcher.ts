import { existsSync, watch, type FSWatcher } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { logger } from '../log.js';
import type { Session } from '../session/manager.js';
import type { UserStore } from '../users/store.js';
import { ccusageCalc } from './ccusage.js';
import { ccJsonlPathOf } from './path.js';

/**
 * Default debounce window (ms). cc batches jsonl appends; multiple writes
 * within this window collapse to a single ccusageCalc + setQuotaUsage.
 */
const DEFAULT_DEBOUNCE_MS = 500;

/** cc-internal session id for jsonl path derivation (resume reuses cc id). */
function ccSessionIdOf(session: Session): string {
  return session.info.resumeSessionId ?? session.info.id;
}

interface WatchEntry {
  readonly sessionId: string;
  readonly userId: string;
  readonly jsonlPath: string;
  readonly watcher: FSWatcher;
  timer: NodeJS.Timeout | null;
}

export interface QuotaWatcherOptions {
  readonly userStore: UserStore;
  /** Debounce window in ms; defaults to 500. */
  readonly debounceMs?: number;
  /**
   *  D5: per-user effective runtime map (from
   * resolveIsolation). When set, `start(session)` looks up the user's
   * runtime and points the watcher at `<userClaudeRoot>/<username>/
   * projects/...` for `shared-container` users instead of the owner's
   * `~/.claude/projects/...`. host runtime users + missing map → legacy
   * homedir behavior (owner spawn lands jsonl in owner home).
   */
  readonly perUserRuntime?: ReadonlyMap<string, 'host' | 'shared-container'>;
  /**
   *  D5: host root that maps to per-user
   * `~/.claude` for container users. Required when perUserRuntime maps
   * any user to 'shared-container'; ignored otherwise.
   */
  readonly userClaudeRoot?: string;
  /**
   *  B24 fix: container-internal mount point
   * of hostWorkspace. cc inside container sees cwd at
   * `<containerWorkspacePath>/<rel>` and encodes that path into its
   * jsonl directory name. Watcher must translate `session.info.cwd`
   * (host) → container cwd before calling ccJsonlPathOf, otherwise it
   * watches a non-existent dir while cc writes to the real one.
   */
  readonly hostWorkspace?: string;
  readonly containerWorkspacePath?: string;
}

/**
 * per-session jsonl fs.watch that recomputes ccusage and
 * writes `user.quota.used` whenever cc appends to its jsonl. Replaces the
 * hook回环 path where cc had to curl back into ccanywhere on every
 * UserPromptSubmit. owner kind sessions are skipped (no watcher allocated)
 * because owner has no quota limit.
 *
 * The watcher debounces multiple writes within `debounceMs` to a single
 * recompute — cc may flush partial lines and we want to avoid recomputing
 * mid-write.
 */
export class QuotaWatcher {
  private readonly userStore: UserStore;
  private readonly debounceMs: number;
  private readonly perUserRuntime:
    | ReadonlyMap<string, 'host' | 'shared-container'>
    | undefined;
  private readonly userClaudeRoot: string | undefined;
  private readonly hostWorkspace: string | undefined;
  private readonly containerWorkspacePath: string | undefined;
  private readonly entries = new Map<string, WatchEntry>();

  constructor(opts: QuotaWatcherOptions) {
    this.userStore = opts.userStore;
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.perUserRuntime = opts.perUserRuntime;
    this.userClaudeRoot = opts.userClaudeRoot;
    this.hostWorkspace = opts.hostWorkspace;
    this.containerWorkspacePath = opts.containerWorkspacePath;
  }

  /**
   * Begin watching `session`'s jsonl path. Idempotent — calling twice for
   * the same sessionId is a no-op (the existing watcher is kept).
   * owner kind: early-return, no fs.watch allocated.
   */
  start(session: Session): void {
    const sessionId = session.info.id;
    if (this.entries.has(sessionId)) return;

    const user = this.userStore.findById(session.info.userId);
    if (user === null) return; // legacy / no-user session
    if (user.kind === 'owner') return; // owner has null limits — no enforcement

    const effectiveRuntime = this.perUserRuntime?.get(user.username) ?? 'host';
    const isShared = effectiveRuntime === 'shared-container';
    const claudeRoot =
      isShared && this.userClaudeRoot !== undefined
        ? join(this.userClaudeRoot, user.username)
        : undefined;
    //  B24 fix: shared-container cc writes
    // jsonl under encoded container cwd, not host cwd. Translate
    // session.info.cwd → container path via D9 amendment workspace
    // mount mapping.
    let effectiveCwd = session.info.cwd;
    if (
      isShared &&
      this.hostWorkspace !== undefined &&
      this.containerWorkspacePath !== undefined
    ) {
      const rel = relative(this.hostWorkspace, session.info.cwd);
      if (!rel.startsWith('..')) {
        effectiveCwd = join(this.containerWorkspacePath, rel);
      }
    }
    const jsonlPath = ccJsonlPathOf(
      effectiveCwd,
      ccSessionIdOf(session),
      claudeRoot,
    );
    const dir = dirname(jsonlPath);
    const name = basename(jsonlPath);

    // Watch the parent directory because the jsonl file may not exist yet
    // at spawn time — cc creates it on first prompt. fs.watch on a not-yet-
    // existing file throws ENOENT; watching the dir + filename filter works
    // across both "exists" and "yet-to-be-created" cases.
    if (!existsSync(dir)) {
      logger.warn(
        { sessionId, dir },
        'QuotaWatcher: cc projects dir missing; skipping watch (quota will not refresh until dir exists)',
      );
      return;
    }

    let watcher: FSWatcher;
    try {
      watcher = watch(dir, (_event, filename) => {
        if (filename !== name) return;
        this.schedule(sessionId);
      });
    } catch (err) {
      logger.warn(
        { sessionId, dir, err: (err as Error).message },
        'QuotaWatcher: fs.watch failed; quota will not refresh for this session',
      );
      return;
    }

    this.entries.set(sessionId, {
      sessionId,
      userId: user.id,
      jsonlPath,
      watcher,
      timer: null,
    });
  }

  /** Stop watching `sessionId`. Idempotent. */
  stop(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (entry === undefined) return;
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
    }
    try {
      entry.watcher.close();
    } catch {
      // best-effort
    }
    this.entries.delete(sessionId);
  }

  /** Close every active watcher (server shutdown). */
  closeAll(): void {
    for (const sessionId of [...this.entries.keys()]) {
      this.stop(sessionId);
    }
  }

  /**
   * Immediately recompute quota for `sessionId`, bypassing the debounce
   * window. Useful in tests that need a synchronization point; not used
   * on the hot path.
   */
  async flush(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (entry === undefined) return;
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    await this.recompute(entry);
  }

  private schedule(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (entry === undefined) return;
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void this.recompute(entry);
    }, this.debounceMs);
  }

  private async recompute(entry: WatchEntry): Promise<void> {
    const user = this.userStore.findById(entry.userId);
    if (user === null) return;
    if (!existsSync(entry.jsonlPath)) return; // file not flushed yet
    try {
      const usage = await ccusageCalc(entry.jsonlPath, user.createdAt);
      this.userStore.setQuotaUsage(user.id, usage.costUsd, usage.totalTokens);
    } catch (err) {
      logger.warn(
        { sessionId: entry.sessionId, err: (err as Error).message },
        'QuotaWatcher: recompute failed',
      );
    }
  }
}
