/**
 * Inline CSS + theme-toggle JS for the share view.
 * Extracted from render.ts purely to keep render.ts under
 * the project's 300-line cap; nothing here is tunable per-render.
 *
 * CSS variables follow ccanywhere's main app token names so the share
 * view feels consistent with workspace pages even though it's fully
 * standalone (no shared bundle).
 */

export const STYLES = `
  :root[data-theme="dark"] {
    --bg: #0a0a0a; --bg-elevated: #161616; --fg: #e6e6e6;
    --fg-muted: #8a8a8a; --border: #2a2a2a; --brand: #6b7cff;
    --warning: #f5a623; --danger: #e85a4f;
    /* Chat bubble tints — user side leans on brand at low alpha so
     * fg stays the regular text color (code blocks inside survive). */
    --bubble-user: #1d2138;
    --bubble-assistant: #161616;
  }
  :root[data-theme="light"] {
    --bg: #ffffff; --bg-elevated: #f5f5f5; --fg: #1a1a1a;
    --fg-muted: #6a6a6a; --border: #e0e0e0; --brand: #4a5cde;
    --warning: #c87f00; --danger: #c0392b;
    --bubble-user: #e8ecff;
    --bubble-assistant: #f5f5f5;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg); }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    font-size: 14px; line-height: 1.5;
  }
  .container { max-width: 900px; margin: 0 auto; padding: 24px 16px 80px; }
  header.page {
    /* : one unified sticky bar carries project
     * name + meta + theme chip. sticky preserves layout space so
     * message bubbles flow below it (not under). position:relative
     * is the positioning context for the absolute-positioned chip
     * inside; padding-right reserves space for the chip so long
     * project names don't run under it. */
    position: sticky; top: 0; z-index: 10;
    background: var(--bg);
    display: flex; flex-direction: column; gap: 4px;
    padding: 12px 56px 16px 0; margin-bottom: 24px;
    border-bottom: 1px solid var(--border);
    transition: padding 120ms ease-out;
  }
  /* B28: once user scrolls past the
   * sentinel, IntersectionObserver toggles .shrunk on header. mobile
   * only — desktop keeps comfortable spacing. */
  .sticky-sentinel { height: 1px; margin-top: -1px; }
  @media (max-width: 768px) {
    header.page.shrunk {
      padding-top: 4px;
      padding-bottom: 6px;
    }
    header.page.shrunk h1 { font-size: 15px; }
  }
  header.page h1 { margin: 0; font-size: 18px; font-weight: 600; }
  header.page .meta { font-size: 12px; color: var(--fg-muted); }
  header.page .meta .by { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  header.page .theme-toggle {
    /* Pinned to the header bar (not viewport), so it scrolls with the
     * unified sticky bar instead of floating independently. Visual
     * position: header bar's top-right within the centered container. */
    position: absolute; top: 8px; right: 0;
    border: 1px solid var(--border); background: var(--bg-elevated);
    color: var(--fg); border-radius: 4px; padding: 4px 8px;
    font-size: 12px; cursor: pointer;
  }
  /* Chat-bubble layout: user right, assistant left. Role labels are
   * dropped (the side + tint conveys it); a tiny <time> footer sits
   * inside the bubble for context. max-width keeps short messages
   * from stretching across the entire column. */
  article.msg {
    /* width: fit-content lets short bubbles hug their text instead of
     * stretching to the 78% cap; long messages still grow up to 78%
     * (or 100% via the :has(pre) override below). */
    width: fit-content;
    max-width: 78%;
    margin: 4px 0;
    padding: 10px 14px;
    border-radius: 12px;
    word-wrap: break-word;
    position: relative;
  }
  article.msg.user {
    margin-left: auto;
    margin-right: 0;
    background: var(--bubble-user);
    border-bottom-right-radius: 4px;
  }
  article.msg.assistant {
    margin-left: 0;
    margin-right: auto;
    background: var(--bubble-assistant);
    border: 1px solid var(--border);
    border-bottom-left-radius: 4px;
  }
  /* Bubbles containing code blocks / tool details / wide content take
   * the full row — 78% squeeze cramps long pre and forces horizontal
   * scroll inside the bubble at narrow viewports. has(pre) selector
   * is supported in all modern mobile browsers (iOS 15.4+, Android
   * Chrome 105+). */
  article.msg:has(pre) {
    max-width: 100%;
  }
  /* Group divider — only emitted when the gap from the previous
   * message exceeds 30 min (see render.ts). Deliberately quiet:
   * 10px mono, half opacity, tight margin so the banner reads as a
   * subtle separator rather than a label. */
  time.msg-time {
    display: block;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 10px;
    color: var(--fg-muted);
    text-align: center;
    margin: 10px auto 4px;
    opacity: 0.5;
  }
  time.msg-time:first-child {
    margin-top: 0;
  }
  .text { word-wrap: break-word; }
  .text p { margin: 6px 0; }
  .text pre {
    background: var(--bg); border: 1px solid var(--border);
    border-radius: 4px; padding: 8px 12px;
    overflow-x: auto; font-size: 12.5px; line-height: 1.45;
  }
  .text code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.9em; background: var(--bg); padding: 1px 4px;
    border-radius: 2px;
  }
  .text pre code { background: transparent; padding: 0; border-radius: 0; }
  .text h1, .text h2, .text h3 { margin: 12px 0 6px; }
  .text ul, .text ol { margin: 6px 0; padding-left: 24px; }
  .text blockquote {
    margin: 6px 0; padding: 2px 12px; color: var(--fg-muted);
    border-left: 2px solid var(--border);
  }
  .text a { color: var(--brand); }
  .tools-footer {
    margin: 6px 0 0;
    font-size: 11px; color: var(--fg-muted); text-align: right;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  footer.page {
    margin-top: 32px; padding-top: 16px;
    border-top: 1px solid var(--border);
    font-size: 11px; color: var(--fg-muted); text-align: center;
  }
`;

/**
 * B28: shrink header.page when user scrolls below the first 1px of
 * content (sentinel). IntersectionObserver fires reliably across
 * mobile browsers; falls back to no-op when IO is unavailable (very
 * old browsers — header just stays at full padding, no harm).
 */
export const STICKY_SHRINK_SCRIPT = `(function(){
  if(!window.IntersectionObserver)return;
  document.addEventListener('DOMContentLoaded',function(){
    var s=document.querySelector('.sticky-sentinel');
    var h=document.querySelector('header.page');
    if(!s||!h)return;
    var io=new IntersectionObserver(function(es){
      es.forEach(function(e){
        if(e.isIntersecting)h.classList.remove('shrunk');
        else h.classList.add('shrunk');
      });
    });
    io.observe(s);
  });
})();`;

export const THEME_SCRIPT = `(function(){
  var k='ccanywhere-share.theme';
  var t=localStorage.getItem(k);
  if(!t){
    t=(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches)?'dark':'light';
  }
  document.documentElement.setAttribute('data-theme',t);
  document.addEventListener('DOMContentLoaded',function(){
    var btn=document.getElementById('theme-toggle');
    if(!btn)return;
    var update=function(){btn.textContent=(document.documentElement.getAttribute('data-theme')==='dark')?'☀':'☾';};
    update();
    btn.addEventListener('click',function(){
      var next=(document.documentElement.getAttribute('data-theme')==='dark')?'light':'dark';
      document.documentElement.setAttribute('data-theme',next);
      localStorage.setItem(k,next);
      update();
    });
  });
})();`;
