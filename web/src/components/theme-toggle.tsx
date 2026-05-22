import { Monitor, Moon, Sun } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useUiStore, type ThemeMode } from '../state/ui.js';

const MODES: ReadonlyArray<{ mode: ThemeMode; label: string }> = [
  { mode: 'auto', label: 'Auto' },
  { mode: 'light', label: 'Light' },
  { mode: 'dark', label: 'Dark' },
];

/** Segmented control — for /settings / /login chrome (wide layouts). */
export function ThemeToggle(): JSX.Element {
  const mode = useUiStore((s) => s.themeMode);
  const setTheme = useUiStore((s) => s.setTheme);

  return (
    <div
      role="radiogroup"
      aria-label="主题模式"
      className="inline-flex rounded-md border border-border bg-bg p-0.5"
    >
      {MODES.map(({ mode: m, label }) => {
        const active = mode === m;
        return (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => setTheme(m)}
            className={cn(
              'rounded-sm px-2 py-0.5 text-xs leading-none transition-colors',
              active
                ? 'bg-bg-elevated text-fg'
                : 'text-fg-muted hover:text-fg',
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

const CYCLE_ICON: Record<ThemeMode, typeof Sun> = {
  auto: Monitor,
  light: Sun,
  dark: Moon,
};
const CYCLE_LABEL: Record<ThemeMode, string> = {
  auto: 'Auto',
  light: 'Light',
  dark: 'Dark',
};

/**
 * Single-button icon variant — cycles auto → light → dark. Fits inside
 * narrow chrome (sidebar header on mobile drawer) where the segmented
 * control would overflow.
 */
export function ThemeCycleButton(): JSX.Element {
  const mode = useUiStore((s) => s.themeMode);
  const cycleTheme = useUiStore((s) => s.cycleTheme);
  const Icon = CYCLE_ICON[mode];
  return (
    <button
      type="button"
      onClick={cycleTheme}
      title={`主题：${CYCLE_LABEL[mode]}（点击切换）`}
      aria-label={`主题切换，当前 ${CYCLE_LABEL[mode]}`}
      className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border text-fg-muted hover:text-fg"
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}
