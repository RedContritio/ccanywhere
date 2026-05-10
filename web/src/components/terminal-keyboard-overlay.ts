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
 * Keyboard-overlay channel: translate `.terminal-pane-content` up by visual
 * viewport offset so cursor stays visible above the keyboard. Independent
 * from dims state machine — cc isn't informed of keyboard events.
 *
 * Pinned `.workspace-header` against page auto-scroll: when keyboard pushes
 * the visual viewport up inside the layout viewport, the browser may also
 * auto-scroll the page to keep the focused input visible — counter-translate
 * the header by vv.pageTop so it stays put.
 */
export function setupKeyboardOverlay(container: HTMLElement): KeyboardOverlayHandle {
  // The visual-viewport translateY is applied to .terminal-pane-content —
  // a sub-container that wraps just [terminal-host + MobileToolbar],
  // NOT the terminal-header. Keeps the top-bar pinned while cursor row
  // shifts above the keyboard. Caught in feedback 4cc189f4.
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
      pane.style.transform = keyboardH > 0 ? `translateY(${-keyboardH}px)` : '';
    }
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

  return {
    captureViewportMetrics,
    cleanup: () => {
      if (window.visualViewport !== null) {
        window.visualViewport.removeEventListener('resize', onVisualViewport);
        window.visualViewport.removeEventListener('scroll', onVisualViewport);
      }
      window.removeEventListener('resize', onWindowResize);
      if (pane !== null) pane.style.transform = '';
    },
  };
}
