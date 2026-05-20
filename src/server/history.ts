import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';

export interface SessionSummary {
  readonly sessionId: string;
  readonly modifiedAt: number;
  readonly preview: string;
}

export function defaultHistoryRoot(): string {
  return join(homedir(), '.claude', 'projects');
}

export function encodeProjectCwd(cwd: string): string {
  return resolve(cwd).replace(/\//g, '-');
}

/**
 *  B26 helper: resolve effective (cwd, historyRoot)
 * pair for listHistory call. host runtime → caller args unchanged.
 * shared-container runtime → translate host cwd to container cwd (D9
 * workspace mount inverse) + use per-user `<userClaudeRoot>/<user>/
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

  const summaries: SessionSummary[] = [];
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    const sessionId = f.slice(0, -'.jsonl'.length);
    if (sessionId.length === 0) continue;
    const filePath = join(dir, f);
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(filePath)).mtimeMs;
    } catch {
      continue;
    }
    const preview = await readFirstUserMessage(filePath);
    summaries.push({ sessionId, modifiedAt: mtimeMs, preview });
  }
  summaries.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return summaries;
}

const PREVIEW_MAX = 200;

/**
 * cc CLI emits `type: user` messages whose `content` carries its own
 * system tags. Two flavors:
 *
 *   - Unwrap (keep inner text): `<command-name>` only — preserves the
 *     slash command itself (`/clear` `/init` etc.) as user-driven
 *     intent worth surfacing in the preview.
 *
 *   - Strip (remove block entirely): the rest — `command-message` and
 *     `command-args` are redundant with command-name; caveat / reminder
 *     / stdout / stderr / hook / bash tool I/O are model-facing system
 *     noise with no preview value.
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
  let content: string;
  try {
    content = await readFile(file, 'utf8');
  } catch {
    return '';
  }
  // Collect a leading run of slash-command-only user lines, then the
  // first real user input after them. So `/clear` alone → "/clear",
  // `/clear` followed by "如何 X" → "/clear · 如何 X", "如何 X" alone
  // → "如何 X". User intent: see what the session actually starts with
  // when the literal first message is just a command invocation.
  const collected: string[] = [];
  for (const rawLine of content.split('\n')) {
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
