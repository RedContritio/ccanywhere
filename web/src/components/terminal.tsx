import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { CanvasAddon } from '@xterm/addon-canvas';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal, type ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { noteTermWrite, setActiveTerm } from '../state/diag.js';
import { recordOp, recordOpThrottled } from '../state/ops-log.js';
import type { SessionState } from '../state/sessions.js';
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
function chunkedWrite(term: Terminal, data: string, source: 'snapshot' | 'output'): void {
  if (data.length === 0) return;
  // Trace which buffer kind we wrote into ('normal' | 'alternate') and
  // the data length — together with the source ('snapshot' resets first,
  // 'output' appends), this is enough to spot interleavings between a
  // mid-flight snapshot RAF queue and an arriving output frame.
  const bufType = term.buffer.active.type;
  if (data.length <= SNAPSHOT_CHUNK_BYTES) {
    recordOp('term.write', { source, buf: bufType, len: data.length });
    try {
      term.write(data);
      noteTermWrite();
    } catch (err) {
      recordOp('term.write.error', {
        message: err instanceof Error ? err.message : String(err),
        len: data.length,
      });
    }
    return;
  }
  let i = 0;
  recordOp('term.write', {
    source,
    buf: bufType,
    len: data.length,
    chunked: true,
  });
  const step = (): void => {
    if (i >= data.length) return;
    const end = Math.min(i + SNAPSHOT_CHUNK_BYTES, data.length);
    try {
      term.write(data.slice(i, end));
      noteTermWrite();
    } catch (err) {
      recordOp('term.write.error', {
        message: err instanceof Error ? err.message : String(err),
        offset: i,
        len: data.length,
      });
      return;
    }
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
        recordOp('term.reset', { reason: 'snapshot' });
        term.reset();
        chunkedWrite(term, data, 'snapshot');
      },
      // Incremental delta on reconnect — DON'T reset; just append. With
      // the M-ws-seq-ack protocol the server sends incremental output
      // frames after reconnect (rather than a full snapshot reset),
      // letting the existing xterm buffer state carry through.
      onOutput: (data) => chunkedWrite(term, data, 'output'),
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

    setActiveTerm({
      term,
      ws: sock,
      sessionId: props.sessionId,
      rendererKind: renderer,
      lastWriteTs: 0,
    });

    const inputDisposer = term.onData((data) => sock.send({ type: 'input', data }));

    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const flushResize = (): void => {
      const before = { cols: term.cols, rows: term.rows };
      try {
        fit.fit();
      } catch {
        return;
      }
      const after = { cols: term.cols, rows: term.rows };
      if (before.cols !== after.cols || before.rows !== after.rows) {
        recordOp('term.resize', { from: before, to: after });
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

    // Buffer change tracing — every alt-screen entry/exit shows up here.
    // This is the keystone for diagnosing the "two banners on screen" bug:
    // if cc enters alt-screen during reconnect/SIGWINCH, the normal buffer
    // shouldn't accumulate banner copies; if it doesn't enter alt-screen
    // (or exits unexpectedly), we'll see the toggle here.
    const bufferDisposer = term.buffer.onBufferChange((newBuffer) => {
      recordOp('term.buffer.change', { type: newBuffer.type });
    });

    // Selection change tracing — original report for #24 said 1-finger
    // drag paints stray highlight rows. If xterm's selection service is
    // still being activated despite our touchmove preventDefault, every
    // drag will fire onSelectionChange with a non-empty selection, and
    // we'll see exactly when (relative to touch ops below).
    const selectionDisposer = term.onSelectionChange(() => {
      const sel = term.getSelection();
      recordOp('term.selection', {
        empty: sel.length === 0,
        len: sel.length,
        sample: sel.slice(0, 40),
      });
    });

    // mousedown capture-phase trace. Mobile browsers synthesize mouse
    // events from a touch sequence after touchend (or sometimes during a
    // sufficiently slow drag); we register at capture phase so we see
    // them *before* xterm's own mousedown listener inside selection
    // service can act, even if our touchmove preventDefault failed.
    const onMouseDownCapture = (e: MouseEvent): void => {
      const target = e.target as Element | null;
      const klass = target?.className ?? '';
      recordOpThrottled(
        'mouse.down',
        {
          targetClass: typeof klass === 'string' ? klass.slice(0, 80) : String(klass).slice(0, 80),
          button: e.button,
          buttons: e.buttons,
        },
        50,
      );
    };
    container.addEventListener('mousedown', onMouseDownCapture, { capture: true });

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
      recordOp('touch.start', { fingers: e.touches.length });
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
        recordOpThrottled('touch.pinch', { fingers: 2 }, 100);
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
          if (!singleTouchDragging) {
            recordOp('touch.drag.start', { dx, dy });
          }
          recordOpThrottled('touch.drag.move', { dx, dy }, 100);
          singleTouchDragging = true;
          // prevent the OS from generating mouse events that would feed
          // xterm's selection service — that's what painted the stray
          // highlight rows on drag.
          e.preventDefault();
        }
      }
    };
    const onTouchEnd = (e: TouchEvent): void => {
      recordOp('touch.end', {
        remaining: e.touches.length,
        wasDragging: singleTouchDragging,
        wasPinch: pinchBase !== null,
      });
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
      setActiveTerm(null);
      observer.disconnect();
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      container.removeEventListener('touchstart', onTouchStart);
      container.removeEventListener('touchmove', onTouchMove);
      container.removeEventListener('touchend', onTouchEnd);
      container.removeEventListener('touchcancel', onTouchEnd);
      container.removeEventListener('mousedown', onMouseDownCapture, { capture: true });
      bufferDisposer.dispose();
      selectionDisposer.dispose();
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
