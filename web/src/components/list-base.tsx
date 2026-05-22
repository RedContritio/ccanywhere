import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface ListBaseProps<T> {
  readonly items: ReadonlyArray<T>;
  readonly getKey: (item: T) => string;
  readonly renderPrimary: (item: T) => ReactNode;
  readonly renderSecondary?: (item: T) => ReactNode;
  readonly selectedKey?: string | null;
  readonly onSelect?: (key: string) => void;
  readonly ariaLabel?: string;
  readonly emptyLabel?: string;
  readonly className?: string;
  /**
   * When true the (non-empty) list scrolls within itself instead of
   * growing. Used inside a flex-column dialog body: the caller's flex
   * layout supplies the height, the list shrinks to the available space
   * and scrolls — keeping sibling controls (sort buttons, mode tabs) and
   * the dialog chrome fixed. Only flips overflow + min-h-0; no fixed cap.
   */
  readonly scroll?: boolean;
}

/**
 * Compact list view (one row per entry, no card grid). Replaces the
 * legacy `SelectableList` from app.css era. Used for project lists,
 * resume session pickers, and other single-select scenarios inside
 * dialogs and pages.
 *
 * Visuals:
 * - flat list with 1px borders, no shadow, no card chrome
 * - selected row uses `bg-muted` (= bg-elevated) + brand-text accent
 * - primary slot uses sans (default); secondary slot uses mono for data
 * values like timestamps / session ids (F1 字体硬规则)
 */
export function ListBase<T>({
  items,
  getKey,
  renderPrimary,
  renderSecondary,
  selectedKey = null,
  onSelect,
  ariaLabel,
  emptyLabel = '空',
  className,
  scroll,
}: ListBaseProps<T>): JSX.Element {
  if (items.length === 0) {
    return (
      <div
        className={cn(
          'flex items-center justify-center rounded-md border border-border bg-bg px-3 py-6 text-sm text-fg-muted',
          className,
        )}
        role="list"
        aria-label={ariaLabel}
      >
        {emptyLabel}
      </div>
    );
  }

  const interactive = onSelect !== undefined;
  return (
    <div
      className={cn(
        'rounded-md border border-border bg-bg',
        // overflow-hidden clips rows to the rounded corners; when `scroll`
        // is set the vertical axis must scroll instead — overflow-x stays
        // hidden (corner clip), min-h-0 lets the flex parent shrink it.
        scroll
          ? 'min-h-0 overflow-x-hidden overflow-y-auto'
          : 'overflow-hidden',
        className,
      )}
      role={interactive ? 'radiogroup' : 'list'}
      aria-label={ariaLabel}
    >
      {items.map((item, idx) => {
        const key = getKey(item);
        const isSelected = key === selectedKey;
        const baseRow = cn(
          'flex w-full min-w-0 items-center justify-between gap-3 overflow-hidden px-3 py-2 text-left text-sm',
          idx > 0 && 'border-t border-border',
          isSelected && 'bg-muted text-brand',
          interactive && 'hover:bg-muted focus-visible:bg-muted focus:outline-none',
        );
        const primary = (
          <span className="min-w-0 flex-1 truncate">{renderPrimary(item)}</span>
        );
        const secondary =
          renderSecondary !== undefined ? (
            <span className="shrink-0 font-mono text-xs text-fg-muted">
              {renderSecondary(item)}
            </span>
          ) : null;
        if (interactive) {
          return (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={isSelected}
              className={baseRow}
              onClick={() => onSelect(key)}
            >
              {primary}
              {secondary}
            </button>
          );
        }
        return (
          <div key={key} role="listitem" className={baseRow}>
            {primary}
            {secondary}
          </div>
        );
      })}
    </div>
  );
}
