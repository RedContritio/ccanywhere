import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Read seen-set from disk. Tolerant of missing / malformed files — the
 * cost of accidentally re-listing a feedback is small; the cost of a
 * crash on stale state is bigger.
 */
export function loadSeenSet(seenPath: string): Set<string> {
  if (!existsSync(seenPath)) return new Set();
  try {
    const raw = readFileSync(seenPath, 'utf8');
    const parsed = JSON.parse(raw) as { seen?: string[] } | string[];
    const arr = Array.isArray(parsed) ? parsed : parsed.seen ?? [];
    return new Set(arr);
  } catch {
    return new Set();
  }
}

export function persistSeenSet(seenPath: string, seen: Set<string>): void {
  const dir = dirname(seenPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Sort for deterministic on-disk format; helps diffing if the user ever
  // checks the file into their dotfiles.
  const arr = [...seen].sort();
  writeFileSync(seenPath, JSON.stringify({ seen: arr }, null, 2), { mode: 0o600 });
}
