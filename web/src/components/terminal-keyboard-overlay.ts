import { recordOp } from '../state/ops-log.js';

export interface ViewportMetrics {
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
  [key: string]: number;
}

export interface KeyboardOverlayHandle {
  /** Capture full viewport metrics — shared with dims state machine for trace correlation. */
  captureViewportMetrics: () => ViewportMetrics;
  cleanup: () => void;
}

/**
 * Keyboard-overlay channel: reserve the keyboard's height as `padding-bottom`
 * on `.terminal-pane-content` so the pane's flex children (terminal-host +
 * mobile-toolbar) physically shrink to fit above the keyboard. The shrink
 * fires `ResizeObserver` on `.terminal-host` → dims state machine →
 * `resize` frame, so cc learns the new `rows` and re-renders into the
 * visible region — no off-screen cursor, no clipped output.
 *
 * Previously this channel applied `transform: translateY(-keyboardH)` to
 * the same pane. That kept everything visible but cc was never told that
 * `rows` had effectively shrunk, so cc would draw into rows that ended up
 * behind the keyboard (and scroll history got pushed off the top each time
 * the keyboard opened). User feedback called for resize semantics instead.
 *
 * `.workspace-header` still counter-translates by `vv.pageTop` against
 * browser page auto-scroll when the focused input would otherwise be hidden
 * behind the soft keyboard — that's independent of the pane resize.
 */
export function setupKeyboardOverlay(container: HTMLElement): KeyboardOverlayHandle {
  const pane = container.closest('.terminal-pane-content') as HTMLElement | null;
  const workspaceHeader =
    (container.closest('.workspace')?.querySelector('.workspace-header') as
      | HTMLElement
      | null) ?? null;

  const captureViewportMetrics = (): ViewportMetrics => ({
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

  const onVisualViewport = (): void => {
    const vv = window.visualViewport;
    if (vv === null) return;
    const layoutH = document.documentElement.clientHeight;
    // Keyboard height = layoutH - vv.height - vv.offsetTop. Unifies iOS
    // Safari (offsetTop > 0) and Chrome default `resizes-visual` path.
    const keyboardH = Math.max(0, layoutH - vv.height - vv.offsetTop);
    if (pane !== null) {
      // padding-bottom shrinks the flex content area; flex children
      // (terminal-host with `flex: 1`, mobile-toolbar with fixed height)
      // recompute, ResizeObserver on terminal-host fires, dims state
      // machine sends a resize frame to cc.
      pane.style.paddingBottom = keyboardH > 0 ? `${keyboardH}px` : '';
    }
    if (workspaceHeader !== null) {
      workspaceHeader.style.transform =
        vv.pageTop > 0 ? `translateY(${vv.pageTop}px)` : '';
    }
    recordOp('viewport.vv', { ...captureViewportMetrics(), keyboardH });
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

  return {
    captureViewportMetrics,
    cleanup: () => {
      if (window.visualViewport !== null) {
        window.visualViewport.removeEventListener('resize', onVisualViewport);
        window.visualViewport.removeEventListener('scroll', onVisualViewport);
      }
      window.removeEventListener('resize', onWindowResize);
      if (pane !== null) pane.style.paddingBottom = '';
      if (workspaceHeader !== null) workspaceHeader.style.transform = '';
    },
  };
}
