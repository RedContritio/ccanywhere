import { readFileSync } from 'node:fs';
import type { z } from 'zod';
import { logger } from '../log.js';

/**
 * Read a JSON file and validate it against a zod schema. Replaces the
 * per-store hand-written `typeof` chain for store metadata files
 * (share/store + session/registry). Extracted by m-store-zod-load.
 *
 * Returns undefined for any failure mode (file missing / IO error /
 * invalid JSON / schema mismatch). Warns once for everything except
 * ENOENT — file-not-existing is the normal boot-time path when a store
 * has no entries yet, and warning on that floods the log.
 *
 * The zod issues are logged verbatim so a corrupt record's bad field is
 * identifiable from the log alone (no need to re-read the file).
 */
export function loadJsonRecord<T>(
  path: string,
  schema: z.ZodType<T>,
): T | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    // ENOENT is normal (store has no entry yet); other IO errors warrant
    // a warn so permission / disk issues surface in the log.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') logger.warn({ err, path }, 'load-json-record: read failed');
    return undefined;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    logger.warn({ err, path }, 'load-json-record: invalid json');
    return undefined;
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    logger.warn(
      { path, issues: result.error.issues },
      'load-json-record: schema validation failed',
    );
    return undefined;
  }
  return result.data;
}
