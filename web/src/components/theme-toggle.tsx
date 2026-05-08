import { useEffectiveTheme } from '../state/use-theme.js';
import { useUiStore, type ThemeMode } from '../state/ui.js';

const MODE_LABEL: Record<ThemeMode, string> = {
  auto: 'Auto',
  light: 'Light',
  dark: 'Dark',
};

export function ThemeToggle(): JSX.Element {
  const mode = useUiStore((s) => s.themeMode);
  const cycle = useUiStore((s) => s.cycleTheme);
  const effective = useEffectiveTheme();

  const symbol = effective === 'dark' ? '◐' : '◑';
  const title = `主题模式: ${MODE_LABEL[mode]}（当前 ${effective}）。点击切换。`;

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={cycle}
      title={title}
      aria-label={title}
    >
      <span className="theme-toggle-symbol" aria-hidden="true">
        {symbol}
      </span>
      <span className="theme-toggle-label">{MODE_LABEL[mode]}</span>
    </button>
  );
}
