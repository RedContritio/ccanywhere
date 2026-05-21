import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface Props {
  /** Plain string or error object — Error.message is read; anything else
   * is rendered via String. */
  readonly error: string | Error | unknown;
  readonly retry?: ReactNode;
  readonly className?: string;
}

/**
 * Centered error-state block. Use when a fetch / operation failed.
 * retry is a complete <Button> node (caller decides variant + handler).
 * Renders role="alert" so screen readers announce the failure.
 */
export function ErrorState({ error, retry, className }: Props): JSX.Element {
  const message =
    typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : String(error);
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center gap-2 px-4 py-6 text-center',
        className,
      )}
    >
      <p className="text-sm text-danger">加载失败：{message}</p>
      {retry !== undefined && <div className="mt-1">{retry}</div>}
    </div>
  );
}
