/**
 * Pure reducer for the terminal-host dimensions lifecycle. All timer /
 * DOM / IO side effects live in the caller; this module only computes
 * state transitions and emits an effects manifest. That split makes
 * the state machine trivially unit-testable (no fake timers, no DOM);
 * the formal state machine is documented inline below.
 *
 * State machine:
 *
 * unmeasured
 * │ measurement(c, r)
 * ▼
 * awaiting-quiescence(c, r)
 * │ measurement(c', r') — restart quiescence with (c', r')
 * │ quiescence-elapsed — commit (c, r) as stable
 * ▼
 * stable(c, r)
 * │ measurement(c', r') — immediate fit + send (c', r')
 * ▼
 * stable(c', r')
 *
 * Any state + unmount → terminated (one-shot, terminal).
 */

export type DimsState =
  | { readonly kind: 'unmeasured' }
  | { readonly kind: 'awaiting-quiescence'; readonly cols: number; readonly rows: number }
  | { readonly kind: 'stable'; readonly cols: number; readonly rows: number }
  | { readonly kind: 'terminated' };

export type DimsEvent =
  | { readonly kind: 'measurement'; readonly cols: number; readonly rows: number }
  | { readonly kind: 'quiescence-elapsed' }
  | { readonly kind: 'unmount' };

/**
 * The caller MUST execute these side effects in order after applying the
 * reducer's `next` state. Effects are a manifest; the reducer never
 * touches timers, DOM, or sockets directly.
 */
export interface DimsEffects {
  /** Cancel any pending quiescence timer first. */
  readonly clearQuiescenceTimer: boolean;
  /** Arm a new quiescence timer; caller fires `quiescence-elapsed` when it expires. */
  readonly armQuiescenceTimer: boolean;
  /**
   * Stable transition for the FIRST time — caller MUST mount the xterm
   * Terminal here, open it into the container, fit, and send the first
   * `resize` frame.
   */
  readonly becameStable: { readonly cols: number; readonly rows: number } | null;
  /**
   * Stable → stable while xterm already exists. Caller fits and sends
   * `resize`; does NOT mount.
   */
  readonly resizedWhileStable: { readonly cols: number; readonly rows: number } | null;
  /** Caller MUST dispose xterm + socket + listeners. */
  readonly tearDown: boolean;
}

const NO_EFFECTS: DimsEffects = {
  clearQuiescenceTimer: false,
  armQuiescenceTimer: false,
  becameStable: null,
  resizedWhileStable: null,
  tearDown: false,
};

export const INITIAL_DIMS_STATE: DimsState = { kind: 'unmeasured' };

export function dimsReducer(
  state: DimsState,
  event: DimsEvent,
): { readonly next: DimsState; readonly effects: DimsEffects } {
  // `terminated` is a one-shot terminal state. Any further event is a
  // bug in the caller (e.g. a timer firing after unmount because cleanup
  // forgot to clearTimeout). Stay terminated, emit no effects — the
  // caller will tear down only on the explicit unmount event.
  if (state.kind === 'terminated') {
    return { next: state, effects: NO_EFFECTS };
  }

  if (event.kind === 'unmount') {
    return {
      next: { kind: 'terminated' },
      effects: { ...NO_EFFECTS, clearQuiescenceTimer: true, tearDown: true },
    };
  }

  switch (state.kind) {
    case 'unmeasured': {
      if (event.kind === 'measurement') {
        return {
          next: { kind: 'awaiting-quiescence', cols: event.cols, rows: event.rows },
          effects: { ...NO_EFFECTS, armQuiescenceTimer: true },
        };
      }
      // quiescence-elapsed in unmeasured: stale timer (shouldn't happen
      // under correct effect handling). Ignore.
      return { next: state, effects: NO_EFFECTS };
    }

    case 'awaiting-quiescence': {
      if (event.kind === 'measurement') {
        // Reset quiescence with new measurement (or same — re-arm
        // unconditionally so layout transitions that pulse with the
        // same dims still extend the wait).
        return {
          next: { kind: 'awaiting-quiescence', cols: event.cols, rows: event.rows },
          effects: {
            ...NO_EFFECTS,
            clearQuiescenceTimer: true,
            armQuiescenceTimer: true,
          },
        };
      }
      // quiescence-elapsed: commit current dims as stable, fire
      // first-mount effect.
      return {
        next: { kind: 'stable', cols: state.cols, rows: state.rows },
        effects: {
          ...NO_EFFECTS,
          becameStable: { cols: state.cols, rows: state.rows },
        },
      };
    }

    case 'stable': {
      if (event.kind === 'measurement') {
        // Already stable — layout has settled at least once before, so
        // any subsequent measurement is a real layout change (drawer
        // toggle, orientation, dialog) and should be reflected
        // immediately without re-entering quiescence.
        return {
          next: { kind: 'stable', cols: event.cols, rows: event.rows },
          effects: {
            ...NO_EFFECTS,
            resizedWhileStable: { cols: event.cols, rows: event.rows },
          },
        };
      }
      // quiescence-elapsed in stable: stale timer. Ignore.
      return { next: state, effects: NO_EFFECTS };
    }
  }
}
