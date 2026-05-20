import { cn } from '@/lib/utils';

interface Props {
  readonly label?: string;
  readonly className?: string;
}

/**
 * Simple "加载中…" placeholder for fetch in progress. Prefer Skeleton
 * for list / card layouts where reserving space matters; this is for
 * brief fetches where a single line of text is enough.
 */
export function LoadingState({
  label = '加载中…',
  className,
}: Props): JSX.Element {
  return (
    <p
      aria-busy="true"
      className={cn('px-4 py-3 text-center text-xs text-fg-muted', className)}
    >
      {label}
    </p>
  );
}
