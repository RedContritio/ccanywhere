import { describe, expect, it } from 'vitest';

import { renderShareHtml, type RenderInput } from './render.js';

/**
 * Tests for : rewind-aware filtering +
 * tool-call folding into the surrounding assistant article. Split
 * from `render.test.ts` to stay under the max-lines lint cap.
 */

function input(jsonl: string, overrides: Partial<RenderInput> = {}): RenderInput {
  return {
    jsonl,
    projectName: 'demo-proj',
    createdBy: 'alice',
    createdAt: 1_700_000_000_000,
    shareCode: '550e8400-e29b-41d4-a716-446655440000',
    ...overrides,
  };
}

// Compact builders so each case fits in a few lines.
const userMsg = (content: unknown, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: 'user', message: { role: 'user', content }, ...extra });
const asstMsg = (parts: unknown[], extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: parts },
    ...extra,
  });
const tu = (id: string, name: string, inp: unknown = {}): unknown => ({
  type: 'tool_use',
  id,
  name,
  input: inp,
});
const tr = (
  toolUseId: string,
  content: string,
  isError = false,
): unknown => ({
  type: 'tool_result',
  tool_use_id: toolUseId,
  content,
  ...(isError ? { is_error: true } : {}),
});
const lp = (leafUuid: string): string =>
  JSON.stringify({ type: 'last-prompt', leafUuid });

describe('renderShareHtml — rewind & tool folding', () => {
  it('emits only the footer for a lone tool_use (no body, no <details>)', () => {
    const row = asstMsg([tu('toolu_1', 'Bash', { command: 'ls' })]);
    const html = renderShareHtml(input(row));
    expect(html).not.toContain('<details');
    expect(html).not.toContain('command');
    expect(html).toContain('<div class="tools-footer">1 tool used</div>');
  });

  it('drops synthetic user-role tool_result row entirely (only count survives)', () => {
    const lines = [
      asstMsg([{ type: 'text', text: 'running ls' }, tu('toolu_1', 'Bash')]),
      userMsg([tr('toolu_1', 'total 24')]),
    ];
    const html = renderShareHtml(input(lines.join('\n')));
    const userArticles = html.match(/<article class="msg user"/g) ?? [];
    expect(userArticles).toHaveLength(0);
    expect(html).not.toContain('total 24');
    expect(html).not.toContain('<details');
    expect(html).toContain('<div class="tools-footer">1 tool used</div>');
  });

  it('drops errored tool_result body too (no error class leaks into share)', () => {
    const lines = [
      asstMsg([tu('toolu_2', 'Bash')]),
      userMsg([tr('toolu_2', 'boom', true)]),
    ];
    const html = renderShareHtml(input(lines.join('\n')));
    expect(html).not.toContain('boom');
    expect(html).not.toContain('tool-result');
  });

  it('splits mixed user-role content: text stays as user msg, tool_result body is dropped', () => {
    const lines = [
      asstMsg([{ type: 'text', text: 'response' }, tu('toolu_3', 'Bash')]),
      userMsg([
        { type: 'text', text: 'follow-up question' },
        tr('toolu_3', 'output'),
      ]),
    ];
    const html = renderShareHtml(input(lines.join('\n')));
    expect(html).toMatch(/<article class="msg user">[\s\S]*follow-up question/);
    // Tool body absent — only the count survives on the assistant article.
    expect(html).not.toContain('output');
    expect(html).not.toContain('toolu_3');
    expect(html).toMatch(
      /<article class="msg assistant">[\s\S]*tools-footer">1 tool used/,
    );
  });

  it('collapses consecutive assistant rows between user turns into one article', () => {
    // Multi-step assistant burst (cc streams several rows for one
    // prompt) should fold into a single article with one footer.
    const lines = [
      userMsg('do something'),
      asstMsg([
        { type: 'text', text: 'first step' },
        tu('t1', 'Read'),
      ]),
      userMsg([tr('t1', 'r1')]),
      asstMsg([
        { type: 'text', text: 'second step' },
        tu('t2', 'Bash'),
      ]),
      userMsg([tr('t2', 'r2')]),
      asstMsg([{ type: 'text', text: 'final answer' }]),
      userMsg('next prompt'),
    ];
    const html = renderShareHtml(input(lines.join('\n')));
    const userArticles = html.match(/<article class="msg user"/g) ?? [];
    const asstArticles = html.match(/<article class="msg assistant"/g) ?? [];
    expect(userArticles).toHaveLength(2);
    expect(asstArticles).toHaveLength(1);
    expect(html).toContain('first step');
    expect(html).toContain('second step');
    expect(html).toContain('final answer');
    expect(html).toContain('<div class="tools-footer">2 tools used</div>');
    expect(html.match(/tools-footer">/g)).toHaveLength(1);
  });

  it('counts assistant + user tool ids as one when matched (footer dedup)', () => {
    const lines = [
      asstMsg([tu('toolu_A', 'Read'), tu('toolu_B', 'Bash')]),
      userMsg([tr('toolu_A', 'r1'), tr('toolu_B', 'r2')]),
    ];
    const html = renderShareHtml(input(lines.join('\n')));
    expect(html).toContain('<div class="tools-footer">2 tools used</div>');
  });

  it('filters dead branches: last-prompt.leafUuid drives active-path retrieval', () => {
    // Tree:
    //   u1 user "A"
    //   u2 assistant "DEAD" (parent=u1)   ← off-path
    //   u3 assistant "ACTIVE" (parent=u1) ← active
    //   u4 user "B" (parent=u3)
    // last-prompt=u4 → u1, u3, u4 active; u2 dropped.
    const lines = [
      userMsg('A', { uuid: 'u1', parentUuid: null }),
      asstMsg([{ type: 'text', text: 'DEAD_BRANCH_ANSWER' }], {
        uuid: 'u2',
        parentUuid: 'u1',
      }),
      asstMsg([{ type: 'text', text: 'ACTIVE_ANSWER' }], {
        uuid: 'u3',
        parentUuid: 'u1',
      }),
      userMsg('B', { uuid: 'u4', parentUuid: 'u3' }),
      lp('u4'),
    ];
    const html = renderShareHtml(input(lines.join('\n')));
    expect(html).toContain('ACTIVE_ANSWER');
    expect(html).not.toContain('DEAD_BRANCH_ANSWER');
  });

  it('multiple last-prompt rows: last one wins (cc appends one per rewind)', () => {
    const lines = [
      userMsg('A', { uuid: 'u1', parentUuid: null }),
      asstMsg([{ type: 'text', text: 'FIRST_TIP' }], {
        uuid: 'u2',
        parentUuid: 'u1',
      }),
      lp('u2'),
      asstMsg([{ type: 'text', text: 'SECOND_TIP' }], {
        uuid: 'u3',
        parentUuid: 'u1',
      }),
      lp('u3'),
    ];
    const html = renderShareHtml(input(lines.join('\n')));
    expect(html).toContain('SECOND_TIP');
    expect(html).not.toContain('FIRST_TIP');
  });

  it('falls back to sequential rendering when no last-prompt row exists', () => {
    const lines = [
      userMsg('legacy A', { uuid: 'u1', parentUuid: null }),
      asstMsg([{ type: 'text', text: 'legacy B' }], {
        uuid: 'u2',
        parentUuid: 'u1',
      }),
    ];
    const html = renderShareHtml(input(lines.join('\n')));
    expect(html).toContain('legacy A');
    expect(html).toContain('legacy B');
  });
});
