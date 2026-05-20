import { useEffect, useState } from 'react';
import { effectiveTheme, useUiStore, type EffectiveTheme } from './ui.js';

const TICK_MS = 60_000;

/**
 * Applies the effective theme to `document.documentElement.dataset.theme`.
 * In `auto` mode re-evaluates every minute so the theme follows the clock
 * without requiring a page reload at sunset/sunrise.
 */
export function useApplyTheme(): void {
  const themeMode = useUiStore((s) => s.themeMode);

  useEffect(() => {
    const apply = (): void => {
      const theme = effectiveTheme(themeMode);
      document.documentElement.dataset['theme'] = theme;
    };
    apply();
    if (themeMode !== 'auto') return;
    const id = setInterval(apply, TICK_MS);
    return () => {
      clearInterval(id);
    };
  }, [themeMode]);
}

/**
 * React-friendly view of the current effective theme. In `auto` mode it
 * recomputes every minute so the toggle button icon stays in sync with the
 * actual document theme.
 */
export function useEffectiveTheme(): EffectiveTheme {
  const themeMode = useUiStore((s) => s.themeMode);
  const [eff, setEff] = useState<EffectiveTheme>(() => effectiveTheme(themeMode));

  useEffect(() => {
    setEff(effectiveTheme(themeMode));
    if (themeMode !== 'auto') return;
    const id = setInterval(() => {
      setEff(effectiveTheme(themeMode));
    }, TICK_MS);
    return () => {
      clearInterval(id);
    };
  }, [themeMode]);

  return eff;
}
