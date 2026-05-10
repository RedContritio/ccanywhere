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

  const observer = new ResizeObserver(() => {
    const proposed = fit.proposeDimensions();
    if (proposed === undefined || proposed.cols <= 0 || proposed.rows <= 0) {
      return;
    }
    // Full metrics every callback (not throttled) — lets trace correlate
    // ResizeObserver fires with visualViewport / window resize.
    recordOp('dims.callback', {
      cols: proposed.cols,
      rows: proposed.rows,
      ...captureViewportMetrics(),
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
