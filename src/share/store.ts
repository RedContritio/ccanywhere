import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
} from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';
import { loadJsonRecord } from '../lib/load-json-record.js';
import { WriteQueue } from '../lib/write-queue.js';
import { logger } from '../log.js';

const ShareRecordSchema = z.object({
  code: z.string(),
  sessionId: z.string(),
  createdBy: z.string(),
  createdAt: z.number(),
  expiresAt: z.number().nullable(),
  projectName: z.string(),
});

/**
 * Share metadata persisted to disk per D5.
 *
 * One json file per share at `<configDir>/shares/<code>.json` carries
 * the metadata; the rendered HTML lives next to it as `<code>.html`.
 * The two-file split mirrors the session persistence layout (-
 * persistence) — boot-time listing only needs the json, the html is
 * served straight to the public viewer.
 */
export interface ShareRecord {
  readonly code: string;
  readonly sessionId: string;
  readonly createdBy: string;
  readonly createdAt: number;
  /** null = never expire. */
  readonly expiresAt: number | null;
  readonly projectName: string;
}

export class ShareStore {
  // Per-code chain (mirrors B10): same-code save
  // / delete must serialize to avoid metadata vs html truncate races.
  // Cross-code writes run in parallel.
  private readonly queue = new WriteQueue<string>();

  constructor(private readonly dir: string) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  /** Persist metadata + rendered HTML. Caller has already validated
   *  the code shape (UUID v4). */
  async save(record: ShareRecord, html: string): Promise<void> {
    return this.queue.enqueue(record.code, async () => {
      try {
        await mkdir(this.dir, { recursive: true });
        await Promise.all([
          writeFile(
            this.metadataPath(record.code),
            JSON.stringify(record, null, 2),
            'utf8',
          ),
          writeFile(this.htmlPath(record.code), html, 'utf8'),
        ]);
      } catch (err) {
        logger.error({ err, code: record.code }, 'share store save failed');
        throw err;
      }
    });
  }

  /** Read metadata (sync — used by REST routes; small file fast read).
   *  Returns undefined for missing / corrupt / expired records.
   *  Expired records are unlinked as a side effect (lazy GC per D6). */
  load(code: string): ShareRecord | undefined {
    const parsed = loadJsonRecord(this.metadataPath(code), ShareRecordSchema);
    if (parsed === undefined) return undefined;
    if (parsed.expiresAt !== null && parsed.expiresAt < Date.now()) {
      // Lazy GC: drop the moment anyone tries to read it.
      void this.delete(parsed.code).catch(() => undefined);
      return undefined;
    }
    return parsed;
  }

  /** Read the persisted HTML for a code. undefined on missing /
   *  expired. Caller usually does load() first to check expiry; this
   *  is for the view route fast path. */
  loadHtml(code: string): string | undefined {
    try {
      return readFileSync(this.htmlPath(code), 'utf8');
    } catch {
      return undefined;
    }
  }

  /** Remove both metadata and html. Idempotent on missing files. */
  async delete(code: string): Promise<void> {
    return this.queue.enqueue(code, async () => {
      await Promise.all([
        this.unlinkIgnoreMissing(this.metadataPath(code)),
        this.unlinkIgnoreMissing(this.htmlPath(code)),
      ]);
    });
  }

  /** Boot-time listing per D6. Sweeps expired records inline (unlinks
   *  metadata + html) so we never serve them. Corrupt / malformed
   *  files are skipped (fail-soft). */
  loadAllSync(): ShareRecord[] {
    const out: ShareRecord[] = [];
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch (err) {
      logger.warn({ err, dir: this.dir }, 'share store dir missing');
      return out;
    }
    const now = Date.now();
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      if (name.startsWith('.')) continue;
      const code = name.slice(0, -5);
      const path = join(this.dir, name);
      const parsed = loadJsonRecord(path, ShareRecordSchema);
      if (parsed === undefined) continue;
      if (parsed.expiresAt !== null && parsed.expiresAt < now) {
        try {
          unlinkSync(path);
          unlinkSync(this.htmlPath(code));
        } catch {
          // best effort sweep
        }
        continue;
      }
      out.push(parsed);
    }
    return out;
  }

  /** Per-user listing for the /settings "我的分享" section. */
  listByUserSync(userId: string): ShareRecord[] {
    return this.loadAllSync().filter((r) => r.createdBy === userId);
  }

  /** Resolves when any pending write/delete for `code` settles. Exists
   *  for tests that need to await fire-and-forget lazy GC (load() voids
   *  the delete promise so callers don't block on read paths). Production
   *  callers don't need this — load/save round-trips are deterministic
   *  through the queue. */
  async idle(code: string): Promise<void> {
    return this.queue.idle(code);
  }

  private metadataPath(code: string): string {
    return join(this.dir, `${code}.json`);
  }

  private htmlPath(code: string): string {
    return join(this.dir, `${code}.html`);
  }

  private async unlinkIgnoreMissing(path: string): Promise<void> {
    try {
      await unlink(path);
    } catch (err) {
      if (
        err !== null &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code?: string }).code === 'ENOENT'
      ) {
        return;
      }
      logger.warn({ err, path }, 'share store unlink failed');
    }
  }
}
