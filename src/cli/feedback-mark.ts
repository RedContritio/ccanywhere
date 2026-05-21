import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stdout } from 'node:process';
import { ConfigError, defaultConfigPath, loadConfig } from '../config/loader.js';
import { resolveConfigDir } from '../config/paths.js';
import { loadSeenSet, persistSeenSet } from './feedback-seen-store.js';

interface FeedbackPaths {
  readonly dir: string;
  readonly seenPath: string;
}

function feedbackPaths(configPath: string | undefined): FeedbackPaths {
  const path = configPath !== undefined ? resolve(configPath) : defaultConfigPath();
  const config = loadConfig(path);
  const configDir = resolveConfigDir(config, path);
  const dir = join(configDir, 'feedback');
  if (!existsSync(dir)) {
    throw new ConfigError(`feedback dir does not exist: ${dir}`, path);
  }
  return { dir, seenPath: join(configDir, 'feedback-seen.json') };
}

function listFeedbackFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .reverse();
}

/**
 * Resolve an id-prefix to the matching feedback id, or null if no match
 * (and exit 1). Multiple matches print disambiguation + exit 1.
 */
function resolveIdPrefix(dir: string, idPrefix: string): string | null {
  const files = listFeedbackFiles(dir);
  const matches = files.filter((f) => f.includes(idPrefix));
  if (matches.length === 0) {
    stdout.write(`no feedback matching id prefix: ${idPrefix}\n`);
    process.exit(1);
  }
  if (matches.length > 1) {
    stdout.write(
      `multiple feedback matching ${idPrefix}; please disambiguate:\n` +
        matches.map((m) => `  ${m}\n`).join(''),
    );
    process.exit(1);
  }
  const fileName = matches[0];
  if (fileName === undefined) return null;
  return fileName.endsWith('.json') ? fileName.slice(0, -5) : fileName;
}

export async function runFeedbackMarkSeen(
  configPath: string | undefined,
  idPrefix: string,
): Promise<void> {
  const { dir, seenPath } = feedbackPaths(configPath);
  const id = resolveIdPrefix(dir, idPrefix);
  if (id === null) return;
  const seen = loadSeenSet(seenPath);
  if (seen.has(id)) {
    stdout.write(`already seen: ${id}\n`);
    return;
  }
  seen.add(id);
  persistSeenSet(seenPath, seen);
  stdout.write(`marked seen: ${id}\n`);
}

export async function runFeedbackForget(
  configPath: string | undefined,
  idPrefix: string,
): Promise<void> {
  const { dir, seenPath } = feedbackPaths(configPath);
  const id = resolveIdPrefix(dir, idPrefix);
  if (id === null) return;
  const seen = loadSeenSet(seenPath);
  if (!seen.has(id)) {
    stdout.write(`not in seen set: ${id}\n`);
    return;
  }
  seen.delete(id);
  persistSeenSet(seenPath, seen);
  stdout.write(`forgot: ${id} (now unread)\n`);
}

export async function runFeedbackMarkAllSeen(
  configPath: string | undefined,
): Promise<void> {
  const { dir, seenPath } = feedbackPaths(configPath);
  const files = listFeedbackFiles(dir);
  const seen = loadSeenSet(seenPath);
  let added = 0;
  for (const f of files) {
    const id = f.endsWith('.json') ? f.slice(0, -5) : f;
    if (!seen.has(id)) {
      seen.add(id);
      added += 1;
    }
  }
  persistSeenSet(seenPath, seen);
  stdout.write(`marked ${added} new seen (total seen: ${seen.size})\n`);
}
