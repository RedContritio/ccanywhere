import { Menu } from 'lucide-react';

/**
 * Placeholder pane shown when no session is selected or selection is in
 * an empty/error state. Hosts the mobile-only ☰ drawer trigger so the
 * sidebar stays reachable from the empty view.
 */
export function EmptyPane({
  children,
  onOpenDrawer,
}: {
  children: React.ReactNode;
  onOpenDrawer: () => void;
}): JSX.Element {
  return (
    <div className="relative flex flex-1 items-center justify-center p-4 text-center text-sm text-fg-muted">
      <button
        type="button"
        aria-label="打开侧边栏"
        onClick={onOpenDrawer}
        className="absolute top-3 left-3 rounded-md border border-border px-2 py-1 leading-none md:hidden"
      >
        <Menu className="h-4 w-4" />
      </button>
      {children}
    </div>
  );
}
