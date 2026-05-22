import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';

export interface SessionSummary {
  readonly sessionId: string;
  readonly modifiedAt: number;
  readonly preview: string;
}

export function defaultHistoryRoot(): string {
  return join(homedir(), '.claude', 'projects');
}

/** cc caps the encoded project dir name at this many chars. */
const ENCODED_CWD_MAX = 200;

/**
 * Java-style 31-multiply string hash wrapped to a 32-bit signed int —
 * a verbatim port of cc 2.1.141's `iCH()`.
 */
function ccCwdHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return h;
}

/**
 * Encode an absolute cwd into the directory name cc stores its session
 * jsonl under (`~/.claude/projects/<encoded>/`).
 *
 * Verbatim port of cc 2.1.141's `sY()`, extracted from the shipped binary
 * (`/Users/<you>/.local/share/claude/versions/2.1.141`) — functions
 * `sY` / `eN4` / `iCH`:
 *
 *   sY(p)  = e = p.replace(/[^a-zA-Z0-9]/g, '-');
 *            e.length <= 200 ? e : e.slice(0,200) + '-' + eN4(p)
 *   eN4(p) = Math.abs(iCH(p)).toString(36)
 *
 * EVERY non-alphanumeric char maps to '-' — not just '/'. A project dir
 * `gicg_mono` lands at `-Users-…-gicg-mono` (underscore → dash); encoding
 * only '/' misses it and reads an empty history. cc truncates encodings
 * over 200 chars and appends a base36 path hash to keep them unique.
 */
export function encodeProjectCwd(cwd: string): string {
  const resolved = resolve(cwd);
  const enc = resolved.replace(/[^a-zA-Z0-9]/g, '-');
  if (enc.length <= ENCODED_CWD_MAX) return enc;
  const hash = Math.abs(ccCwdHash(resolved)).toString(36);
  return `${enc.slice(0, ENCODED_CWD_MAX)}-${hash}`;
}

/**
 * helper: resolve effective (cwd, historyRoot)
 * pair for listHistory call. host runtime → caller args unchanged.
 * shared-container runtime → translate host cwd to container cwd
 * (workspace mount inverse) + use per-user `<userClaudeRoot>/<user>/
 * projects/` instead of homedir/.claude. Pure function, no fs access.
 */
export function resolveHistoryScope(opts: {
  username: string | undefined;
  hostCwd: string;
  runtime: 'host' | 'shared-container';
  userClaudeRoot: string | undefined;
  hostWorkspace: string | undefined;
  containerWorkspacePath: string | undefined;
  defaultHistoryRoot: string | undefined;
}): { cwd: string; historyRoot: string | undefined } {
  const isShared = opts.runtime === 'shared-container';
  if (isShared && opts.username !== undefined && opts.userClaudeRoot !== undefined && opts.hostWorkspace !== undefined && opts.containerWorkspacePath !== undefined) {
    const r = relative(opts.hostWorkspace, opts.hostCwd);
    if (!r.startsWith('..')) {
      return { cwd: join(opts.containerWorkspacePath, r), historyRoot: join(opts.userClaudeRoot, opts.username, 'projects') };
    }
  }
  return { cwd: opts.hostCwd, historyRoot: opts.defaultHistoryRoot };
}

export async function listHistory(
  cwd: string,
  historyRoot: string = defaultHistoryRoot(),
): Promise<SessionSummary[]> {
  const dir = join(historyRoot, encodeProjectCwd(cwd));
  let files: string[];
  try {
    files = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  // Each session jsonl is independent — process them in parallel. cc
  // session files run to tens of MB; serial await over 20+ files was the
  // slow path behind sluggish history listing.
  const summaries = (
    await Promise.all(
      files.map(async (f): Promise<SessionSummary | null> => {
        if (!f.endsWith('.jsonl')) return null;
        const sessionId = f.slice(0, -'.jsonl'.length);
        if (sessionId.length === 0) return null;
        const filePath = join(dir, f);
        let mtimeMs: number;
        try {
          mtimeMs = (await stat(filePath)).mtimeMs;
        } catch {
          return null;
        }
        const preview = await readFirstUserMessage(filePath);
        return { sessionId, modifiedAt: mtimeMs, preview };
      }),
    )
  ).filter((s): s is SessionSummary => s !== null);
  summaries.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return summaries;
}

const PREVIEW_MAX = 200;

/**
 * cc CLI emits `type: user` messages whose `content` carries its own
 * system tags. Two flavors:
 *
 * - Unwrap (keep inner text): `<command-name>` only — preserves the
 * slash command itself (`/clear` `/init` etc.) as user-driven
 * intent worth surfacing in the preview.
 *
 * - Strip (remove block entirely): the rest — `command-message` and
 * `command-args` are redundant with command-name; caveat / reminder
 * / stdout / stderr / hook / bash tool I/O are model-facing system
 * noise with no preview value.
 *
 * Whitespace collapse after both passes so unwrap doesn't leave gaping
 * blank runs. If post-processing leaves an empty string, caller skips
 * this user line and tries the next.
 */
const CC_UNWRAP_TAGS = ['command-name'] as const;

const CC_STRIP_TAGS = [
  'command-message',
  'command-args',
  'local-command-caveat',
  'command-stdout',
  'command-stderr',
  'local-command-stdout',
  'local-command-stderr',
  'system-reminder',
  'user-prompt-submit-hook',
  'bash-input',
  'bash-stdout',
  'bash-stderr',
] as const;

export function stripCcSystemTags(text: string): string {
  let out = text;
  for (const tag of CC_UNWRAP_TAGS) {
    const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g');
    out = out.replace(re, ' $1 ');
  }
  for (const tag of CC_STRIP_TAGS) {
    const re = new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'g');
    out = out.replace(re, '');
  }
  return out.replace(/\s+/g, ' ').trim();
}

async function readFirstUserMessage(file: string): Promise<string> {
  // Collect a leading run of slash-command-only user lines, then the
  // first real user input after them. So `/clear` alone → "/clear",
  // `/clear` followed by "如何 X" → "/clear · 如何 X", "如何 X" alone
  // → "如何 X". User intent: see what the session actually starts with
  // when the literal first message is just a command invocation.
  //
  // Stream line-by-line and stop at the first real user input — the
  // preview lives in the opening lines, but cc session jsonl runs to tens
  // of MB. Reading the whole file just for the head was the slow path.
  const collected: string[] = [];
  const stream = createReadStream(file, { encoding: 'utf8' });
  try {
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const rawLine of rl) {
      const line = rawLine.trim();
      if (line.length === 0) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const text = extractUserText(obj);
      if (text === null) continue;
      const stripped = stripCcSystemTags(text);
      if (stripped.length === 0) continue;
      collected.push(stripped);
      if (!stripped.startsWith('/')) break;
    }
  } catch {
    return '';
  } finally {
    stream.destroy();
  }
  if (collected.length === 0) return '';
  return collected.join(' · ').slice(0, PREVIEW_MAX);
}

function extractUserText(obj: unknown): string | null {
  if (typeof obj !== 'object' || obj === null) return null;
  const o = obj as Record<string, unknown>;
  if (o['type'] !== 'user') return null;
  const message = o['message'];
  if (typeof message !== 'object' || message === null) return null;
  const content = (message as Record<string, unknown>)['content'];
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part !== 'object' || part === null) continue;
      const p = part as Record<string, unknown>;
      if (p['type'] === 'text' && typeof p['text'] === 'string') {
        return p['text'];
      }
    }
  }
  return null;
}
