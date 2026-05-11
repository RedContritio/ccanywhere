import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type SortDir = 'asc' | 'desc';

interface Props {
  readonly active: boolean;
  readonly dir: SortDir | null;
  readonly onClick: () => void;
  readonly children: ReactNode;
}

/**
 * Sort toggle button used in list headers. Active state uses brand
 * color; the arrow (↓ for asc / ↑ for desc) is mono and aria-hidden
 * since the active+dir semantics are conveyed by the parent's
 * aria-sort or label.
 */
export function SortButton({
  active,
  dir,
  onClick,
  children,
}: Props): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-sm px-2 py-1 text-xs transition-colors hover:text-fg',
        active ? 'text-brand' : 'text-fg-muted',
      )}
    >
      {children}
      {dir !== null && (
        <span aria-hidden="true" className="ml-0.5 font-mono">
          {dir === 'asc' ? '↓' : '↑'}
        </span>
      )}
    </button>
  );
}
