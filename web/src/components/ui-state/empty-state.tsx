import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface Props {
  readonly title: string;
  readonly description?: string;
  readonly action?: ReactNode;
  readonly className?: string;
}

/**
 * Centered empty-state block. Use inside list / pane / dialog when the
 * data set is empty (not when fetch failed — use ErrorState for that).
 * action is a complete <Button> node so the caller picks variant.
 */
export function EmptyState({
  title,
  description,
  action,
  className,
}: Props): JSX.Element {
  return (
    <div
      role="status"
      className={cn(
        'flex flex-col items-center justify-center gap-2 px-4 py-6 text-center',
        className,
      )}
    >
      <p className="text-sm text-fg-muted">{title}</p>
      {description !== undefined && (
        <p className="text-xs leading-relaxed text-fg-muted">{description}</p>
      )}
      {action !== undefined && <div className="mt-1">{action}</div>}
    </div>
  );
}
