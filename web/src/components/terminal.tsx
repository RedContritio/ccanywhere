/* eslint-disable max-lines -- TODO(m-lint-cap phase 4): componentize useTerminalConnection / TerminalHeader */
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
import { TerminalSocket, type DeadReason } from '../ws.js';
import {
  dimsReducer,
  INITIAL_DIMS_STATE,
  type DimsEvent,
  type DimsState,
} from './dims-state.js';

type RendererKind = 'webgl' | 'canvas' | 'dom';

/**
 * Pick the xterm renderer. Default 'webgl':
 *
 * 1. DOM renderer rebuilds all cell <span> children on every row paint
 *    (~1500 DOM mutations × 30-80 ms on mobile = 700 ms touchmove stalls
 *    during fast scrollback drag). Caught in feedback 2d2f1c7d.
 * 2. Canvas addon (`@xterm/addon-canvas`) is deprecated upstream and
 *    has known atlas / sub-pixel issues at high dpr. Feedback 0d84f615
 *    confirmed: smooth performance but visually corrupted output ("渲染
 *    全乱了") — a paint-layer bug we don't own.
 * 3. WebGL is the actively maintained path; uses GPU atlas without DOM
 *    mutations and gets correctness fixes upstream.
 *
 * Earlier feedback (e409ec50, 1a1fd3d7) recorded `_isDisposed undef`
 * crashes on webgl. Those traces predate the current code paths
 * (dims-state lifecycle + visualViewport channel + cleaner dispose
 * order — we removed the manual `webgl?.dispose()` chain a few commits
 * ago specifically because it double-freed). If crashes resurface,
 * they signal a remaining state-management bug to fix, not a reason
 * to fall back.
 *
 * Devs can override per-navigation with `?renderer=canvas|webgl|dom`.
 * The choice is NOT persisted to localStorage — a one-shot URL knob
 * for forcing dom/canvas on a problem device, not a sticky preference.
 */
function pickRenderer(): RendererKind {
  try {
    const q = new URLSearchParams(location.search).get('renderer');
    if (q === 'canvas' || q === 'dom' || q === 'webgl') return q;
  } catch {
    // URL parse failure; fall through
  }
  return 'webgl';
}

interface Props {
  readonly sessionId: string;
  readonly onStatus?: (state: SessionState) => void;
  readonly onError?: (msg: string) => void;
  readonly onConnected?: () => void;
  readonly onReconnecting?: () => void;
  readonly onDead?: (reason: DeadReason) => void;
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

// Font size bounds for pinch-zoom. References:
//   - 8 px is the smallest size where monospace glyphs (especially CJK
//     box drawing) remain legible without sub-pixel hinting.
//   - 32 px caps zoom to roughly 4× default (13 → 32 ≈ 2.5× linear),
//     beyond which the terminal grid shrinks to so few rows/cols that
//     cc TUI breaks layout.
//   - 13 px default = browser body default 14 px font – 1 to make
//     monospace match surrounding UI text height visually.
const FONT_SIZE_MIN = 8;
const FONT_SIZE_MAX = 32;
const FONT_SIZE_DEFAULT = 13;
const FONT_SIZE_LS_KEY = 'ccanywhere.fontSize';

// Quiescence threshold derivation — see
// openspec/changes/m-mobile-fit-timing/design.md "QUIESCENCE_MS 推导".
// Don't tune the constant directly; adjust the inputs.
const LAYOUT_TRANSITION_UPPER_BOUND_MS = 250;
const QUIESCENCE_SAFETY = 1.2;
const QUIESCENCE_MS = Math.ceil(LAYOUT_TRANSITION_UPPER_BOUND_MS * QUIESCENCE_SAFETY); // 300

// Aligned with server-side `fallbackTimer` (1500 ms in src/ws/server.ts).
// Why 5 × QUIESCENCE_MS: the dims state machine retries quiescence on
// every layout pulse; if 5 quiescence windows pass without ever
// reaching `stable`, the layout is genuinely pathological (continuous
// jitter > 1.2 s) and we should fall back to a direct measurement.
// 5× also matches the server's safety margin: server gives the client
// 5 quiescence windows worth of time to settle before sending its own
// fallback initial state.
const MAX_WAIT_MS = QUIESCENCE_MS * 5;

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

// Chunk size for chunkedWrite's RAF-paced writes. Picked at 4 KiB
// because:
//   - The longest plausible single ANSI escape sequence (e.g. SGR with
//     RGB color, sub-string OSC) is well under 256 bytes; 4 KiB makes
//     escape splitting across chunks vanishingly rare.
//   - 4 KiB written into xterm's dom renderer + parser stays well
//     under one frame at 60 fps (~16 ms budget) on mid-range mobile,
//     so the RAF cadence keeps main thread responsive.
//   - Smaller (1 KiB) costs more RAF round-trips for the same data;
//     larger (16 KiB+) starts to risk frame drops on slower devices.
const SNAPSHOT_CHUNK_BYTES = 4096;

function chunkedWrite(term: Terminal, data: string, source: 'snapshot' | 'output'): void {
  if (data.length === 0) return;
  const bufType = term.buffer.active.type;
  if (data.length <= SNAPSHOT_CHUNK_BYTES) {
    const t0 = performance.now();
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
    recordOp('term.write.done', {
      source,
      len: data.length,
      ms: Math.round(performance.now() - t0),
    });
    return;
  }
  let i = 0;
  const t0 = performance.now();
  recordOp('term.write', {
    source,
    buf: bufType,
    len: data.length,
    chunked: true,
  });
  const step = (): void => {
    if (i >= data.length) return;
    const end = Math.min(i + SNAPSHOT_CHUNK_BYTES, data.length);
    const tickT0 = performance.now();
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
    recordOp('term.write.raf', {
      source,
      offset: i,
      chunkLen: end - i,
      ms: Math.round(performance.now() - tickT0),
    });
    i = end;
    if (i < data.length) requestAnimationFrame(step);
    else {
      recordOp('term.write.done', {
        source,
        len: data.length,
        ms: Math.round(performance.now() - t0),
      });
    }
  };
  step();
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
    // The visual-viewport translateY is applied to .terminal-pane-content —
    // a sub-container that wraps just [terminal-host + MobileToolbar],
    // NOT the terminal-header (汉堡 + session name + ws-conn chip). When
    // the keyboard opens, those two shift up together so cursor row +
    // virtual keys land above the keyboard, while the terminal-header
    // stays pinned in its original layout position. Caught in feedback
    // 4cc189f4 — earlier we translated the whole .terminal-pane and the
    // top-bar (terminal-header) went up with it, which the user reported
    // as "top bar 不停住".
    const pane = container.closest('.terminal-pane-content') as HTMLElement | null;

    // ── Visual viewport (keyboard overlay) channel ────────────────────
    // Translate .terminal-pane up by visualViewport.offsetTop so cursor
    // stays visible above the keyboard. Independent from the dims state
    // machine — cc isn't informed of keyboard events.
    //
    // Records full viewport metrics (no throttle) so we can correlate
    // visual viewport shifts with ResizeObserver / window.resize events
    // and pin down which channel actually fires for each layout change.
    const captureViewportMetrics = (): {
      vvH: number;
      vvW: number;
      vvOffsetTop: number;
      vvOffsetLeft: number;
      vvPageTop: number;
      vvPageLeft: number;
      innerH: number;
      innerW: number;
      docH: number;
      hostH: number;
      hostW: number;
      windowScrollY: number;
    } => ({
      vvH: window.visualViewport?.height ?? 0,
      vvW: window.visualViewport?.width ?? 0,
      vvOffsetTop: window.visualViewport?.offsetTop ?? 0,
      vvOffsetLeft: window.visualViewport?.offsetLeft ?? 0,
      vvPageTop: window.visualViewport?.pageTop ?? 0,
      vvPageLeft: window.visualViewport?.pageLeft ?? 0,
      innerH: window.innerHeight,
      innerW: window.innerWidth,
      docH: document.documentElement.clientHeight,
      hostH: container.clientHeight,
      hostW: container.clientWidth,
      windowScrollY: window.scrollY,
    });
    const workspaceHeader =
      (container.closest('.workspace')?.querySelector('.workspace-header') as
        | HTMLElement
        | null) ?? null;
    const onVisualViewport = (): void => {
      const vv = window.visualViewport;
      if (vv === null) return;
      const layoutH = document.documentElement.clientHeight;
      // Keyboard height = layoutH - vv.height - vv.offsetTop.
      // Unifies iOS Safari (offsetTop > 0) and Chrome default
      // `resizes-visual` (offsetTop = 0, vv.height shrinks).
      const keyboardH = Math.max(0, layoutH - vv.height - vv.offsetTop);
      if (pane !== null) {
        pane.style.transform = keyboardH > 0 ? `translateY(${-keyboardH}px)` : '';
      }
      // When the keyboard pushes the visual viewport up inside the
      // layout viewport, the browser may also auto-scroll the page
      // to keep the focused input visible — that scroll moves the
      // workspace-header off-screen at the top. Counter-translate
      // the header by vv.pageTop so it stays pinned to the visible
      // viewport top regardless of page scroll.
      if (workspaceHeader !== null) {
        workspaceHeader.style.transform =
          vv.pageTop > 0 ? `translateY(${vv.pageTop}px)` : '';
      }
      recordOp('viewport.vv', captureViewportMetrics());
    };
    const onWindowResize = (): void => {
      recordOp('viewport.window', captureViewportMetrics());
    };
    if (window.visualViewport !== null) {
      window.visualViewport.addEventListener('resize', onVisualViewport);
      window.visualViewport.addEventListener('scroll', onVisualViewport);
      onVisualViewport();
    }
    window.addEventListener('resize', onWindowResize);

    // ── Terminal — mounted early; placeholder covers it until stable ─
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
    // Initial `fit.fit()` here MAY produce wrong dims if the layout
    // hasn't settled (mobile mount). That's OK — we don't send those
    // dims to the server until the dims state machine reaches `stable`.
    try {
      fit.fit();
    } catch {
      // ignore
    }

    // ── WebSocket (decoupled from dims state machine) ────────────────
    // onSnapshot/onOutput write directly to term. Pre-stable, the
    // placeholder visually covers the terminal so any wrong-dims content
    // from the server's fallback path is hidden until the proper
    // snapshot arrives after we send the stable resize.
    const sock = new TerminalSocket(props.sessionId, {
      onSnapshot: (data) => {
        recordOp('term.reset', { reason: 'snapshot' });
        term.reset();
        chunkedWrite(term, data, 'snapshot');
      },
      onOutput: (data) => chunkedWrite(term, data, 'output'),
      onStatus: (state) => handlersRef.current.onStatus?.(state),
      onError: (msg) => {
        term.write(`\r\n\x1b[31m[ws error: ${msg}]\x1b[0m\r\n`);
        handlersRef.current.onError?.(msg);
      },
      onConnected: () => {
        // Decoupled — dims state machine owns first fit + send resize.
        // Just notify upstream that the socket is up.
        handlersRef.current.onConnected?.();
      },
      onReconnecting: () => handlersRef.current.onReconnecting?.(),
      onDead: (reason: DeadReason) => handlersRef.current.onDead?.(reason),
    });
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

    // Touch handling on the terminal area. See task #24's resolution
    // in commit 15551d6: the 6px-threshold preventDefault on touchmove
    // is sufficient to keep mouse synthesis from feeding xterm's
    // selection service.
    // CSS-px slop before a touch is classified as drag (vs tap / long-press
    // candidate). References:
    //   - Android tap slop = 8 dp (ViewConfiguration.getScaledTouchSlop)
    //   - Material Design gesture spec = 8 dp tap slop
    //   - Hammer.js default touchstart→touchmove threshold = 10 px
    // 6 is slightly tighter than the 8-10 reference: cc scroll is the
    // dominant intent in this app, so we'd rather promote to scroll
    // earlier than wait. Don't go lower — natural finger jitter
    // (~0.5 mm physical / ~150 dpi mobile) reaches 4-5 css-px without
    // user intent.
    const TAP_THRESHOLD_PX = 6;
    // Long-press threshold for entering selection mode. Derivation:
    //   - Android ViewConfiguration.getLongPressTimeout() = 500 ms
    //   - iOS UILongPressGestureRecognizer.minimumPressDuration = 0.5 s
    //   - W3C contextmenu (touchscreen long-press) ≈ 500-600 ms in browsers
    // Aligning with the system long-press interval lets users reuse the
    // muscle memory they already have for selecting text in any mobile
    // app.
    const LONG_PRESS_MS = 500;
    let pinchBase: { dist: number; fontSize: number } | null = null;
    let singleTouchStart: { x: number; y: number } | null = null;
    let singleTouchDragging = false;
    // Three modes for a single-finger touch:
    //   'idle'      — tap or long-press still pending decision
    //   'scroll'    — drag exceeded TAP_THRESHOLD_PX before LONG_PRESS_MS
    //                 elapsed → self-driven term.scrollLines path
    //   'selection' — finger held still ≥ LONG_PRESS_MS → synthesize
    //                 mouse events so xterm's built-in selection service
    //                 takes over; touchend triggers clipboard write
    type TouchMode = 'idle' | 'scroll' | 'selection';
    let touchMode: TouchMode = 'idle';
    let longPressTimer: ReturnType<typeof setTimeout> | null = null;
    let lastTouchClient: { x: number; y: number } = { x: 0, y: 0 };
    const dispatchMouseEvent = (
      type: 'mousedown' | 'mousemove' | 'mouseup',
      x: number,
      y: number,
    ): void => {
      const target =
        (container.querySelector('.xterm-screen') as HTMLElement | null) ?? container;
      const ev = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        button: 0,
        buttons: type === 'mouseup' ? 0 : 1,
        view: window,
      });
      target.dispatchEvent(ev);
    };
    // Self-driven touch → scrollback panning. xterm's built-in handler
    // ends up scrolling at most ~1 line per touchmove regardless of how
    // far the finger traveled (root cause of "drag only flips one line"
    // in feedback). We bypass it by tracking incremental dy and calling
    // term.scrollLines(n) ourselves with n = floor(accumPx / cellHeight).
    let touchScrollLastY = 0;
    let touchScrollAccumPx = 0;
    // Cell-pitch derivation for touch→scroll mapping.
    //
    // Earlier attempts read xterm's internal cell metric via .xterm-rows /
    // .xterm-screen / container.clientHeight÷term.rows — all converged on
    // ~9.29 px on a 13 px font. That's xterm's *layout* cell pitch (used
    // to fit term.rows into the host), but it doesn't match the row
    // spacing a user perceives when reading TUI content. Result: every
    // ~9 px of finger travel scrolled one row, making 200 px drags
    // overshoot to ~21 rows — feels hyper-sensitive / unreadable.
    //
    // Switch to user-perceived line pitch:
    //   cellHeight = fontSize × VISUAL_LINE_HEIGHT_FACTOR
    // VISUAL_LINE_HEIGHT_FACTOR=1.2 is the conventional body line-height
    // for monospace TUI text (CSS `line-height: 1.2` default). It tracks
    // pinch-zoom font size changes automatically. Caught in feedback
    // 6a75371e: scroll.touch lines distribution still skewed to ±1 with
    // the container-based path because xterm's reported rows already
    // bakes in the small cell metric.
    const VISUAL_LINE_HEIGHT_FACTOR = 1.2;
    let cellHeightCache = 0;
    const refreshCellHeight = (): void => {
      const fontSize = term.options.fontSize ?? FONT_SIZE_DEFAULT;
      cellHeightCache = fontSize * VISUAL_LINE_HEIGHT_FACTOR;
    };
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
        touchScrollLastY = t.clientY;
        touchScrollAccumPx = 0;
        lastTouchClient = { x: t.clientX, y: t.clientY };
        touchMode = 'idle';
        // Refresh cell pitch on every touch start so pinch-zoom font
        // changes are picked up — pinch updates term.options.fontSize
        // but doesn't go through dims state machine.
        refreshCellHeight();
        if (longPressTimer !== null) clearTimeout(longPressTimer);
        longPressTimer = setTimeout(() => {
          longPressTimer = null;
          // Only enter selection if the finger never crossed the tap
          // threshold by the time the timer fired (otherwise touchmove
          // already promoted us to 'scroll' and cleared this timer).
          if (touchMode === 'idle' && singleTouchStart !== null) {
            touchMode = 'selection';
            recordOp('touch.longpress', { x: lastTouchClient.x, y: lastTouchClient.y });
            dispatchMouseEvent('mousedown', lastTouchClient.x, lastTouchClient.y);
          }
        }, LONG_PRESS_MS);
      }
    };
    // Track main-thread responsiveness during drag. If the gap between
    // consecutive touchmove dispatches exceeds 2 frames (>~30ms), main
    // thread is busy with something else (paint, GC, RAF tick) and the
    // user perceives a stutter. Record those gaps so a "drag feels
    // laggy" feedback has direct evidence of when the stalls happened.
    let lastTouchMoveTs = 0;
    // Stall threshold = 2 frames @ 60 fps ≈ 33 ms. Use 30 (slightly
    // tighter) so we catch any gap longer than two paint cycles, which
    // is the smallest interval a user can perceive as a stutter during
    // continuous drag.
    const TOUCH_STALL_THRESHOLD_MS = 30;
    // xterm `onScroll` only fires when the underlying buffer pushes
    // new lines (baseY change), NOT when the user-driven viewport scroll
    // shifts ydisp inside an unchanged buffer. To see "drag → ydisp
    // shifts" we have to sample buffer.viewportY directly during the
    // drag and record only when it actually moves.
    let lastViewportY = -1;
    const onTouchMove = (e: TouchEvent): void => {
      const now = performance.now();
      if (lastTouchMoveTs > 0) {
        const gap = now - lastTouchMoveTs;
        if (gap > TOUCH_STALL_THRESHOLD_MS) {
          recordOp('touch.move.stall', { gapMs: Math.round(gap) });
        }
      }
      lastTouchMoveTs = now;
      const vY = term.buffer.active.viewportY;
      if (vY !== lastViewportY) {
        recordOp('term.viewport.shift', {
          from: lastViewportY,
          to: vY,
          baseY: term.buffer.active.baseY,
        });
        lastViewportY = vY;
      }
      if (e.touches.length === 2 && pinchBase !== null) {
        // 100 ms throttle: a pinch gesture spans ~300-1000 ms, so 100 ms
        // gives ~3-10 samples per gesture — enough to see start / mid /
        // end of zoom without flooding the ring (touchmove fires at
        // ~60 Hz on Android Chrome → 6 raw events per 100 ms collapse
        // to 1 record).
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
            // fit can throw mid-resize; ResizeObserver will reconcile
          }
        }
        e.preventDefault();
        return;
      }
      if (e.touches.length === 1 && singleTouchStart !== null) {
        const t = e.touches[0]!;
        lastTouchClient = { x: t.clientX, y: t.clientY };
        const dx = Math.abs(t.clientX - singleTouchStart.x);
        const dy = Math.abs(t.clientY - singleTouchStart.y);
        // selection mode (long-press fired): forward synthesized
        // mousemove so xterm's selection service tracks the drag.
        if (touchMode === 'selection') {
          dispatchMouseEvent('mousemove', t.clientX, t.clientY);
          e.preventDefault();
          return;
        }
        if (singleTouchDragging || dx + dy > TAP_THRESHOLD_PX) {
          if (!singleTouchDragging) {
            recordOp('touch.drag.start', { dx, dy });
            // Promote: drag passed threshold before long-press fired.
            // Cancel long-press timer; we're in scroll mode now.
            if (longPressTimer !== null) {
              clearTimeout(longPressTimer);
              longPressTimer = null;
            }
            touchMode = 'scroll';
          }
          // 100 ms throttle (same rationale as touch.pinch above):
          // collapse 6× 60Hz raw events into 1 sample per 100 ms.
          recordOpThrottled('touch.drag.move', { dx, dy }, 100);
          singleTouchDragging = true;
          // ── self-driven scroll: distance-proportional ──
          const dyInc = t.clientY - touchScrollLastY;
          touchScrollLastY = t.clientY;
          touchScrollAccumPx += dyInc;
          if (cellHeightCache <= 0) refreshCellHeight();
          const lines = Math.trunc(touchScrollAccumPx / cellHeightCache);
          if (lines !== 0) {
            // Finger moves DOWN (dyInc > 0) → user wants OLDER content
            // (scrollback toward the past). xterm scrollLines(n) with
            // n < 0 moves toward older lines. Sign: lines > 0 → scroll
            // up by |lines|.
            term.scrollLines(-lines);
            touchScrollAccumPx -= lines * cellHeightCache;
            recordOp('term.scroll.touch', { lines: -lines, cellH: cellHeightCache });
          }
          e.preventDefault();
        }
      }
    };
    const onTouchEnd = (e: TouchEvent): void => {
      recordOp('touch.end', {
        remaining: e.touches.length,
        wasDragging: singleTouchDragging,
        wasPinch: pinchBase !== null,
        mode: touchMode,
      });
      // Reset stall-detection baseline. Without this, the gap from the
      // last touchmove of THIS sequence to the first of the NEXT one
      // (= user's fingers-up time, not main-thread blockage) gets
      // mis-recorded as `touch.move.stall`, polluting the trace.
      lastTouchMoveTs = 0;
      if (longPressTimer !== null) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
      if (touchMode === 'selection') {
        // Finalize xterm selection, copy to clipboard.
        dispatchMouseEvent('mouseup', lastTouchClient.x, lastTouchClient.y);
        // Defer one tick — xterm settles selection bounds in a microtask
        // after mouseup. Then read getSelection() and ship to clipboard.
        setTimeout(() => {
          const text = term.getSelection();
          if (text.length === 0) {
            recordOp('term.selection.copy.empty');
            return;
          }
          // Best-effort clipboard write. https-only (we are), and
          // requires user gesture — touchend qualifies in modern Chrome
          // / Safari. Failures are recorded but don't surface as an
          // error to the user (selection is still visible & re-copyable
          // via long-press menu).
          if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            navigator.clipboard.writeText(text).then(
              () => {
                recordOp('term.selection.copy.ok', { len: text.length });
              },
              (err: unknown) => {
                recordOp('term.selection.copy.fail', {
                  message: err instanceof Error ? err.message : String(err),
                  len: text.length,
                });
              },
            );
          } else {
            recordOp('term.selection.copy.unavailable', { len: text.length });
          }
        }, 0);
      }
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
        touchMode = 'idle';
      }
    };
    const onMouseDownCapture = (e: MouseEvent): void => {
      const target = e.target as Element | null;
      const klass = target?.className ?? '';
      recordOpThrottled(
        'mouse.down',
        {
          targetClass:
            typeof klass === 'string'
              ? klass.slice(0, 80)
              : String(klass).slice(0, 80),
          button: e.button,
          buttons: e.buttons,
        },
        50,
      );
    };
    // Capture-phase + stopImmediatePropagation here cuts xterm's
    // internal touchmove handler completely. xterm 5 (Terminal.ts:835-846)
    // attaches its own touch listener that calls Viewport.handleTouchMove,
    // which does `_viewportElement.scrollTop += deltaY` and lets the
    // round-quantized _handleScroll path turn it into ±1 row per frame
    // (root cause of "drag flips one line"). xterm's listener is on
    // term.element (a descendant of `container`); capture-phase fires
    // first as the event descends, and stopImmediatePropagation prevents
    // xterm's bubble-phase handler from ever running. Our self-driven
    // scroll becomes the SOLE source of viewport movement during touch.
    const onTouchStartCapture = (e: TouchEvent): void => {
      onTouchStart(e);
      e.stopImmediatePropagation();
    };
    const onTouchMoveCapture = (e: TouchEvent): void => {
      onTouchMove(e);
      e.stopImmediatePropagation();
    };
    const onTouchEndCapture = (e: TouchEvent): void => {
      onTouchEnd(e);
      e.stopImmediatePropagation();
    };
    container.addEventListener('touchstart', onTouchStartCapture, {
      passive: false,
      capture: true,
    });
    container.addEventListener('touchmove', onTouchMoveCapture, {
      passive: false,
      capture: true,
    });
    container.addEventListener('touchend', onTouchEndCapture, { capture: true });
    container.addEventListener('touchcancel', onTouchEndCapture, { capture: true });
    container.addEventListener('mousedown', onMouseDownCapture, { capture: true });
    // Wheel events are how xterm internally turns scroll into scrollback
    // navigation (or, in alt-screen, into arrow-key emission via its
    // appCursorMode). On mobile this fires when the OS synthesises a
    // wheel from a touch drag — exactly the path we suspect for
    // "drag = page through cc". Capture-phase trace lets us see the
    // raw deltaY/deltaMode the browser reports before xterm consumes it.
    const onWheelCapture = (e: WheelEvent): void => {
      recordOpThrottled(
        'wheel',
        {
          deltaY: Math.round(e.deltaY * 100) / 100,
          deltaMode: e.deltaMode,
          ctrl: e.ctrlKey,
        },
        50,
      );
    };
    container.addEventListener('wheel', onWheelCapture, { capture: true, passive: true });

    setActiveTerm({
      term,
      ws: sock,
      sessionId: props.sessionId,
      rendererKind: renderer,
      lastWriteTs: 0,
    });

    // ── Dims state machine ───────────────────────────────────────────
    let dimsState: DimsState = INITIAL_DIMS_STATE;
    let quiescenceTimer: ReturnType<typeof setTimeout> | null = null;
    let maxWaitTimer: ReturnType<typeof setTimeout> | null = null;

    const dispatch = (event: DimsEvent): void => {
      const { next, effects } = dimsReducer(dimsState, event);
      dimsState = next;
      if (effects.clearQuiescenceTimer && quiescenceTimer !== null) {
        clearTimeout(quiescenceTimer);
        quiescenceTimer = null;
      }
      if (effects.armQuiescenceTimer) {
        quiescenceTimer = setTimeout(() => {
          quiescenceTimer = null;
          dispatch({ kind: 'quiescence-elapsed' });
        }, QUIESCENCE_MS);
      }
      if (effects.becameStable !== null) {
        if (maxWaitTimer !== null) {
          clearTimeout(maxWaitTimer);
          maxWaitTimer = null;
        }
        recordOp('dims.stable', effects.becameStable);
        // First stable: fit + send the first resize, then reveal xterm
        // by hiding the placeholder.
        try {
          fit.fit();
        } catch {
          // ignore
        }
        sock.send({ type: 'resize', cols: term.cols, rows: term.rows });
        placeholder.style.display = 'none';
        refreshCellHeight();
      }
      if (effects.resizedWhileStable !== null) {
        try {
          fit.fit();
        } catch {
          // ignore
        }
        sock.send({ type: 'resize', cols: term.cols, rows: term.rows });
        recordOp('dims.resize', effects.resizedWhileStable);
        refreshCellHeight();
      }
    };

    // ── ResizeObserver — sole measurement source for layout track ────
    const observer = new ResizeObserver(() => {
      const proposed = fit.proposeDimensions();
      if (proposed === undefined || proposed.cols <= 0 || proposed.rows <= 0) {
        return;
      }
      // Full metrics every callback (not throttled) — letting trace
      // correlate ResizeObserver fires with visualViewport / window
      // resize so we can attribute layout changes to the actual source.
      recordOp('dims.callback', {
        cols: proposed.cols,
        rows: proposed.rows,
        ...captureViewportMetrics(),
      });
      dispatch({ kind: 'measurement', cols: proposed.cols, rows: proposed.rows });
    });
    observer.observe(container);

    // ── MAX_WAIT_MS fallback ─────────────────────────────────────────
    maxWaitTimer = setTimeout(() => {
      maxWaitTimer = null;
      if (dimsState.kind !== 'unmeasured') return;
      const proposed = fit.proposeDimensions();
      const dims =
        proposed !== undefined && proposed.cols > 0 && proposed.rows > 0
          ? { cols: proposed.cols, rows: proposed.rows }
          : { cols: 80, rows: 24 };
      recordOp('dims.fallback', dims);
      dispatch({ kind: 'measurement', cols: dims.cols, rows: dims.rows });
      dispatch({ kind: 'quiescence-elapsed' });
    }, MAX_WAIT_MS);

    return () => {
      dispatch({ kind: 'unmount' });
      if (quiescenceTimer !== null) clearTimeout(quiescenceTimer);
      if (maxWaitTimer !== null) clearTimeout(maxWaitTimer);
      if (longPressTimer !== null) clearTimeout(longPressTimer);
      observer.disconnect();
      if (window.visualViewport !== null) {
        window.visualViewport.removeEventListener('resize', onVisualViewport);
        window.visualViewport.removeEventListener('scroll', onVisualViewport);
      }
      window.removeEventListener('resize', onWindowResize);
      if (pane !== null) pane.style.transform = '';
      container.removeEventListener('touchstart', onTouchStartCapture, { capture: true });
      container.removeEventListener('touchmove', onTouchMoveCapture, { capture: true });
      container.removeEventListener('touchend', onTouchEndCapture, { capture: true });
      container.removeEventListener('touchcancel', onTouchEndCapture, { capture: true });
      container.removeEventListener('mousedown', onMouseDownCapture, { capture: true });
      container.removeEventListener('wheel', onWheelCapture, { capture: true });
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
    <div className="terminal-view-pane">
      <div ref={containerRef} className="terminal-view" />
      <div ref={placeholderRef} className="terminal-placeholder" aria-hidden="true">
        <span className="terminal-placeholder-cursor" />
        <span className="terminal-placeholder-label">加载中…</span>
      </div>
    </div>
  );
});
