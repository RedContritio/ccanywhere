import { existsSync, watch, type FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';
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
}

/**
 * m-quota-inline: per-session jsonl fs.watch that recomputes ccusage and
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
  private readonly entries = new Map<string, WatchEntry>();

  constructor(opts: QuotaWatcherOptions) {
    this.userStore = opts.userStore;
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
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

    const jsonlPath = ccJsonlPathOf(session.info.cwd, ccSessionIdOf(session));
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
