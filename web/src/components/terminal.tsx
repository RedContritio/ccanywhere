import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { CanvasAddon } from '@xterm/addon-canvas';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { setActiveTerm } from '../state/diag.js';
import { recordOp, recordOpThrottled } from '../state/ops-log.js';
import type { SessionState } from '../state/sessions.js';
import { useEffectiveTheme } from '../state/use-theme.js';
import { TerminalSocket, type DeadReason } from '../ws.js';
import { setupTerminalSocket } from './terminal-socket-setup.js';
import {
  FONT_FAMILY_DEFAULT,
  loadStoredFontSize,
  pickRenderer,
  THEMES,
} from './terminal-config.js';
import { setupDimsStateMachine } from './terminal-dims.js';
import { setupKeyboardOverlay } from './terminal-keyboard-overlay.js';
import { setupTouchInteraction } from './terminal-touch.js';

interface Props {
  readonly sessionId: string;
  readonly onStatus?: (state: SessionState) => void;
  readonly onError?: (msg: string) => void;
  readonly onConnected?: () => void;
  readonly onReconnecting?: () => void;
  readonly onDead?: (reason: DeadReason) => void;
  /** : server gate rejected this turn's input. */
  readonly onQuotaExhausted?: (reason: string) => void;
  /** : first snapshot/output frame delivered. */
  readonly onFirstData?: () => void;
}

export interface TerminalHandle {
  /** Send raw bytes to the PTY as if the user typed them. */
  input(data: string): void;
  /** Force-focus the underlying xterm. */
  focus(): void;
}

export const TerminalView = forwardRef<TerminalHandle, Props>(function TerminalView(
  props,
  ref,
): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const placeholderRef = useRef<HTMLDivElement>(null);
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
    const placeholder = placeholderRef.current;
    if (container === null || placeholder === null) return;
    // Keyboard channel reserves keyboardH as padding-bottom on the
    // pane container ([data-pane-content]) so flex children
    // (terminal host + MobileToolbar) shrink to fit above the keyboard.
    // The shrink fires ResizeObserver → dims state machine → resize frame
    // → cc draws into the visible region. terminal header stays pinned
    // (it's outside the pane). See terminal-keyboard-overlay.ts for the
    // history (earlier translateY-based approach left cc with stale
    // `rows`, so cursor / new output drew behind the keyboard).
    const { captureViewportMetrics, cleanup: cleanupKeyboardOverlay } =
      setupKeyboardOverlay(container);

    // ── Terminal — mounted early; placeholder covers it until stable ─
    const term = new Terminal({
      fontFamily: FONT_FAMILY_DEFAULT,
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
        term.loadAddon(new WebglAddon());
      } catch {
        // ignore — DOM renderer continues to work
      }
    } else if (renderer === 'canvas') {
      try {
        term.loadAddon(new CanvasAddon());
      } catch {
        // ignore
      }
    }
    // Initial `fit.fit` here MAY produce wrong dims if the layout
    // hasn't settled (mobile mount). That's OK — we don't send those
    // dims to the server until the dims state machine reaches `stable`.
    try {
      fit.fit();
    } catch {
      // ignore
    }

    const sock = setupTerminalSocket(props.sessionId, term, () => handlersRef.current);
    sockRef.current = sock;

    // ── Disposers + listeners ────────────────────────────────────────
    const bufferDisposer = term.buffer.onBufferChange((newBuffer) => {
      recordOp('term.buffer.change', { type: newBuffer.type });
    });
    // xterm exposes `onScroll(ydisp)` — fires whenever the viewport
    // shifts within the scrollback (normal screen). This is the real
    // "page" event when the user drags: ydisp changes but no PTY input
    // is emitted, so all our other traces missed it.
    const scrollDisposer = term.onScroll((ydisp) => {
      recordOp('term.scroll', {
        ydisp,
        viewportY: term.buffer.active.viewportY,
        baseY: term.buffer.active.baseY,
        cursorY: term.buffer.active.cursorY,
      });
    });
    const selectionDisposer = term.onSelectionChange(() => {
      const sel = term.getSelection();
      recordOp('term.selection', {
        empty: sel.length === 0,
        len: sel.length,
        sample: sel.slice(0, 40),
      });
    });
    const inputDisposer = term.onData((data) => {
      // Trace what the user / xterm internals actually pushes back to
      // the PTY. `sample` keeps the first ~20 bytes hex-escaped so we
      // can see arrow keys / mouse-tracking sequences without leaking
      // secrets typed at the prompt (the `len` reveals magnitude on
      // its own).
      const sample = data
        .slice(0, 20)
        .replace(/[\x00-\x1f\x7f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
      recordOp('term.input', { len: data.length, sample });
      sock.send({ type: 'input', data });
    });

    const touch = setupTouchInteraction(container, term, fit);


    setActiveTerm({
      term,
      ws: sock,
      sessionId: props.sessionId,
      rendererKind: renderer,
      lastWriteTs: 0,
    });

    const dims = setupDimsStateMachine({
      container,
      term,
      fit,
      sock,
      placeholder,
      refreshCellHeight: touch.refreshCellHeight,
      captureViewportMetrics,
    });

    // React StrictMode dev 故意双调 cleanup. xterm.js 5.x term.dispose
    // 不 idempotent — 第二次抛 `_isDisposed` undefined. flag guard
    // 整个 cleanup 让它真 idempotent.
    let cleanedUp = false;
    return () => {
      if (cleanedUp) return;
      cleanedUp = true;
      dims.cleanup();
      cleanupKeyboardOverlay();
      touch.cleanup();
      bufferDisposer.dispose();
      scrollDisposer.dispose();
      selectionDisposer.dispose();
      inputDisposer.dispose();
      sock.close();
      sockRef.current = null;
      setActiveTerm(null);
      try {
        term.dispose();
      } catch (err) {
        recordOp('terminal.dispose.error', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
      termRef.current = null;
    };
     
  }, [props.sessionId]);

  // Theme switching without remount.
  useEffect(() => {
    const term = termRef.current;
    if (term !== null) term.options.theme = THEMES[effective];
  }, [effective]);

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="absolute inset-0 p-2" />
      <div
        ref={placeholderRef}
        aria-hidden="true"
        className="absolute inset-0 z-10 flex items-center justify-center bg-bg font-mono"
      >
        <span className="inline-block h-4 w-2 animate-pulse bg-fg" />
        <span className="ml-3 text-xs text-fg-muted opacity-60">连接中…</span>
      </div>
    </div>
  );
});
