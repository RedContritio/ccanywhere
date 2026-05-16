import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { loadJsonRecord } from '../lib/load-json-record.js';
import { WriteQueue } from '../lib/write-queue.js';
import { logger } from '../log.js';
import type { SessionInfo } from './types.js';

const PersistedRecordSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  cwd: z.string(),
  mode: z.union([z.literal('create'), z.literal('resume')]),
  resumeSessionId: z.string().optional(),
  createdAt: z.number(),
  userId: z.string(),
  deletedAt: z.number().nullable(),
});

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

export class SessionRegistry {
  // m-registry-write-queue (B10): per-id chain serializes concurrent
  // writes to the same <id>.json / <id>.screen.txt. Without this two
  // racing writeFile calls (e.g. markDeleted's eager save + onExit's
  // post-SIGINT save) can interleave a truncate against a partial write
  // and corrupt the file. Cross-id writes still run in parallel.
  private readonly queue = new WriteQueue<string>();

  constructor(private readonly dir: string) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Async fire-and-forget per D2. Caller does `void registry.save(...)`
   * — IO runs on libuv worker pool, main loop unaffected. Failure
   * surfaces to log but does not propagate.
   */
  async save(info: SessionInfo, deletedAt: number | null): Promise<void> {
    return this.queue.enqueue(info.id, async () => {
      const payload = {
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
    return this.queue.enqueue(id, async () => {
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
    return this.queue.enqueue(id, async () => {
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
    return this.queue.enqueue(id, async () => {
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
      const parsed = loadJsonRecord(path, PersistedRecordSchema);
      if (parsed === undefined) continue;
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
