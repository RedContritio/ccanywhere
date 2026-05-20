import { describe, expect, it } from 'vitest';
import {
  dimsReducer,
  INITIAL_DIMS_STATE,
  type DimsEffects,
  type DimsEvent,
  type DimsState,
} from './dims-state.js';

const EMPTY_EFFECTS: DimsEffects = {
  clearQuiescenceTimer: false,
  armQuiescenceTimer: false,
  becameStable: null,
  resizedWhileStable: null,
  tearDown: false,
};

function step(state: DimsState, event: DimsEvent): { next: DimsState; effects: DimsEffects } {
  return dimsReducer(state, event);
}

describe('dimsReducer', () => {
  it('starts in unmeasured', () => {
    expect(INITIAL_DIMS_STATE).toEqual({ kind: 'unmeasured' });
  });

  it('unmeasured + measurement → awaiting-quiescence + arm timer', () => {
    const r = step(INITIAL_DIMS_STATE, { kind: 'measurement', cols: 80, rows: 24 });
    expect(r.next).toEqual({ kind: 'awaiting-quiescence', cols: 80, rows: 24 });
    expect(r.effects).toEqual({ ...EMPTY_EFFECTS, armQuiescenceTimer: true });
  });

  it('awaiting-quiescence + same measurement → stay + reset timer', () => {
    const after1 = step(INITIAL_DIMS_STATE, { kind: 'measurement', cols: 80, rows: 24 }).next;
    const after2 = step(after1, { kind: 'measurement', cols: 80, rows: 24 });
    expect(after2.next).toEqual({ kind: 'awaiting-quiescence', cols: 80, rows: 24 });
    expect(after2.effects).toEqual({
      ...EMPTY_EFFECTS,
      clearQuiescenceTimer: true,
      armQuiescenceTimer: true,
    });
  });

  it('awaiting-quiescence + new measurement → update dims + reset timer', () => {
    const after1 = step(INITIAL_DIMS_STATE, { kind: 'measurement', cols: 80, rows: 24 }).next;
    const after2 = step(after1, { kind: 'measurement', cols: 75, rows: 23 });
    expect(after2.next).toEqual({ kind: 'awaiting-quiescence', cols: 75, rows: 23 });
    expect(after2.effects).toEqual({
      ...EMPTY_EFFECTS,
      clearQuiescenceTimer: true,
      armQuiescenceTimer: true,
    });
  });

  it('awaiting-quiescence + quiescence-elapsed → stable + becameStable effect', () => {
    const after1 = step(INITIAL_DIMS_STATE, { kind: 'measurement', cols: 75, rows: 23 }).next;
    const after2 = step(after1, { kind: 'quiescence-elapsed' });
    expect(after2.next).toEqual({ kind: 'stable', cols: 75, rows: 23 });
    expect(after2.effects).toEqual({ ...EMPTY_EFFECTS, becameStable: { cols: 75, rows: 23 } });
    // Critically: NOT armQuiescenceTimer — stable is one-shot transition.
    expect(after2.effects.armQuiescenceTimer).toBe(false);
  });

  it('stable + measurement → immediate resize, no quiescence', () => {
    const stable: DimsState = { kind: 'stable', cols: 75, rows: 23 };
    const after = step(stable, { kind: 'measurement', cols: 80, rows: 30 });
    expect(after.next).toEqual({ kind: 'stable', cols: 80, rows: 30 });
    expect(after.effects).toEqual({
      ...EMPTY_EFFECTS,
      resizedWhileStable: { cols: 80, rows: 30 },
    });
    // Must NOT re-enter quiescence — layout has settled before.
    expect(after.effects.armQuiescenceTimer).toBe(false);
    expect(after.effects.clearQuiescenceTimer).toBe(false);
    expect(after.effects.becameStable).toBeNull();
  });

  it('stable + quiescence-elapsed → ignored (stale timer)', () => {
    const stable: DimsState = { kind: 'stable', cols: 75, rows: 23 };
    const after = step(stable, { kind: 'quiescence-elapsed' });
    expect(after.next).toEqual(stable);
    expect(after.effects).toEqual(EMPTY_EFFECTS);
  });

  it('any state + unmount → terminated + tearDown + clearTimer', () => {
    for (const state of [
      { kind: 'unmeasured' } as DimsState,
      { kind: 'awaiting-quiescence', cols: 80, rows: 24 } as DimsState,
      { kind: 'stable', cols: 75, rows: 23 } as DimsState,
    ]) {
      const after = step(state, { kind: 'unmount' });
      expect(after.next).toEqual({ kind: 'terminated' });
      expect(after.effects).toEqual({
        ...EMPTY_EFFECTS,
        clearQuiescenceTimer: true,
        tearDown: true,
      });
    }
  });

  it('terminated + any event → stays terminated, no effects', () => {
    const terminated: DimsState = { kind: 'terminated' };
    for (const event of [
      { kind: 'measurement', cols: 1, rows: 1 } as DimsEvent,
      { kind: 'quiescence-elapsed' } as DimsEvent,
      { kind: 'unmount' } as DimsEvent,
    ]) {
      const after = step(terminated, event);
      expect(after.next).toEqual(terminated);
      expect(after.effects).toEqual(EMPTY_EFFECTS);
    }
  });

  // Trace the full happy path mount sequence once end-to-end.
  it('end-to-end: 3 transition pulses then quiescence elapses → stable', () => {
    let state: DimsState = INITIAL_DIMS_STATE;
    state = step(state, { kind: 'measurement', cols: 80, rows: 24 }).next;
    expect(state.kind).toBe('awaiting-quiescence');
    state = step(state, { kind: 'measurement', cols: 75, rows: 30 }).next;
    expect(state.kind).toBe('awaiting-quiescence');
    state = step(state, { kind: 'measurement', cols: 75, rows: 23 }).next;
    expect(state.kind).toBe('awaiting-quiescence');
    expect(state).toEqual({ kind: 'awaiting-quiescence', cols: 75, rows: 23 });
    const fired = step(state, { kind: 'quiescence-elapsed' });
    expect(fired.next).toEqual({ kind: 'stable', cols: 75, rows: 23 });
    expect(fired.effects.becameStable).toEqual({ cols: 75, rows: 23 });
  });
});
