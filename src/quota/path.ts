import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Derive the cc-generated jsonl file path for a given (cwd, sessionId).
 *
 * cc CLI lays out per-session jsonl under
 * `<home>/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`
 * where `encoded-cwd` is the absolute cwd with every `/` replaced by `-`
 * (leading `/` becomes leading `-`).
 *
 * Examples:
 * /Users/me/Projects/foo → -Users-me-Projects-foo
 * /private/tmp/abc → -private-tmp-abc
 *
 * Algorithm verified at 2026-05-11 against real cc 2.1.x layouts. cc upgrades
 * can change this encoding; `runStartupSanityCheck` below catches drift before
 * the first hook fires.
 */
/**
 * `claudeRoot` overrides the parent of `projects/` for non-owner / container
 * users. Defaults to `<homedir>/.claude` so
 * owner host path continues to land in `~/.claude/projects/...` unchanged.
 */
export function ccJsonlPathOf(
  cwd: string,
  sessionId: string,
  claudeRoot?: string,
): string {
  const encoded = cwd.replace(/\//g, '-');
  const root = claudeRoot ?? join(homedir(), '.claude');
  return join(root, 'projects', encoded, `${sessionId}.jsonl`);
}

export class QuotaPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuotaPathError';
  }
}

export type SanityResult =
  | { readonly kind: 'verified'; readonly samplePath: string }
  | { readonly kind: 'skipped'; readonly reason: string };

export interface SanityLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

export interface SanityCheckOptions {
  /** Override the projects root for tests; defaults to ~/.claude/projects. */
  readonly projectsRoot?: string;
  /** Override the path derivation function for mismatch tests. */
  readonly pathOf?: (cwd: string, sessionId: string) => string;
  readonly logger?: SanityLogger;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

/**
 * Walk `<home>/.claude/projects/` looking for any `<encoded-cwd>/<uuid>.jsonl`,
 * reverse-derive the cwd, and verify `ccJsonlPathOf(reversedCwd, sessionId)`
 * round-trips to the same path. This guards against cc CLI upgrades that
 * change the encoding scheme: if encoding drifts, the runtime quota check
 * would silently miss jsonl files, letting users bypass their quota.
 *
 * - empty `~/.claude/projects/` → `skipped` + warn (new install; the check
 * will retry implicitly on the first hook fire when a real jsonl appears)
 * - mismatch → throw `QuotaPathError` (caller decides whether to fatal-exit)
 * - match → `verified` + info log
 */
export function runStartupSanityCheck(opts: SanityCheckOptions = {}): SanityResult {
  const logger = opts.logger ?? defaultLogger;
  const projectsRoot = opts.projectsRoot ?? join(homedir(), '.claude', 'projects');
  // Default round-trip path uses the same projectsRoot so test fixtures (which
  // mock projectsRoot to a tmp dir) verify against the same root rather than
  // the real ~/.claude.
  const pathOf =
    opts.pathOf ??
    ((cwd: string, sessionId: string): string =>
      join(projectsRoot, cwd.replace(/\//g, '-'), `${sessionId}.jsonl`));
  if (!existsSync(projectsRoot)) {
    logger.warn(
      `[quota.path] ${projectsRoot} does not exist — sanity check skipped (will self-check on first hook fire)`,
    );
    return { kind: 'skipped', reason: 'projects root missing' };
  }

  let projectDirs: string[];
  try {
    projectDirs = readdirSync(projectsRoot);
  } catch (err) {
    logger.warn(`[quota.path] cannot read ${projectsRoot}: ${stringifyErr(err)}`);
    return { kind: 'skipped', reason: 'projects root unreadable' };
  }

  for (const projectDir of projectDirs) {
    if (!projectDir.startsWith('-')) continue; // skip stray non-encoded entries
    const absDir = join(projectsRoot, projectDir);
    let entries: string[];
    try {
      entries = readdirSync(absDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!UUID_RE.test(entry)) continue;
      const samplePath = join(absDir, entry);
      try {
        if (!statSync(samplePath).isFile()) continue;
      } catch {
        continue;
      }
      // Reverse: leading `-` + `-` separators back into `/`. cc never escapes
      // `-` chars in cwd components, so a path containing literal `-` is
      // ambiguous, but the round-trip below catches any divergence.
      const reversedCwd = `/${projectDir.slice(1).replace(/-/g, '/')}`;
      const sessionId = entry.replace(/\.jsonl$/, '');
      const roundTrip = pathOf(reversedCwd, sessionId);
      if (roundTrip !== samplePath) {
        throw new QuotaPathError(
          `cc jsonl path encoding drift: ` +
            `expected ${roundTrip}, found ${samplePath} — ` +
            `cc CLI upgrade may have changed path encoding. ` +
            `Update src/quota/path.ts and rerun.`,
        );
      }
      logger.info(`[quota.path] sanity check verified against ${samplePath}`);
      return { kind: 'verified', samplePath };
    }
  }

  logger.warn(
    `[quota.path] no jsonl found under ${projectsRoot} — sanity check skipped (first hook fire will self-check)`,
  );
  return { kind: 'skipped', reason: 'no jsonl' };
}

function stringifyErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const defaultLogger: SanityLogger = {
  info: (msg) => {
    console.log(msg);
  },
  warn: (msg) => {
    console.warn(msg);
  },
};
