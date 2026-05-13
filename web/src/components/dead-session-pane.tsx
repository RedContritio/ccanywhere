import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { api } from '../api.js';
import { recordOp } from '../state/ops-log.js';
import { useEffectiveTheme } from '../state/use-theme.js';
import {
  FONT_FAMILY_DEFAULT,
  loadStoredFontSize,
  THEMES,
} from './terminal-config.js';

interface Props {
  readonly sessionId: string;
}

/**
 * Readonly dead-session preview using xterm's default DOM renderer +
 * native mobile selection.
 *
 * History (m-dead-pane-touch-select):
 *   - P3 synthetic mouse events for long-press; xterm canvas pixels
 *     aren't native HTML text so mobile got no system handles.
 *   - P4 transparent <pre> overlay on canvas; sub-pixel alignment
 *     failed at dpr=3.25 + z-index/pointer-events broke sibling layout.
 *   - P5 pure plain-text <pre>, no xterm; lost ANSI colors and user
 *     reported the text layer still felt misaligned at edges.
 *   - P6 xterm's default DOM renderer (no WebGL/Canvas addon load) —
 *     each cell is a real <span> with inline fg/bg, xterm's own
 *     metrics guarantee alignment, ANSI colors preserved. Overriding
 *     xterm.css's `.xterm { user-select: none }` via xterm-overrides
 *     scoped to `[data-dead-pane="true"]` unlocks the spans for
 *     selection. User reported "偶尔无法选中".
 *   - P7 (current): capture-phase mouse* stop. xterm SelectionService
 *     registers a mousedown listener on `.xterm` that calls
 *     `event.preventDefault()` (SelectionService.ts:467) to block
 *     browser native selection in favor of its own canvas-overlay
 *     selection. Mobile touch→mouse translation fires mousedown and
 *     xterm wins the race, swallowing native selection. Stopping
 *     mouse* events at capture phase before they reach xterm cuts
 *     this — touch events are untouched so OS-level long-press still
 *     drives selection directly on the DOM spans.
 *
 * Net: no synthetic events, no overlay, no two-layer alignment, no
 * race. Mobile native long-press selection works reliably on the
 * xterm DOM spans with preserved ANSI colors.
 *
 * DOM renderer perf cost (~700ms first paint on mobile) is one-shot
 * and acceptable for a static snapshot. cols/rows fixed at 100×30
 * default — non-default session dims persisted in metadata is future
 * work.
 */
export function DeadSessionSnapshot({ sessionId }: Props): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const effective = useEffectiveTheme();

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    let cancelled = false;
    let term: Terminal | null = null;

    void (async () => {
      let snapshot: string;
      try {
        snapshot = await api<string>(
          `/api/sessions/${encodeURIComponent(sessionId)}/screen`,
        );
      } catch (err) {
        recordOp('dead-session.screen-fetch-failed', {
          message: err instanceof Error ? err.message : 'unknown',
        });
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'screen fetch failed');
        }
        return;
      }
      if (cancelled) return;
      const t = new Terminal({
        cols: 100,
        rows: 30,
        cursorBlink: false,
        disableStdin: true,
        scrollback: 0,
        theme: THEMES[effective],
        fontFamily: FONT_FAMILY_DEFAULT,
        fontSize: loadStoredFontSize(),
        allowProposedApi: true,
      });
      // Default DOM renderer — NO WebglAddon/CanvasAddon load.
      t.open(container);
      t.write(snapshot);
      // xterm's offscreen <textarea> grabs focus on mobile tap and
      // pops the soft keyboard. Disable it so it can't be focused.
      const ta = t.textarea;
      if (ta !== undefined) {
        ta.disabled = true;
      }
      term = t;
    })();

    // m-dead-pane-touch-select P7: xterm's SelectionService registers a
    // mousedown listener on `.xterm` that calls `event.preventDefault()`
    // (SelectionService.ts:467) to block "regular" browser selection in
    // favor of its own canvas-overlay selection. P6 enabled user-select
    // on the spans, but on mobile touch→mouse translation fires
    // mousedown and xterm's listener wins the race, swallowing the
    // selection. User saw this as "偶尔无法选中".
    //
    // Stop mouse* events at capture phase before they reach xterm. The
    // helper textarea is already disabled, dead pane has no real mouse
    // interaction (Resume / Delete live in the header outside this
    // container), so cutting all mouse routing through xterm has no
    // downside. touch events are left alone — mobile's OS-level long-
    // press selection works on the underlying DOM spans regardless of
    // JS listeners.
    const stopMouse = (e: Event): void => e.stopImmediatePropagation();
    container.addEventListener('mousedown', stopMouse, { capture: true });
    container.addEventListener('mousemove', stopMouse, { capture: true });
    container.addEventListener('mouseup', stopMouse, { capture: true });
    container.addEventListener('contextmenu', stopMouse, { capture: true });

    return () => {
      cancelled = true;
      container.removeEventListener('mousedown', stopMouse, { capture: true });
      container.removeEventListener('mousemove', stopMouse, { capture: true });
      container.removeEventListener('mouseup', stopMouse, { capture: true });
      container.removeEventListener('contextmenu', stopMouse, { capture: true });
      try {
        term?.dispose();
      } catch {
        // best effort
      }
    };
  }, [sessionId, effective]);

  return (
    <>
      <div
        ref={containerRef}
        aria-readonly="true"
        data-dead-pane="true"
        className="absolute inset-0 p-2"
      />
      {error !== null && (
        <p
          role="alert"
          className="absolute top-2 left-2 font-mono text-xs text-danger"
        >
          读取快照失败：{error}
        </p>
      )}
    </>
  );
}
