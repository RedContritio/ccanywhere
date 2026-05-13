import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../log.js';
import type { SessionInfo } from './types.js';

/**
 * What we persist per session. Lives next to ccanywhere's other config
 * files in `<configDir>/sessions/<id>.json`. Screen snapshot for the
 * dead-state preview is stored separately as `<id>.screen.txt` because
 * it can be KB-sized (full ANSI of the last visible frame) and the
 * boot-time list path only needs metadata.
 */
export interface Persisted {
  readonly info: SessionInfo;
  readonly deletedAt: number | null;
  readonly lastScreen: string;
}

interface PersistedJson {
  readonly id: string;
  readonly projectId: string;
  readonly cwd: string;
  readonly mode: SessionInfo['mode'];
  readonly resumeSessionId?: string;
  readonly createdAt: number;
  readonly userId: string;
  readonly deletedAt: number | null;
}

export class SessionRegistry {
  // m-registry-write-queue (B10): per-id chain serializes concurrent
  // writes to the same <id>.json / <id>.screen.txt. Without this two
  // racing writeFile calls (e.g. markDeleted's eager save + onExit's
  // post-SIGINT save) can interleave a truncate against a partial write
  // and corrupt the file. Cross-id writes still run in parallel.
  private readonly writeChains = new Map<string, Promise<unknown>>();

  constructor(private readonly dir: string) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  /** Chain `op` after any pending write for `id`. Rejection of a prior
   *  op does not block subsequent ops (caller already log-and-swallows
   *  errors inside op). */
  private serialize(id: string, op: () => Promise<void>): Promise<void> {
    const prev = this.writeChains.get(id) ?? Promise.resolve();
    const next = prev.then(op, op);
    this.writeChains.set(id, next);
    void next.finally(() => {
      if (this.writeChains.get(id) === next) {
        this.writeChains.delete(id);
      }
    });
    return next;
  }

  /**
   * Async fire-and-forget per D2. Caller does `void registry.save(...)`
   * — IO runs on libuv worker pool, main loop unaffected. Failure
   * surfaces to log but does not propagate.
   */
  async save(info: SessionInfo, deletedAt: number | null): Promise<void> {
    return this.serialize(info.id, async () => {
      const payload: PersistedJson = {
        id: info.id,
        projectId: info.projectId,
        cwd: info.cwd,
        mode: info.mode,
        ...(info.resumeSessionId !== undefined
          ? { resumeSessionId: info.resumeSessionId }
          : {}),
        createdAt: info.createdAt,
        userId: info.userId,
        deletedAt,
      };
      try {
        await mkdir(this.dir, { recursive: true });
        await writeFile(
          this.metadataPath(info.id),
          JSON.stringify(payload, null, 2),
          'utf8',
        );
      } catch (err) {
        logger.error({ err, id: info.id }, 'session registry save failed');
      }
    });
  }

  async saveScreen(id: string, text: string): Promise<void> {
    return this.serialize(id, async () => {
      try {
        await mkdir(this.dir, { recursive: true });
        await writeFile(this.screenPath(id), text, 'utf8');
      } catch (err) {
        logger.error({ err, id }, 'session registry saveScreen failed');
      }
    });
  }

  /**
   * Hard-delete both files. Used when GC clears a user-deleted session
   * past ttl, and when the user explicitly purges from the dead-stub UI.
   */
  async delete(id: string): Promise<void> {
    return this.serialize(id, async () => {
      await Promise.all([
        this.unlinkIgnoreMissing(this.metadataPath(id)),
        this.unlinkIgnoreMissing(this.screenPath(id)),
      ]);
    });
  }

  /**
   * Drop only the screen snapshot. Called after a successful Resume —
   * the snapshot represents a stale frame; the new PTY's live output
   * replaces it.
   */
  async deleteScreen(id: string): Promise<void> {
    return this.serialize(id, async () => {
      await this.unlinkIgnoreMissing(this.screenPath(id));
    });
  }

  /**
   * Boot-time read. Synchronous per D5 — we want listen to start with
   * the list already complete. N is bounded by user's session count
   * (typically < 100), each file is small, so even with cold disk the
   * total stays under ~100ms.
   *
   * Corrupt json or missing files are skipped with a warn log; one bad
   * session never blocks the others (D4 fail-soft).
   */
  loadAllSync(): Persisted[] {
    const out: Persisted[] = [];
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch (err) {
      logger.warn({ err, dir: this.dir }, 'session registry dir missing');
      return out;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      if (name.startsWith('.')) continue;
      const path = join(this.dir, name);
      let parsed: PersistedJson;
      try {
        parsed = JSON.parse(readFileSync(path, 'utf8')) as PersistedJson;
      } catch (err) {
        logger.warn({ err, path }, 'session registry: corrupt json, skipping');
        continue;
      }
      if (
        typeof parsed.id !== 'string' ||
        typeof parsed.projectId !== 'string' ||
        typeof parsed.cwd !== 'string' ||
        (parsed.mode !== 'create' && parsed.mode !== 'resume') ||
        typeof parsed.createdAt !== 'number' ||
        typeof parsed.userId !== 'string'
      ) {
        logger.warn({ path }, 'session registry: malformed fields, skipping');
        continue;
      }
      let lastScreen = '';
      try {
        lastScreen = readFileSync(this.screenPath(parsed.id), 'utf8');
      } catch {
        // No screen file — session may have been mid-running when the
        // process died before onExit could write. Empty preview is fine.
      }
      const info: SessionInfo =
        parsed.resumeSessionId !== undefined
          ? {
              id: parsed.id,
              projectId: parsed.projectId,
              cwd: parsed.cwd,
              mode: parsed.mode,
              resumeSessionId: parsed.resumeSessionId,
              createdAt: parsed.createdAt,
              userId: parsed.userId,
            }
          : {
              id: parsed.id,
              projectId: parsed.projectId,
              cwd: parsed.cwd,
              mode: parsed.mode,
              createdAt: parsed.createdAt,
              userId: parsed.userId,
            };
      out.push({ info, deletedAt: parsed.deletedAt, lastScreen });
    }
    return out;
  }

  private metadataPath(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private screenPath(id: string): string {
    return join(this.dir, `${id}.screen.txt`);
  }

  private async unlinkIgnoreMissing(path: string): Promise<void> {
    try {
      await unlink(path);
    } catch (err) {
      // ENOENT is expected (snapshot may not exist for active sessions)
      if (
        err !== null &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code?: string }).code === 'ENOENT'
      ) {
        return;
      }
      logger.warn({ err, path }, 'session registry unlink failed');
    }
  }
}
