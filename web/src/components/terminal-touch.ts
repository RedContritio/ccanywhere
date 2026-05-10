import { type FitAddon } from '@xterm/addon-fit';
import { type Terminal } from '@xterm/xterm';
import { recordOp, recordOpThrottled } from '../state/ops-log.js';
import { FONT_SIZE_DEFAULT, FONT_SIZE_LS_KEY, FONT_SIZE_MAX, FONT_SIZE_MIN } from './terminal-config.js';

export interface TouchInteractionHandle {
  /** Recompute cell-pitch cache after a font-size change (e.g. dims state stable). */
  refreshCellHeight: () => void;
  cleanup: () => void;
}

// CSS-px slop before a touch is classified as drag. References:
//   - Android tap slop = 8 dp
//   - Material Design = 8 dp
//   - Hammer.js = 10 px
// 6 is tighter — cc scroll is dominant intent so promote earlier; don't go
// lower (finger jitter ~0.5 mm reaches 4-5 css-px without intent).
const TAP_THRESHOLD_PX = 6;

// Long-press threshold for entering selection mode. Aligns with system long-press:
//   - Android ViewConfiguration.getLongPressTimeout() = 500 ms
//   - iOS UILongPressGestureRecognizer.minimumPressDuration = 0.5 s
//   - W3C contextmenu (touchscreen) ≈ 500-600 ms
const LONG_PRESS_MS = 500;

// Stall threshold = 2 frames @ 60 fps ≈ 33 ms; 30 catches any gap > 2 paint
// cycles, the smallest interval a user perceives as stutter during drag.
const TOUCH_STALL_THRESHOLD_MS = 30;

// VISUAL_LINE_HEIGHT_FACTOR=1.2 is the conventional CSS line-height for
// monospace TUI text. Tracks pinch-zoom font size automatically. Caught in
// feedback 6a75371e: container-based path's reported rows already bakes in
// xterm's small layout cell metric (~9.29 px on 13 px font), making 200 px
// drag overshoot to ~21 rows. Switch to user-perceived line pitch.
const VISUAL_LINE_HEIGHT_FACTOR = 1.2;

/**
 * Self-driven touch handler for the terminal area. Replaces xterm's built-in
 * touch path which scrolls at most ~1 line per touchmove (commit 15551d6).
 *
 * Three modes for a single-finger touch:
 *   - 'idle'      tap or long-press still pending decision
 *   - 'scroll'    drag exceeded TAP_THRESHOLD_PX before LONG_PRESS_MS elapsed
 *                 → self-driven term.scrollLines path
 *   - 'selection' finger held still ≥ LONG_PRESS_MS → synthesize mouse events
 *                 so xterm's selection service takes over; touchend triggers
 *                 clipboard write
 *
 * Two-finger touch = pinch-zoom font size (persisted to localStorage on end).
 *
 * Capture-phase + stopImmediatePropagation cuts xterm's internal listener
 * (Terminal.ts:835-846 → Viewport.handleTouchMove → scrollTop ± deltaY →
 * ±1 row per frame). Our self-driven scroll becomes the SOLE source.
 */
export function setupTouchInteraction(
  container: HTMLElement,
  term: Terminal,
  fit: FitAddon,
): TouchInteractionHandle {
  let pinchBase: { dist: number; fontSize: number } | null = null;
  let singleTouchStart: { x: number; y: number } | null = null;
  let singleTouchDragging = false;
  type TouchMode = 'idle' | 'scroll' | 'selection';
  let touchMode: TouchMode = 'idle';
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  let lastTouchClient: { x: number; y: number } = { x: 0, y: 0 };
  let touchScrollLastY = 0;
  let touchScrollAccumPx = 0;
  let cellHeightCache = 0;
  let lastTouchMoveTs = 0;
  let lastViewportY = -1;

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
      // Refresh cell pitch on every touch start so pinch-zoom font changes
      // are picked up — pinch updates fontSize but doesn't go through dims SM.
      refreshCellHeight();
      if (longPressTimer !== null) clearTimeout(longPressTimer);
      longPressTimer = setTimeout(() => {
        longPressTimer = null;
        if (touchMode === 'idle' && singleTouchStart !== null) {
          touchMode = 'selection';
          recordOp('touch.longpress', { x: lastTouchClient.x, y: lastTouchClient.y });
          dispatchMouseEvent('mousedown', lastTouchClient.x, lastTouchClient.y);
        }
      }, LONG_PRESS_MS);
    }
  };

  const onTouchMove = (e: TouchEvent): void => {
    const now = performance.now();
    if (lastTouchMoveTs > 0) {
      const gap = now - lastTouchMoveTs;
      if (gap > TOUCH_STALL_THRESHOLD_MS) {
        recordOp('touch.move.stall', { gapMs: Math.round(gap) });
      }
    }
    lastTouchMoveTs = now;
    // xterm onScroll fires only on baseY change (buffer push), not on
    // user-driven viewport ydisp shift. Sample buffer.viewportY directly.
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
      // 100 ms throttle: pinch ~300-1000 ms, gives 3-10 samples per gesture.
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
      if (touchMode === 'selection') {
        dispatchMouseEvent('mousemove', t.clientX, t.clientY);
        e.preventDefault();
        return;
      }
      if (singleTouchDragging || dx + dy > TAP_THRESHOLD_PX) {
        if (!singleTouchDragging) {
          recordOp('touch.drag.start', { dx, dy });
          if (longPressTimer !== null) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
          }
          touchMode = 'scroll';
        }
        recordOpThrottled('touch.drag.move', { dx, dy }, 100);
        singleTouchDragging = true;
        // Self-driven scroll: distance-proportional.
        const dyInc = t.clientY - touchScrollLastY;
        touchScrollLastY = t.clientY;
        touchScrollAccumPx += dyInc;
        if (cellHeightCache <= 0) refreshCellHeight();
        const lines = Math.trunc(touchScrollAccumPx / cellHeightCache);
        if (lines !== 0) {
          // Finger moves DOWN (dyInc > 0) → user wants OLDER content;
          // term.scrollLines(n) with n < 0 moves toward older lines.
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
    // Reset stall baseline so the gap from this sequence to the next isn't
    // mis-recorded as `touch.move.stall`.
    lastTouchMoveTs = 0;
    if (longPressTimer !== null) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
    if (touchMode === 'selection') {
      dispatchMouseEvent('mouseup', lastTouchClient.x, lastTouchClient.y);
      // Defer one tick: xterm settles selection bounds in a microtask after
      // mouseup. Then read getSelection() and ship to clipboard.
      setTimeout(() => {
        const text = term.getSelection();
        if (text.length === 0) {
          recordOp('term.selection.copy.empty');
          return;
        }
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

  // Wheel events: how xterm internally turns scroll into scrollback or
  // arrow-key emission (alt-screen + appCursorMode). Capture-phase trace
  // lets us see raw deltaY/deltaMode before xterm consumes it.
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
  container.addEventListener('wheel', onWheelCapture, { capture: true, passive: true });

  return {
    refreshCellHeight,
    cleanup: () => {
      if (longPressTimer !== null) clearTimeout(longPressTimer);
      container.removeEventListener('touchstart', onTouchStartCapture, { capture: true });
      container.removeEventListener('touchmove', onTouchMoveCapture, { capture: true });
      container.removeEventListener('touchend', onTouchEndCapture, { capture: true });
      container.removeEventListener('touchcancel', onTouchEndCapture, { capture: true });
      container.removeEventListener('mousedown', onMouseDownCapture, { capture: true });
      container.removeEventListener('wheel', onWheelCapture, { capture: true });
    },
  };
}
