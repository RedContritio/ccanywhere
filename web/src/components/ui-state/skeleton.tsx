import { cn } from '@/lib/utils';

interface Props {
  readonly variant?: 'list-row' | 'text';
  readonly count?: number;
  readonly className?: string;
}

/**
 * Pulse-animated placeholder bar(s). Use when reserving layout space
 * matters (list first-paint, card grids) to avoid the "blink" of
 * `<p>加载中…</p>` → real content. list-row mimics a session-list /
 * project-list row height; text mimics a single line.
 */
export function Skeleton({
  variant = 'text',
  count = 1,
  className,
}: Props): JSX.Element {
  const sizing =
    variant === 'list-row' ? 'h-10 my-1.5 mx-3.5' : 'h-3 my-2 w-full';
  return (
    <div role="status" aria-busy="true" aria-label="加载中" className={className}>
      {Array.from({ length: Math.max(1, count) }).map((_, i) => (
        <div
          key={i}
          className={cn(
            'animate-pulse rounded-sm bg-bg-elevated',
            sizing,
          )}
          aria-hidden="true"
        />
      ))}
    </div>
  );
}
