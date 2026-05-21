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
        className={cn(sizeClass[size], 'overflow-hidden', className)}
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
        {/* min-w-0 forces grid tracks to honor dialog max-width: without it,
            grid items default to min-content sizing and long unbreakable
            content (e.g. session preview text) can push the dialog wider
            than its declared max. overflow-hidden truncates visually any
            child that still tries to overflow horizontally. */}
        <div className="min-w-0 overflow-x-hidden">{children}</div>
        {footer !== undefined && <DialogFooter>{footer}</DialogFooter>}
      </DialogContent>
    </Dialog>
  );
}
