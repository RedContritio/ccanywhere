import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

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

async function readFirstUserMessage(file: string): Promise<string> {
  let content: string;
  try {
    content = await readFile(file, 'utf8');
  } catch {
    return '';
  }
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
    if (text !== null) return text.slice(0, PREVIEW_MAX);
  }
  return '';
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
