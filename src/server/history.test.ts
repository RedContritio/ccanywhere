import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeProjectCwd, listHistory, stripCcSystemTags } from './history.js';

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

  it('keeps slash command (command-name) as preview when session starts with /clear only', async () => {
    writeSession('with-clear', [
      {
        type: 'user',
        message: {
          content:
            '<command-name>/clear</command-name><command-message>clear</command-message><command-args></command-args>',
        },
      },
    ]);
    const [first] = await listHistory(cwd, root);
    expect(first?.preview).toBe('/clear');
  });

  it('appends user-typed prompt after a leading /clear', async () => {
    // User invoked /clear then asked a real question. Preview should show
    // both, joined by " · " so list readers see the actual subject.
    writeSession('clear-then-ask', [
      {
        type: 'user',
        message: {
          content:
            '<command-name>/clear</command-name><command-message>clear</command-message><command-args></command-args>',
        },
      },
      {
        type: 'user',
        message: { content: '<local-command-stdout></local-command-stdout>' },
      },
      { type: 'user', message: { content: '如何实现 X' } },
    ]);
    const [first] = await listHistory(cwd, root);
    expect(first?.preview).toBe('/clear · 如何实现 X');
  });

  it('chains multiple leading slash commands before real input', async () => {
    writeSession('multi-cmd', [
      {
        type: 'user',
        message: {
          content: '<command-name>/clear</command-name>',
        },
      },
      {
        type: 'user',
        message: {
          content: '<command-name>/init</command-name>',
        },
      },
      { type: 'user', message: { content: 'do the thing' } },
    ]);
    const [first] = await listHistory(cwd, root);
    expect(first?.preview).toBe('/clear · /init · do the thing');
  });

  it('skips pure-noise user lines (caveat/reminder/stdout) to find real text', async () => {
    writeSession('with-noise', [
      {
        type: 'user',
        message: { content: '<system-reminder>x</system-reminder>' },
      },
      {
        type: 'user',
        message: {
          content: '<local-command-stdout></local-command-stdout>',
        },
      },
      { type: 'user', message: { content: 'real question' } },
    ]);
    const [first] = await listHistory(cwd, root);
    expect(first?.preview).toBe('real question');
  });

  it('strips cc system tag block leading the real user text', async () => {
    writeSession('with-caveat', [
      {
        type: 'user',
        message: {
          content:
            '<local-command-caveat>Caveat: The messages below were generated...</local-command-caveat>\n实际问题在这',
        },
      },
    ]);
    const [first] = await listHistory(cwd, root);
    expect(first?.preview).toBe('实际问题在这');
  });
});

describe('stripCcSystemTags', () => {
  it('strips noise tag block (local-command-caveat)', () => {
    expect(
      stripCcSystemTags(
        '<local-command-caveat>Caveat: ...</local-command-caveat>hello',
      ),
    ).toBe('hello');
  });

  it('unwraps command-name keeping the slash command as preview', () => {
    expect(
      stripCcSystemTags(
        '<command-name>/clear</command-name><command-message>clear</command-message><command-args></command-args>',
      ),
    ).toBe('/clear');
  });

  it('strips command-message and command-args as redundant with command-name', () => {
    expect(
      stripCcSystemTags(
        '<command-name>/cd</command-name><command-message>cd ~/proj</command-message><command-args>~/proj</command-args>',
      ),
    ).toBe('/cd');
  });

  it('strips system-reminder block across multiple lines', () => {
    const input =
      '<system-reminder>\nline 1\nline 2\n</system-reminder>after';
    expect(stripCcSystemTags(input)).toBe('after');
  });

  it('leaves unknown tags untouched', () => {
    expect(stripCcSystemTags('<div>real html</div>')).toBe(
      '<div>real html</div>',
    );
  });

  it('preserves user text after stripping a noise block', () => {
    expect(
      stripCcSystemTags(
        'before<local-command-caveat>noise</local-command-caveat>after',
      ),
    ).toBe('beforeafter');
  });

  it('mixes unwrap + strip + plain text in one input', () => {
    // /init slash, plus a caveat, plus the real follow-up question.
    expect(
      stripCcSystemTags(
        '<command-name>/init</command-name><local-command-caveat>noise</local-command-caveat> 然后请帮我...',
      ),
    ).toBe('/init 然后请帮我...');
  });

  it('collapses whitespace introduced by unwrap padding', () => {
    expect(
      stripCcSystemTags(
        '<command-name>/clear</command-name>     <command-args></command-args>',
      ),
    ).toBe('/clear');
  });

  it('trims surrounding whitespace', () => {
    expect(
      stripCcSystemTags('  <system-reminder>x</system-reminder>  text  '),
    ).toBe('text');
  });
});
