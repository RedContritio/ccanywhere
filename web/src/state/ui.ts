import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export type ThemeMode = 'auto' | 'light' | 'dark';
export type EffectiveTheme = 'light' | 'dark';

export interface UiSnapshot {
  themeMode: ThemeMode;
  currentSessionId: string | null;
}

interface UiStore extends UiSnapshot {
  setTheme: (mode: ThemeMode) => void;
  cycleTheme: () => void;
  selectSession: (id: string | null) => void;
}

const initial: UiSnapshot = {
  themeMode: 'auto',
  currentSessionId: null,
};

const themeOrder: readonly ThemeMode[] = ['auto', 'light', 'dark'];

export const useUiStore = create<UiStore>()(
  persist(
    (set, get) => ({
      ...initial,
      setTheme: (mode) => set({ themeMode: mode }),
      cycleTheme: () => {
        const cur = get().themeMode;
        const idx = themeOrder.indexOf(cur);
        const next = themeOrder[(idx + 1) % themeOrder.length] ?? 'auto';
        set({ themeMode: next });
      },
      selectSession: (id) => set({ currentSessionId: id }),
    }),
    {
      name: 'ccanywhere.ui',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        themeMode: s.themeMode,
        currentSessionId: s.currentSessionId,
      }),
    },
  ),
);

/**
 * Map themeMode + a clock reading to the effective theme.
 * `auto`: 07:00–18:59 → light, otherwise dark.
 * `light` / `dark`: passthrough.
 */
export function effectiveTheme(mode: ThemeMode, now: Date = new Date()): EffectiveTheme {
  if (mode === 'light') return 'light';
  if (mode === 'dark') return 'dark';
  const hour = now.getHours();
  return hour >= 7 && hour < 19 ? 'light' : 'dark';
}

/** Tests only. */
export function resetUiStoreForTest(): void {
  useUiStore.setState({ ...initial });
}
