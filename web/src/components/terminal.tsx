import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { CanvasAddon } from '@xterm/addon-canvas';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal, type ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { SessionState } from '../state/sessions.js';
import { recordOp } from '../state/ops-log.js';
import { useEffectiveTheme } from '../state/use-theme.js';
import { TerminalSocket } from '../ws.js';

type RendererKind = 'webgl' | 'canvas' | 'dom';

/**
 * Pick the xterm renderer. Default 'dom' — both WebGL (atlas
 * `_isDisposed` undefined on dispose) and Canvas (`loadCell` undefined
 * mid-render) addons reliably crash on Android Chrome under our usage
 * pattern (frequent session re-mount + ws reconnect snapshot). The DOM
 * renderer skips all atlas/GPU machinery and renders row <div>s
 * directly, side-stepping every atlas-vs-buffer race.
 *
 * Devs can override per-navigation with `?renderer=canvas|webgl|dom`.
 * The choice is NOT persisted to localStorage on purpose — leaving
 * stale 'webgl' / 'canvas' in storage was the trap that bit us. Override
 * is intentionally one-shot: next visit goes back to the safe default.
 */
function pickRenderer(): RendererKind {
  try {
    const q = new URLSearchParams(location.search).get('renderer');
    if (q === 'canvas' || q === 'dom' || q === 'webgl') return q;
  } catch {
    // URL parse failure; fall through
  }
  return 'dom';
}

interface Props {
  readonly sessionId: string;
  readonly onStatus?: (state: SessionState) => void;
  readonly onError?: (msg: string) => void;
  readonly onConnected?: () => void;
  readonly onReconnecting?: () => void;
  readonly onDead?: () => void;
}

export interface TerminalHandle {
  /** Send raw bytes to the PTY as if the user typed them. */
  input(data: string): void;
  /** Force-focus the underlying xterm. */
  focus(): void;
}

const THEMES: Record<'light' | 'dark', ITheme> = {
  dark: {
    background: '#0a0a0a',
    foreground: '#e6e6e6',
    cursor: '#e6e6e6',
    selectionBackground: '#3a3a3a',
  },
  light: {
    background: '#ffffff',
    foreground: '#1a1a1a',
    cursor: '#1a1a1a',
    selectionBackground: '#cfd8e3',
  },
};

const RESIZE_DEBOUNCE_MS = 100;
const FONT_SIZE_MIN = 8;
const FONT_SIZE_MAX = 32;
const FONT_SIZE_DEFAULT = 13;
const FONT_SIZE_LS_KEY = 'ccanywhere.fontSize';

function loadStoredFontSize(): number {
  try {
    const v = localStorage.getItem(FONT_SIZE_LS_KEY);
    if (v === null) return FONT_SIZE_DEFAULT;
    const n = Number.parseInt(v, 10);
    if (Number.isNaN(n)) return FONT_SIZE_DEFAULT;
    return Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, n));
  } catch {
    return FONT_SIZE_DEFAULT;
  }
}

const SNAPSHOT_CHUNK_BYTES = 4096;

/**
 * Write a large blob to xterm in RAF-paced chunks. Used for snapshot
 * frames (could be tens of KB after a long session); chunking keeps the
 * main thread responsive and gives canvas/webgl atlas time to settle
 * between writes — eliminating the "atlas-not-ready-mid-render" race
 * we hit with `term.write(huge)` earlier (`loadCell` undef on canvas,
 * `_isDisposed` undef on webgl during dispose).
 */
function chunkedWrite(term: Terminal, data: string): void {
  if (data.length <= SNAPSHOT_CHUNK_BYTES) {
    term.write(data);
    return;
  }
  let i = 0;
  const step = (): void => {
    if (i >= data.length) return;
    const end = Math.min(i + SNAPSHOT_CHUNK_BYTES, data.length);
    term.write(data.slice(i, end));
    i = end;
    if (i < data.length) requestAnimationFrame(step);
  };
  step();
}

export const TerminalView = forwardRef<TerminalHandle, Props>(function TerminalView(
  props,
  ref,
): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const sockRef = useRef<TerminalSocket | null>(null);
  const handlersRef = useRef(props);
  handlersRef.current = props;
  const effective = useEffectiveTheme();
  const effectiveRef = useRef(effective);
  effectiveRef.current = effective;

  useImperativeHandle(
    ref,
    () => ({
      input: (data: string) => {
        sockRef.current?.send({ type: 'input', data });
      },
      focus: () => {
        termRef.current?.focus();
      },
    }),
    [],
  );

  // Mount / remount when sessionId changes; auth comes from the session cookie.
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: loadStoredFontSize(),
      theme: THEMES[effectiveRef.current],
      convertEol: false,
      allowProposedApi: true,
      cursorBlink: true,
      scrollback: 5_000,
    });
    termRef.current = term;

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new Unicode11Addon());
    term.loadAddon(new WebLinksAddon());
    term.unicode.activeVersion = '11';
    term.open(container);

    const renderer = pickRenderer();
    recordOp('terminal.renderer', { kind: renderer });
    if (renderer === 'webgl') {
      try {
        // No onContextLoss handler — manually disposing the addon there
        // double-frees its internals, and the second pass via
        // term.dispose() → AddonManager crashes on `_isDisposed` of an
        // already-null atlas. Just let term own the lifecycle.
        term.loadAddon(new WebglAddon());
      } catch {
        // ignore — term continues with the default DOM renderer
      }
    } else if (renderer === 'canvas') {
      try {
        term.loadAddon(new CanvasAddon());
      } catch {
        // ignore
      }
    }
    // renderer === 'dom' uses xterm's built-in DOM renderer with no addon.

    try {
      fit.fit();
    } catch {
      // ignore — fit can fail when container has no size yet
    }

    const sock: TerminalSocket = new TerminalSocket(props.sessionId, {
      onSnapshot: (data) => {
        term.reset();
        chunkedWrite(term, data);
      },
      // Incremental delta on reconnect — DON'T reset; just append. With
      // the M-ws-seq-ack protocol the server sends incremental output
      // frames after reconnect (rather than a full snapshot reset),
      // letting the existing xterm buffer state carry through.
      onOutput: (data) => term.write(data),
      onStatus: (state) => handlersRef.current.onStatus?.(state),
      onError: (msg) => {
        term.write(`\r\n\x1b[31m[ws error: ${msg}]\x1b[0m\r\n`);
        handlersRef.current.onError?.(msg);
      },
      onConnected: () => {
        // Resize before any output: server defers the snapshot until our
        // first 'resize' so its screenState dimensions match our xterm
        // (otherwise the SerializeAddon-emitted cursor positions land in
        // the wrong rows and the TUI looks corrupted).
        try {
          fit.fit();
        } catch {
          // fit can fail mid-mount; ignore
        }
        sock.send({ type: 'resize', cols: term.cols, rows: term.rows });
        handlersRef.current.onConnected?.();
      },
      onReconnecting: () => handlersRef.current.onReconnecting?.(),
      onDead: () => handlersRef.current.onDead?.(),
    });
    sockRef.current = sock;

    const inputDisposer = term.onData((data) => sock.send({ type: 'input', data }));

    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const flushResize = (): void => {
      try {
        fit.fit();
      } catch {
        return;
      }
      sock.send({ type: 'resize', cols: term.cols, rows: term.rows });
    };
    const observer = new ResizeObserver(() => {
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(flushResize, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(container);

    // initial resize once mounted
    flushResize();

    // Disable native scroll on xterm's actual scroll container
    // (`.xterm-viewport`), not just our outer host div. cc spends ~all
    // its time in alt-screen — there is genuinely nothing to scroll —
    // and Android Chrome's inertial wheel events on .xterm-viewport
    // desync xterm's row state, causing duplicated/dropped rows in
    // cursor-positioned regions (banner, status line). See xterm.js#1007
    // and copilot-cli#1805 ("rocket scroll fix"). The bulk is done in
    // app.css with `.terminal-host .xterm-viewport { ... }`; this code
    // path is a no-op now (kept for future alt/normal-mode toggles).
    const noopBufferDisposer = term.buffer.onBufferChange(() => {
      /* no-op — viewport scroll is killed at the CSS layer */
    });

    // Touch handling on the terminal area:
    //
    //   - 2-finger pinch: scale xterm font size (handler preventDefault to
    //     keep the OS from doing native viewport zoom on top of ours).
    //
    //   - 1-finger drag (move > threshold): preventDefault so the browser
    //     doesn't synthesize mouse events from the touch sequence. Without
    //     this, swiping over .xterm-screen lights up xterm's selection
    //     service (built on mousedown/mousemove/mouseup), which paints
    //     stray highlight cells on top of cc's TUI redraw — the "向上拖动
    //     就会在上面额外绘制" report. Tap-and-release stays untouched, so
    //     long-press copy / system text-selection on highlighted cells
    //     still works.
    const TAP_THRESHOLD_PX = 6;
    let pinchBase: { dist: number; fontSize: number } | null = null;
    let singleTouchStart: { x: number; y: number } | null = null;
    let singleTouchDragging = false;
    const fingerDistance = (t: TouchList): number => {
      if (t.length < 2) return 0;
      const a = t[0]!;
      const b = t[1]!;
      return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    };
    const onTouchStart = (e: TouchEvent): void => {
      if (e.touches.length === 2) {
        pinchBase = {
          dist: fingerDistance(e.touches),
          fontSize: term.options.fontSize ?? FONT_SIZE_DEFAULT,
        };
        singleTouchStart = null;
        singleTouchDragging = false;
        e.preventDefault();
        return;
      }
      if (e.touches.length === 1) {
        const t = e.touches[0]!;
        singleTouchStart = { x: t.clientX, y: t.clientY };
        singleTouchDragging = false;
      }
    };
    const onTouchMove = (e: TouchEvent): void => {
      if (e.touches.length === 2 && pinchBase !== null) {
        const ratio = fingerDistance(e.touches) / pinchBase.dist;
        const next = Math.max(
          FONT_SIZE_MIN,
          Math.min(FONT_SIZE_MAX, Math.round(pinchBase.fontSize * ratio)),
        );
        if (next !== term.options.fontSize) {
          term.options.fontSize = next;
          try {
            fit.fit();
          } catch {
            // fit can throw mid-resize; flushResize will reconcile via observer
          }
        }
        e.preventDefault();
        return;
      }
      if (e.touches.length === 1 && singleTouchStart !== null) {
        const t = e.touches[0]!;
        const dx = Math.abs(t.clientX - singleTouchStart.x);
        const dy = Math.abs(t.clientY - singleTouchStart.y);
        if (singleTouchDragging || dx + dy > TAP_THRESHOLD_PX) {
          singleTouchDragging = true;
          // prevent the OS from generating mouse events that would feed
          // xterm's selection service — that's what painted the stray
          // highlight rows on drag.
          e.preventDefault();
        }
      }
    };
    const onTouchEnd = (e: TouchEvent): void => {
      if (e.touches.length < 2 && pinchBase !== null) {
        try {
          localStorage.setItem(
            FONT_SIZE_LS_KEY,
            String(term.options.fontSize ?? FONT_SIZE_DEFAULT),
          );
        } catch {
          // localStorage can be denied in private mode; ignore
        }
        pinchBase = null;
      }
      if (e.touches.length === 0) {
        singleTouchStart = null;
        singleTouchDragging = false;
      }
    };
    container.addEventListener('touchstart', onTouchStart, { passive: false });
    container.addEventListener('touchmove', onTouchMove, { passive: false });
    container.addEventListener('touchend', onTouchEnd);
    container.addEventListener('touchcancel', onTouchEnd);

    return () => {
      observer.disconnect();
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      container.removeEventListener('touchstart', onTouchStart);
      container.removeEventListener('touchmove', onTouchMove);
      container.removeEventListener('touchend', onTouchEnd);
      container.removeEventListener('touchcancel', onTouchEnd);
      noopBufferDisposer.dispose();
      inputDisposer.dispose();
      sock.close();
      sockRef.current = null;
      // Wrap term.dispose() in try/catch: even when we never manually
      // dispose the addon, xterm-addon-webgl's atlas dispose path can
      // throw on stale GPU state (`_isDisposed` undefined). The React
      // tree is unmounting either way; swallow + record so the next
      // feedback carries the trace instead of triggering another
      // ErrorBoundary cycle.
      try {
        term.dispose();
      } catch (err) {
        recordOp('terminal.dispose.error', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.sessionId]);

  // Theme switching without remount.
  useEffect(() => {
    const term = termRef.current;
    if (term !== null) term.options.theme = THEMES[effective];
  }, [effective]);

  return <div ref={containerRef} className="terminal-view" />;
});
