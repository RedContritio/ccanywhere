import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';

type Permission = 'default' | 'granted' | 'denied' | 'unsupported';

function readPermission(): Permission {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

export function NotificationBanner(): JSX.Element | null {
  const [permission, setPermission] = useState<Permission>(() => readPermission());
  const [dismissed, setDismissed] = useState(false);

  // Permission can change in another tab / settings panel; re-poll when
  // the document regains visibility.
  useEffect(() => {
    const onVis = (): void => {
      if (!document.hidden) setPermission(readPermission());
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  if (permission === 'granted' || permission === 'unsupported' || dismissed) {
    return null;
  }

  if (permission === 'denied') {
    return (
      <div
        role="status"
        className="flex items-center gap-2 border-b border-border bg-bg-elevated px-3 py-2 text-xs text-warning"
      >
        <span className="flex-1">桌面通知已被浏览器禁用，请在站点设置中恢复</span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={() => setDismissed(true)}
          aria-label="关闭"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    );
  }

  const onEnable = async (): Promise<void> => {
    if (typeof Notification === 'undefined') return;
    try {
      const result = await Notification.requestPermission();
      setPermission(result);
    } catch {
      // some browsers throw when permission API is invoked from an
      // insecure context; just refresh the read.
      setPermission(readPermission());
    }
  };

  return (
    <div
      role="status"
      className="flex items-center gap-2 border-b border-border bg-bg-elevated px-3 py-2 text-xs"
    >
      <span className="flex-1 text-fg-muted">
        开启桌面通知，cc 完成响应时即使切到别的标签也能提醒你
      </span>
      <Button type="button" variant="default" size="xs" onClick={() => void onEnable()}>
        开启
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={() => setDismissed(true)}
        aria-label="关闭"
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
