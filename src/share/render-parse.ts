import { Marked } from 'marked';

// Parse cc jsonl → RenderedMessage[] (rewind-filtered, tool-merged).
// Split out of render.ts to stay under the max-lines lint cap;
// render.ts handles HTML composition + page chrome.

interface JsonlRow {
  readonly type?: string;
  readonly uuid?: string;
  readonly parentUuid?: string | null;
  readonly leafUuid?: string;
  readonly message?: {
    readonly role?: string;
    readonly content?: string | readonly MessagePart[];
  };
  readonly timestamp?: string;
}

type MessagePart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'thinking'; readonly thinking: string }
  | {
      readonly type: 'tool_use';
      readonly id?: string;
      readonly name: string;
      readonly input: unknown;
    }
  | {
      readonly type: 'tool_result';
      readonly tool_use_id: string;
      readonly content: string | readonly MessagePart[];
      readonly is_error?: boolean;
    };

// Intercept marked's raw HTML token so a user-typed `<script>` shows as
// literal text rather than executing in the share view. Normal text +
// code blocks keep marked's default entity handling (no double-escape
// of `&quot;` etc. when inside fences).
const md = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    html(token: { text: string } | string): string {
      const raw = typeof token === 'string' ? token : token.text;
      return raw
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    },
  },
});

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderMarkdown(text: string): string {
  return md.parse(text) as string;
}

const CAVEAT_TAGS = [
  '<local-command-caveat>',
  '<command-name>',
  '<command-message>',
  '<command-stdout>',
  '<command-stderr>',
] as const;

function isSystemCaveat(text: string): boolean {
  return CAVEAT_TAGS.some((tag) => text.startsWith(tag));
}

interface Partition {
  readonly textHtml: string;
  readonly toolUseIds: readonly string[];
}

/**
 * Pull text + tool ids out of a user-role message. tool_result bodies
 * are intentionally **not** rendered to HTML — the share view only
 * shows the footer count, not the tool I/O details. Text + tool_use_id
 * survives.
 */
function partitionUserContent(
  content: string | readonly MessagePart[],
): Partition {
  if (typeof content === 'string') {
    if (isSystemCaveat(content)) {
      return { textHtml: '', toolUseIds: [] };
    }
    return {
      textHtml: `<div class="text">${renderMarkdown(content)}</div>`,
      toolUseIds: [],
    };
  }
  const textBlocks: string[] = [];
  const ids: string[] = [];
  for (const part of content) {
    if (part.type === 'text') {
      if (isSystemCaveat(part.text)) continue;
      textBlocks.push(`<div class="text">${renderMarkdown(part.text)}</div>`);
    } else if (part.type === 'tool_result') {
      ids.push(part.tool_use_id);
    }
  }
  return { textHtml: textBlocks.join(''), toolUseIds: ids };
}

function partitionAssistantContent(
  content: readonly MessagePart[],
): Partition {
  const textBlocks: string[] = [];
  const ids: string[] = [];
  for (const part of content) {
    if (part.type === 'text') {
      textBlocks.push(`<div class="text">${renderMarkdown(part.text)}</div>`);
    } else if (part.type === 'tool_use') {
      // tool_use body intentionally not rendered — share view only
      // exposes the footer count. cc jsonl writes tool_use.id; pair
      // with tool_result.tool_use_id for dedup.
      ids.push(part.id ?? `<assistant-tool-use-${ids.length}>`);
    }
    // thinking blocks dropped (privacy — internal CoT never shown in
    // cc TUI either, must not leak via share).
  }
  return { textHtml: textBlocks.join(''), toolUseIds: ids };
}

export interface RenderedMessage {
  readonly role: 'user' | 'assistant';
  readonly timestamp: number | null;
  textHtml: string;
  toolIds: Set<string>;
}

// Active uuids = path from cc's `last-prompt.leafUuid` back through
// parentUuid. cc appends a fresh last-prompt row per rewind / new
// prompt; the last one wins. Returns null when no last-prompt is
// present so legacy sessions fall back to sequential rendering.
function computeActiveUuids(rows: readonly JsonlRow[]): Set<string> | null {
  let leafUuid: string | undefined;
  for (const row of rows) {
    if (row.type === 'last-prompt' && typeof row.leafUuid === 'string') {
      leafUuid = row.leafUuid;
    }
  }
  if (leafUuid === undefined) return null;
  const byUuid = new Map<string, JsonlRow>();
  for (const row of rows) {
    if (typeof row.uuid === 'string') byUuid.set(row.uuid, row);
  }
  const active = new Set<string>();
  let cursor: string | undefined = leafUuid;
  // Guard against cycles (shouldn't happen but cheap to defend).
  let hops = 0;
  while (cursor !== undefined && !active.has(cursor) && hops < byUuid.size + 1) {
    active.add(cursor);
    const node = byUuid.get(cursor);
    if (!node || node.parentUuid === null || node.parentUuid === undefined) {
      break;
    }
    cursor = node.parentUuid;
    hops++;
  }
  return active;
}

export function parseJsonl(jsonl: string): RenderedMessage[] {
  const rows: JsonlRow[] = [];
  for (const line of jsonl.split('\n')) {
    if (line.trim() === '') continue;
    try {
      rows.push(JSON.parse(line) as JsonlRow);
    } catch {
      continue;
    }
  }
  const active = computeActiveUuids(rows);
  const out: RenderedMessage[] = [];
  // Real user text turns are segment boundaries. Multiple assistant
  // rows + synthetic tool_result rows in between collapse into one
  // assistant article with one tools-used footer.
  let open: RenderedMessage | null = null;
  const flush = (): void => {
    if (open !== null) { out.push(open); open = null; }
  };
  for (const row of rows) {
    if (active !== null && (row.uuid === undefined || !active.has(row.uuid))) continue;
    const role = row.message?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const content = row.message?.content;
    if (content === undefined) continue;
    const ts = row.timestamp ? Date.parse(row.timestamp) : null;
    const timestamp = ts === null || Number.isNaN(ts) ? null : ts;
    if (role === 'assistant') {
      if (typeof content === 'string') continue;
      const p = partitionAssistantContent(content);
      if (p.textHtml === '' && p.toolUseIds.length === 0) continue;
      if (open === null) {
        open = { role: 'assistant', timestamp, textHtml: p.textHtml, toolIds: new Set(p.toolUseIds) };
      } else {
        open.textHtml += p.textHtml;
        for (const id of p.toolUseIds) open.toolIds.add(id);
      }
    } else {
      const p = partitionUserContent(content);
      // tool_use_ids merge into open assistant bucket; orphan (no open) is dropped.
      if (p.toolUseIds.length > 0 && open !== null) {
        for (const id of p.toolUseIds) open.toolIds.add(id);
      }
      // Real user text closes the bucket and starts a new segment.
      if (p.textHtml !== '') {
        flush();
        out.push({ role: 'user', timestamp, textHtml: p.textHtml, toolIds: new Set() });
      }
    }
  }
  flush();
  return out;
}

export function composeMessageHtml(m: RenderedMessage): string {
  const footer =
    m.toolIds.size > 0
      ? `<div class="tools-footer">${m.toolIds.size} tool${m.toolIds.size === 1 ? '' : 's'} used</div>`
      : '';
  return `${m.textHtml}${footer}`;
}
