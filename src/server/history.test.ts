import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeProjectCwd, listHistory } from './history.js';

describe('encodeProjectCwd', () => {
  it('replaces slashes with dashes after resolve', () => {
    expect(encodeProjectCwd('/Users/foo/proj')).toBe('-Users-foo-proj');
  });
});

describe('listHistory', () => {
  let root: string;
  const cwd = '/tmp/some-project';
  let projectDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ccanywhere-hist-'));
    projectDir = join(root, encodeProjectCwd(cwd));
    mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeSession(id: string, lines: object[], mtime?: Date): void {
    const f = join(projectDir, `${id}.jsonl`);
    writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n'));
    if (mtime) utimesSync(f, mtime, mtime);
  }

  it('returns [] when project history dir does not exist', async () => {
    const result = await listHistory('/never-existed', root);
    expect(result).toEqual([]);
  });

  it('lists sessions, sorted by mtime descending', async () => {
    writeSession(
      'older',
      [{ type: 'user', message: { content: 'first prompt' } }],
      new Date('2024-01-01T00:00:00Z'),
    );
    writeSession(
      'newer',
      [{ type: 'user', message: { content: 'newer prompt' } }],
      new Date('2025-01-01T00:00:00Z'),
    );
    const result = await listHistory(cwd, root);
    expect(result.map((r) => r.sessionId)).toEqual(['newer', 'older']);
  });

  it('extracts preview from string content', async () => {
    writeSession('s1', [{ type: 'user', message: { content: 'hello there' } }]);
    const [first] = await listHistory(cwd, root);
    expect(first?.preview).toBe('hello there');
  });

  it('extracts preview from content array (text part)', async () => {
    writeSession('s2', [
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', content: 'noise' },
            { type: 'text', text: 'real text' },
          ],
        },
      },
    ]);
    const [first] = await listHistory(cwd, root);
    expect(first?.preview).toBe('real text');
  });

  it('skips assistant lines and finds first user line', async () => {
    writeSession('s3', [
      { type: 'assistant', message: { content: 'an answer' } },
      { type: 'user', message: { content: 'the question' } },
    ]);
    const [first] = await listHistory(cwd, root);
    expect(first?.preview).toBe('the question');
  });

  it('returns empty preview when no user line', async () => {
    writeSession('s4', [{ type: 'assistant', message: { content: 'only answer' } }]);
    const [first] = await listHistory(cwd, root);
    expect(first?.preview).toBe('');
  });

  it('truncates long previews to 200 chars', async () => {
    writeSession('s5', [{ type: 'user', message: { content: 'x'.repeat(500) } }]);
    const [first] = await listHistory(cwd, root);
    expect(first?.preview.length).toBe(200);
  });

  it('ignores non-jsonl files and malformed lines', async () => {
    writeFileSync(join(projectDir, 'README'), 'not a session');
    writeFileSync(
      join(projectDir, 'malformed.jsonl'),
      '{ broken\n{"type":"user","message":{"content":"good"}}',
    );
    const result = await listHistory(cwd, root);
    expect(result).toHaveLength(1);
    expect(result[0]?.sessionId).toBe('malformed');
    expect(result[0]?.preview).toBe('good');
  });
});
