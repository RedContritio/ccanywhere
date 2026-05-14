import { Marked } from 'marked';

import { STYLES, THEME_SCRIPT } from './render-assets.js';

/**
 * Programmatic cc jsonl → HTML renderer (m-share-static-export D1, D8).
 *
 * cc writes one message per line. We care about user / assistant rows
 * — everything else (permission-mode, file-history-snapshot, system
 * caveats, attachment) is bookkeeping and gets skipped.
 *
 * Privacy: `thinking` blocks (Claude internal chain-of-thought) are
 * dropped — they're never shown to the cc user in TUI and shouldn't
 * leak into a public share. tool_use / tool_result are kept (user
 * already saw them in TUI and opt-in to sharing).
 *
 * XSS: all text from jsonl is HTML-escaped *before* markdown parse, so
 * a user-typed `<script>` shows as literal text and never executes. We
 * accept that authored markdown loses raw-HTML expressivity in v1 (no
 * inline <b>, etc.) — share view is a text export, not a doc editor.
 *
 * Output is a complete standalone HTML document with inline CSS and a
 * single 3-line theme-toggle script. No client React, no external
 * stylesheet — fully cacheable per D7.
 */

export interface RenderInput {
  readonly jsonl: string;
  readonly projectName: string;
  readonly createdBy: string;
  readonly createdAt: number;
  readonly shareCode: string;
}

interface JsonlRow {
  readonly type?: string;
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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderMarkdown(text: string): string {
  // Pass raw text — marked escapes special chars inside code blocks and
  // we intercept the html token above for XSS safety. Pre-escaping here
  // would double-escape entities inside code blocks (e.g. `"text"` →
  // `&quot;text&quot;` → marked-escaped to `&amp;quot;text&amp;quot;`).
  return md.parse(text) as string;
}

function summarizeToolInput(input: unknown): string {
  if (input === null || input === undefined) return '';
  if (typeof input === 'string') return input;
  try {
    const json = JSON.stringify(input, null, 2);
    // Cap individual tool args to keep share view scannable. Truncated
    // arguments aren't critical — they're context for the assistant
    // response that follows.
    if (json.length > 2000) return json.slice(0, 2000) + '\n…';
    return json;
  } catch {
    return '[unserializable]';
  }
}

function flattenToolResultContent(
  content: string | readonly MessagePart[],
): string {
  if (typeof content === 'string') return content;
  const parts: string[] = [];
  for (const p of content) {
    if (p.type === 'text') parts.push(p.text);
  }
  return parts.join('\n');
}

function isSystemCaveat(text: string): boolean {
  return (
    text.startsWith('<local-command-caveat>') ||
    text.startsWith('<command-name>') ||
    text.startsWith('<command-message>') ||
    text.startsWith('<command-stdout>') ||
    text.startsWith('<command-stderr>')
  );
}

function renderUserMessage(content: string | readonly MessagePart[]): string {
  // Strings = the user typed something. cc 偶尔 wraps a synthetic
  // user-role message with caveat XML around tool output; those are
  // bookkeeping, not real user prompts.
  if (typeof content === 'string') {
    if (isSystemCaveat(content)) return '';
    return `<div class="text">${renderMarkdown(content)}</div>`;
  }
  // Array form = tool_result follow-up under the user role.
  const blocks: string[] = [];
  for (const part of content) {
    if (part.type === 'text') {
      if (isSystemCaveat(part.text)) continue;
      blocks.push(`<div class="text">${renderMarkdown(part.text)}</div>`);
    } else if (part.type === 'tool_result') {
      const body = flattenToolResultContent(part.content);
      const cap = body.length > 4000 ? body.slice(0, 4000) + '\n…' : body;
      const cls = part.is_error ? 'tool-result error' : 'tool-result';
      blocks.push(
        `<details class="${cls}"><summary>tool result${part.is_error ? ' (error)' : ''}</summary><pre>${escapeHtml(cap)}</pre></details>`,
      );
    }
  }
  return blocks.join('');
}

function renderAssistantMessage(content: readonly MessagePart[]): string {
  const blocks: string[] = [];
  for (const part of content) {
    if (part.type === 'text') {
      blocks.push(`<div class="text">${renderMarkdown(part.text)}</div>`);
    } else if (part.type === 'tool_use') {
      const args = summarizeToolInput(part.input);
      blocks.push(
        `<details class="tool-use"><summary>${escapeHtml(part.name)}</summary><pre>${escapeHtml(args)}</pre></details>`,
      );
    }
    // thinking blocks: deliberately dropped (privacy — internal CoT
    // never shown in cc TUI either, must not leak via share).
  }
  return blocks.join('');
}

interface RenderedMessage {
  readonly role: 'user' | 'assistant';
  readonly timestamp: number | null;
  readonly html: string;
}

function parseJsonl(jsonl: string): RenderedMessage[] {
  const out: RenderedMessage[] = [];
  for (const line of jsonl.split('\n')) {
    if (line.trim() === '') continue;
    let row: JsonlRow;
    try {
      row = JSON.parse(line) as JsonlRow;
    } catch {
      continue;
    }
    const role = row.message?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const content = row.message?.content;
    if (content === undefined) continue;
    const ts = row.timestamp ? Date.parse(row.timestamp) : null;
    let html = '';
    if (role === 'user') {
      html = renderUserMessage(content);
    } else if (typeof content !== 'string') {
      html = renderAssistantMessage(content);
    }
    if (html === '') continue;
    out.push({ role, timestamp: Number.isNaN(ts) ? null : ts, html });
  }
  return out;
}

function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${mo}-${da} ${h}:${mi}`;
}

function formatTimeOfDay(ms: number): string {
  const d = new Date(ms);
  const h = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${mi}`;
}

function formatDay(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

export function renderShareHtml(input: RenderInput): string {
  const messages = parseJsonl(input.jsonl);
  const title = `${input.projectName} · ccanywhere share`;
  const meta = `由 <span class="by">${escapeHtml(input.createdBy)}</span> 分享`;
  // Show a timestamp banner only when there's a meaningful gap from
  // the previous message — within HALF_HOUR_MS we treat the
  // conversation as continuous and fold the timestamp. Role is
  // irrelevant; two assistant bursts 5 minutes apart share one stamp,
  // a user reply 1 hour later gets a fresh one.
  //
  // Same-day folding: once a banner with a given YYYY-MM-DD has been
  // emitted, subsequent banners that fall on the same day drop the
  // date prefix and show just HH:MM — the date stays implicit until a
  // day boundary is crossed.
  const HALF_HOUR_MS = 30 * 60 * 1000;
  let lastShownDay: string | null = null;
  const bodyParts: string[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    const prev = messages[i - 1];
    const showTime =
      m.timestamp !== null &&
      (prev === undefined ||
        prev.timestamp === null ||
        m.timestamp - prev.timestamp > HALF_HOUR_MS);
    if (showTime) {
      const day = formatDay(m.timestamp!);
      const label =
        lastShownDay === day
          ? formatTimeOfDay(m.timestamp!)
          : formatTimestamp(m.timestamp!);
      lastShownDay = day;
      bodyParts.push(`<time class="msg-time">${label}</time>`);
    }
    bodyParts.push(`<article class="msg ${m.role}">${m.html}</article>`);
  }
  const body = bodyParts.join('\n');
  const empty =
    messages.length === 0
      ? '<p style="color: var(--fg-muted)">（无内容）</p>'
      : '';
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
<script>${THEME_SCRIPT}</script>
</head>
<body>
<button id="theme-toggle" class="theme-toggle" type="button" aria-label="切换主题"></button>
<div class="container">
<header class="page">
<h1>${escapeHtml(input.projectName)}</h1>
<div class="meta">${meta}</div>
</header>
<main>
${body}${empty}
</main>
<footer class="page">ccanywhere · share <span class="by" style="font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace">${escapeHtml(input.shareCode)}</span></footer>
</div>
</body>
</html>`;
}
