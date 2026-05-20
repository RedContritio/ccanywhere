import { type FitAddon } from '@xterm/addon-fit';
import { type Terminal } from '@xterm/xterm';
import { recordOp } from '../state/ops-log.js';
import type { TerminalSocket } from '../ws.js';
import {
  dimsReducer,
  INITIAL_DIMS_STATE,
  type DimsEvent,
  type DimsState,
} from './dims-state.js';
import type { ViewportMetrics } from './terminal-keyboard-overlay.js';
import { MAX_WAIT_MS, QUIESCENCE_MS } from './terminal-config.js';

interface FitInputs {
  /** xterm-internal css cell metrics (matches what FitAddon divides). */
  readonly cellW: number;
  readonly cellH: number;
  /** parentElement.clientWidth/Height — the same element FitAddon reads
   * getComputedStyle on. Fractional in some browsers / dpr settings. */
  readonly containerW: number;
  readonly containerH: number;
  /** Inner padding subtracted by FitAddon before dividing. */
  readonly padX: number;
  readonly padY: number;
  /** Scrollbar reserve subtracted by FitAddon (0 if scrollback=0). */
  readonly scrollBarW: number;
}

/**
 * Mirror FitAddon's measurement inputs so trace data lets us reconstruct
 * what cols/rows would have been computed. Reads xterm's private `_core`
 * because that's the same struct FitAddon uses internally — no public API
 * surface exists. Brittle to xterm-major-version bumps; defensive nulls.
 */
function captureFitInputs(term: Terminal): FitInputs | null {
  const t = term as Terminal & {
    element?: HTMLElement;
    _core?: {
      _renderService?: { dimensions?: { css?: { cell?: { width?: number; height?: number } } } };
      viewport?: { scrollBarWidth?: number };
    };
  };
  const cell = t._core?._renderService?.dimensions?.css?.cell;
  if (cell === undefined || typeof cell.width !== 'number' || typeof cell.height !== 'number') {
    return null;
  }
  const elem = t.element;
  const parent = elem?.parentElement;
  if (elem === undefined || parent === null || parent === undefined) {
    return null;
  }
  const parentStyle = window.getComputedStyle(parent);
  const innerStyle = window.getComputedStyle(elem);
  return {
    cellW: cell.width,
    cellH: cell.height,
    containerW: parseFloat(parentStyle.width) || parent.clientWidth,
    containerH: parseFloat(parentStyle.height) || parent.clientHeight,
    padX: parseFloat(innerStyle.paddingLeft) + parseFloat(innerStyle.paddingRight),
    padY: parseFloat(innerStyle.paddingTop) + parseFloat(innerStyle.paddingBottom),
    scrollBarW: t._core?.viewport?.scrollBarWidth ?? 0,
  };
}

/**
 * After a fit.fit runs, record the inputs and check whether the post-fit
 * cols × cellW exceeds the usable width — that's the off-by-one signature
 * (cc draws into N columns but xterm physically renders into N-1 because
 * the Nth overflows the container).
 */
function recordFitApplied(term: Terminal, source: string): void {
  const inputs = captureFitInputs(term);
  if (inputs === null) {
    recordOp('fit.applied', { source, cols: term.cols, rows: term.rows, inputs: null });
    return;
  }
  const usableW = inputs.containerW - inputs.padX - inputs.scrollBarW;
  const usableH = inputs.containerH - inputs.padY;
  recordOp('fit.applied', {
    source,
    cols: term.cols,
    rows: term.rows,
    ...inputs,
    usableW,
    usableH,
    /** > 0 means cols × cellW exceeds available width — the bug. */
    computedOverflowW: inputs.cellW * term.cols - usableW,
    computedOverflowH: inputs.cellH * term.rows - usableH,
  });
}

export interface DimsControllerOptions {
  container: HTMLElement;
  term: Terminal;
  fit: FitAddon;
  sock: TerminalSocket;
  placeholder: HTMLElement;
  /** Recompute touch cell-pitch cache when font/dims change. */
  refreshCellHeight: () => void;
  /** Capture full viewport metrics for trace correlation. */
  captureViewportMetrics: () => ViewportMetrics;
}

export interface DimsController {
  cleanup: () => void;
}

/**
 * Drives the layout-track dims state machine. Single ResizeObserver on the
 * container is the sole measurement source; reducer in dims-state.ts decides
 * whether to arm a quiescence timer or commit. First `stable` fits + sends
 * the first resize and reveals xterm (hides the placeholder). Subsequent
 * `resizedWhileStable` re-fits and sends a delta resize.
 *
 * MAX_WAIT_MS fallback: if 5 quiescence windows pass without ever reaching
 * stable, force a measurement so cc isn't stuck without dims.
 */
export function setupDimsStateMachine(opts: DimsControllerOptions): DimsController {
  const { container, term, fit, sock, placeholder, refreshCellHeight, captureViewportMetrics } =
    opts;
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
      // First stable: fit + send the first resize, then reveal xterm by
      // hiding the placeholder.
      try {
        fit.fit();
      } catch {
        // ignore
      }
      recordFitApplied(term, 'stable');
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
      recordFitApplied(term, 'resized');
      sock.send({ type: 'resize', cols: term.cols, rows: term.rows });
      recordOp('dims.resize', effects.resizedWhileStable);
      refreshCellHeight();
    }
  };

  const observer = new ResizeObserver(() => {
    const proposed = fit.proposeDimensions();
    if (proposed === undefined || proposed.cols <= 0 || proposed.rows <= 0) {
      return;
    }
    // Full metrics every callback (not throttled) — lets trace correlate
    // ResizeObserver fires with visualViewport / window resize. fitInputs
    // captures the same measurement FitAddon would consume, so a feedback
    // can replay "what cols/rows would have been picked given this geometry".
    const fitInputs = captureFitInputs(term);
    recordOp('dims.callback', {
      cols: proposed.cols,
      rows: proposed.rows,
      ...captureViewportMetrics(),
      ...(fitInputs ?? {}),
    });
    dispatch({ kind: 'measurement', cols: proposed.cols, rows: proposed.rows });
  });
  observer.observe(container);

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

  return {
    cleanup: () => {
      dispatch({ kind: 'unmount' });
      if (quiescenceTimer !== null) clearTimeout(quiescenceTimer);
      if (maxWaitTimer !== null) clearTimeout(maxWaitTimer);
      observer.disconnect();
    },
  };
}
