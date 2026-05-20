import { cn } from '@/lib/utils';
import type { ToolbarKey } from './toolbar-layout.js';

interface Props {
  readonly cell: ToolbarKey | null;
  readonly index: number;
  readonly disabled?: boolean;
  readonly selected?: boolean;
  readonly onClick: (index: number) => void;
}

/**
 * Single cell in the toolbar layout editor grid ( chunk C).
 * Empty cells render a dashed-border `+` placeholder; filled cells show
 * the key label in mono. Selected (= currently being picked) cell gets
 * a focus ring.
 */
export function ToolbarCell({
  cell,
  index,
  disabled = false,
  selected = false,
  onClick,
}: Props): JSX.Element {
  return (
    <button
      type="button"
      data-slot="toolbar-cell"
      onClick={() => onClick(index)}
      disabled={disabled}
      className={cn(
        'flex h-10 items-center justify-center rounded-md border text-sm font-mono transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        cell === null
          ? 'border-dashed border-border text-fg-muted hover:border-brand hover:text-brand'
          : 'border-border bg-muted text-fg hover:bg-accent',
        selected && 'ring-2 ring-ring',
      )}
    >
      {cell !== null ? cell.label : '+'}
    </button>
  );
}
