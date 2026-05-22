import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { effectiveTheme, resetUiStoreForTest, useUiStore } from './ui.js';

describe('useUiStore', () => {
  beforeEach(() => {
    localStorage.clear();
    resetUiStoreForTest();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('default themeMode is auto', () => {
    expect(useUiStore.getState().themeMode).toBe('auto');
  });

  it('setTheme replaces the mode', () => {
    useUiStore.getState().setTheme('light');
    expect(useUiStore.getState().themeMode).toBe('light');
  });

  it('cycleTheme rotates auto -> light -> dark -> auto', () => {
    expect(useUiStore.getState().themeMode).toBe('auto');
    useUiStore.getState().cycleTheme();
    expect(useUiStore.getState().themeMode).toBe('light');
    useUiStore.getState().cycleTheme();
    expect(useUiStore.getState().themeMode).toBe('dark');
    useUiStore.getState().cycleTheme();
    expect(useUiStore.getState().themeMode).toBe('auto');
  });

  it('selectSession updates currentSessionId', () => {
    useUiStore.getState().selectSession('abc');
    expect(useUiStore.getState().currentSessionId).toBe('abc');
    useUiStore.getState().selectSession(null);
    expect(useUiStore.getState().currentSessionId).toBeNull();
  });

  it('persists themeMode + currentSessionId under ccanywhere.ui', () => {
    useUiStore.getState().setTheme('dark');
    useUiStore.getState().selectSession('sid');
    const raw = localStorage.getItem('ccanywhere.ui');
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw ?? '{}') as {
      state?: { themeMode?: string; currentSessionId?: string };
    };
    expect(parsed.state?.themeMode).toBe('dark');
    expect(parsed.state?.currentSessionId).toBe('sid');
  });
});

describe('effectiveTheme', () => {
  it('passes through light/dark', () => {
    expect(effectiveTheme('light')).toBe('light');
    expect(effectiveTheme('dark')).toBe('dark');
  });

  it('auto + 09:00 → light', () => {
    expect(effectiveTheme('auto', new Date('2026-05-08T09:00:00'))).toBe('light');
  });

  it('auto + 18:30 → light (boundary 19:00 exclusive)', () => {
    expect(effectiveTheme('auto', new Date('2026-05-08T18:30:00'))).toBe('light');
  });

  it('auto + 19:00 → dark', () => {
    expect(effectiveTheme('auto', new Date('2026-05-08T19:00:00'))).toBe('dark');
  });

  it('auto + 06:59 → dark', () => {
    expect(effectiveTheme('auto', new Date('2026-05-08T06:59:00'))).toBe('dark');
  });

  it('auto + 23:30 → dark', () => {
    expect(effectiveTheme('auto', new Date('2026-05-08T23:30:00'))).toBe('dark');
  });
});
