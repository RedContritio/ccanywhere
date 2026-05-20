import { Button } from '@/components/ui/button';
import { useNavigate } from 'react-router-dom';
import { ThemeCycleButton } from './theme-toggle.js';

interface Props {
  readonly label: string | null;
  readonly onLogout: () => void;
}

/**
 * Sidebar top header extracted from workspace.tsx.
 * Title button → back to /workspace; label chip; theme cycle; logout.
 * Renders identically to the inlined version; no behavior change.
 */
export function WorkspaceSidebarHeader({ label, onLogout }: Props): JSX.Element {
  const navigate = useNavigate();
  return (
    <header
      data-workspace-header
      className="relative z-[5] flex shrink-0 items-center gap-2 border-b border-border px-3 py-2 max-md:flex-col max-md:items-stretch max-md:gap-2"
    >
      <button
        type="button"
        onClick={() => navigate('/workspace')}
        aria-label="返回主页"
        title="返回主页"
        className="text-sm font-semibold tracking-tight hover:text-brand"
      >
        <span className="text-claude">CC</span> anywhere
      </button>
      <div className="flex-1 max-md:hidden" />
      <div className="flex items-center gap-2 max-md:justify-between">
        <span className="truncate font-mono text-xs text-fg-muted max-md:flex-1 max-md:text-center">
          {label ?? 'unnamed'}
        </span>
        <ThemeCycleButton />
        <Button type="button" variant="ghost" size="xs" onClick={onLogout}>
          登出
        </Button>
      </div>
    </header>
  );
}
