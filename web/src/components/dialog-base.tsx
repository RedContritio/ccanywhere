import type { ReactNode } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

export type DialogSize = 'sm' | 'md' | 'lg';

const sizeClass: Record<DialogSize, string> = {
  sm: 'sm:max-w-sm',
  md: 'sm:max-w-lg',
  lg: 'sm:max-w-2xl',
};

export interface DialogBaseProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description?: string;
  readonly footer?: ReactNode;
  readonly children: ReactNode;
  readonly size?: DialogSize;
  readonly className?: string;
  /**
   * Dialogs do NOT autoFocus by default. Set true only when an
   * explicit input focus is desired on desktop. Mobile UA detection is left
   * to the caller — the rule is "be explicit about who steals focus".
   */
  readonly autoFocusContent?: boolean;
}

/**
 * Unified dialog shell. All ccanywhere dialogs go through this wrapper —
 * grep `from '@radix-ui/react-dialog'` should match nothing outside
 * `src/components/ui/dialog.tsx` (per F5).
 */
export function DialogBase({
  open,
  onOpenChange,
  title,
  description,
  footer,
  children,
  size = 'md',
  className,
  autoFocusContent = false,
}: DialogBaseProps): JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          sizeClass[size],
          'grid-rows-[auto_minmax(0,1fr)_auto] max-h-[calc(100dvh-2rem)] overflow-hidden',
          className,
        )}
        {...(autoFocusContent
          ? {}
          : {
              onOpenAutoFocus: (e) => {
                e.preventDefault();
              },
            })}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription
            className={description === undefined ? 'sr-only' : undefined}
          >
            {description ?? title}
          </DialogDescription>
        </DialogHeader>
        {/* The dialog is a 3-row grid (header / body / footer) capped at the
            viewport height (max-h on DialogContent). This body row is the
            only flexible track — minmax(0,1fr) — and scrolls internally when
            content is tall, so the fixed, vertically-centered dialog never
            spills past the top/bottom edges of a small mobile screen.
            min-w-0 forces grid tracks to honor the dialog max-width: without
            it, long unbreakable content (e.g. session preview text) pushes
            the dialog wider than its declared max. min-h-0 is the vertical
            counterpart — it lets this row shrink below its content height so
            overflow-y can take over instead of growing the dialog. */}
        <div className="min-h-0 min-w-0 overflow-x-hidden overflow-y-auto">
          {children}
        </div>
        {footer !== undefined && <DialogFooter>{footer}</DialogFooter>}
      </DialogContent>
    </Dialog>
  );
}
