import { STYLES, THEME_SCRIPT } from './render-assets.js';
import {
  composeMessageHtml,
  escapeHtml,
  parseJsonl,
  type RenderedMessage,
} from './render-parse.js';

/**
 * Programmatic cc jsonl → HTML renderer (m-share-static-export D1, D8;
 * m-share-export-cleanup adds rewind-aware path filtering + tool-call
 * folding via the parseJsonl helper in `render-parse.ts`).
 *
 * cc writes one message per line. We care about user / assistant rows on
 * the **active path** — everything off-path (rewind dead branches) plus
 * bookkeeping rows (permission-mode, file-history-snapshot, system
 * caveats, attachment) are skipped.
 *
 * Privacy: `thinking` blocks (Claude internal chain-of-thought) are
 * dropped — they're never shown to the cc user in TUI and shouldn't
 * leak into a public share. tool_use / tool_result are kept inside the
 * preceding assistant message (collapsed `<details>`) with a
 * "{N} tools used" footer.
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

/**
 * Build the chronological banner-message list. A timestamp banner only
 * shows when there's a meaningful gap from the previous message —
 * within HALF_HOUR_MS we treat the conversation as continuous and fold
 * the timestamp. Same-day banners drop the date prefix.
 */
function renderBody(messages: readonly RenderedMessage[]): string {
  const HALF_HOUR_MS = 30 * 60 * 1000;
  let lastShownDay: string | null = null;
  const parts: string[] = [];
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
      parts.push(`<time class="msg-time">${label}</time>`);
    }
    parts.push(
      `<article class="msg ${m.role}">${composeMessageHtml(m)}</article>`,
    );
  }
  return parts.join('\n');
}

export function renderShareHtml(input: RenderInput): string {
  const messages = parseJsonl(input.jsonl);
  const title = `${input.projectName} · ccanywhere share`;
  const meta = `由 <span class="by">${escapeHtml(input.createdBy)}</span> 分享`;
  const body = renderBody(messages);
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
<div class="container">
<header class="page">
<h1>${escapeHtml(input.projectName)}</h1>
<div class="meta">${meta}</div>
<button id="theme-toggle" class="theme-toggle" type="button" aria-label="切换主题"></button>
</header>
<main>
${body}${empty}
</main>
<footer class="page">ccanywhere · share <span class="by" style="font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace">${escapeHtml(input.shareCode)}</span></footer>
</div>
</body>
</html>`;
}
