import { useEffect, useState, type MouseEvent } from 'react';
import { cn } from '@/lib/utils';
import { usePrefsStore } from '../state/prefs.js';
import {
  DEFAULT_TOOLBAR_LAYOUT,
  type ToolbarKey,
  type ToolbarLayout,
} from './toolbar-layout.js';

interface Props {
  /**
   * Receive raw bytes to send to the PTY (escape sequences for arrows,
   * Esc, Tab, or Ctrl-modified characters when sticky Ctrl is active).
   */
  readonly onKey: (data: string) => void;
}

/**
 * Renders a `ToolbarLayout` as a grid of buttons. Layout source order:
 * 1. user preference (`usePrefsStore.toolbar`) when loaded
 * 2. fall back to DEFAULT_TOOLBAR_LAYOUT
 *
 * The store loads on mount so a freshly-logged-in client doesn't show the
 * default for a frame before snapping to the user's saved layout. Cells
 * are dispatched by `ToolbarKey.action`:
 * - plain: forward `payload` to PTY (consumes sticky Ctrl)
 * - ctrl-letter: translate payload (a..z) to its 0x01..0x1A byte
 * - toggle-sticky-ctrl: toggle the next-key Ctrl-prefix flag
 *
 * Visible on mobile only (`md:hidden`). Grid dims drive inline-style
 * `gridTemplateColumns/Rows` so user-customized layouts render without
 * any CSS rebuild.
 */
export function MobileToolbar({ onKey }: Props): JSX.Element {
  const storeLayout = usePrefsStore((s) => s.toolbar);
  const loaded = usePrefsStore((s) => s.loaded);
  const load = usePrefsStore((s) => s.load);
  const layout: ToolbarLayout = storeLayout ?? DEFAULT_TOOLBAR_LAYOUT;

  useEffect(() => {
    if (!loaded) {
      void load();
    }
  }, [loaded, load]);

  const [pendingCtrl, setPendingCtrl] = useState(false);

  /**
   * Block default mousedown so xterm keeps focus and the on-screen
   * keyboard doesn't dismiss when a shortcut is tapped.
   */
  const keepXtermFocus = (e: MouseEvent<HTMLButtonElement>): void => {
    e.preventDefault();
  };

  const dispatchKey = (key: ToolbarKey): void => {
    switch (key.action) {
      case 'plain':
        onKey(key.payload);
        if (pendingCtrl) setPendingCtrl(false);
        return;
      case 'ctrl-letter': {
        const code = key.payload.toLowerCase().charCodeAt(0);
        // Valid 'a'..'z' guaranteed by server schema; defensive guard for
        // older clients receiving a malformed custom payload.
        if (code >= 0x61 && code <= 0x7a) {
          onKey(String.fromCharCode(code & 0x1f));
        } else {
          onKey(key.payload);
        }
        setPendingCtrl(false);
        return;
      }
      case 'toggle-sticky-ctrl':
        setPendingCtrl((p) => !p);
        return;
    }
  };

  return (
    <div
      role="toolbar"
      aria-label="virtual keys"
      className="grid shrink-0 gap-1 border-t border-border bg-bg-elevated p-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))] md:hidden"
      style={{
        gridTemplateColumns: `repeat(${layout.cols}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${layout.rows}, minmax(2.25rem, 1fr))`,
      }}
    >
      {layout.cells.map((cell, idx) => {
        if (cell === null) {
          return (
            <span
              key={`empty-${idx}`}
              aria-hidden="true"
              className="rounded-sm border border-dashed border-border/50"
            />
          );
        }
        const isStickyCtrl = cell.action === 'toggle-sticky-ctrl';
        const isActive = isStickyCtrl && pendingCtrl;
        return (
          <button
            key={cell.id}
            type="button"
            onMouseDown={keepXtermFocus}
            onClick={(e) => {
              if (isStickyCtrl) e.preventDefault();
              dispatchKey(cell);
            }}
            aria-label={cell.ariaLabel}
            aria-pressed={isStickyCtrl ? pendingCtrl : undefined}
            title={cell.title}
            className={cn(
              'flex items-center justify-center rounded-sm border border-border bg-bg font-mono text-sm text-fg transition-colors active:bg-bg-elevated',
              isActive && 'border-brand bg-brand text-bg',
            )}
          >
            {cell.label}
          </button>
        );
      })}
    </div>
  );
}
