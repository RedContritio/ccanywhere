import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '../components/theme-toggle.js';
import { ToolbarConfigSection } from '../components/toolbar-config-section.js';
import { usePrefsStore } from '../state/prefs.js';

export function SettingsPage(): JSX.Element {
  const navigate = useNavigate();
  const loaded = usePrefsStore((s) => s.loaded);
  const load = usePrefsStore((s) => s.load);
  const loadError = usePrefsStore((s) => s.loadError);

  // Trigger prefs fetch when the page mounts so we don't paint the editor
  // against stale (zero-init) layout. The store is cached cross-page so a
  // user who already opened the workspace will see loaded=true here.
  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  return (
    <main className="min-h-screen bg-bg font-sans text-fg">
      <header className="flex items-center gap-3 border-b border-border px-4 py-3">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => navigate('/workspace')}
        >
          ← 返回
        </Button>
        <h1 className="text-sm font-semibold">设置</h1>
        <div className="flex-1" />
        <ThemeToggle />
      </header>
      <div className="mx-auto max-w-2xl space-y-8 px-4 py-6">
        {loadError !== null && (
          <p className="text-sm text-danger" role="alert">
            加载偏好失败：{loadError}
          </p>
        )}
        <ToolbarConfigSection />
      </div>
    </main>
  );
}
