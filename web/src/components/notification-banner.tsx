import { useEffect, useState } from 'react';

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
      <div className="notification-banner is-denied" role="status">
        <span>桌面通知已被浏览器禁用，请在站点设置中恢复</span>
        <button
          type="button"
          className="notification-banner-dismiss"
          onClick={() => setDismissed(true)}
          aria-label="关闭"
        >
          ×
        </button>
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
    <div className="notification-banner" role="status">
      <span>开启桌面通知，cc 完成响应时即使切到别的标签也能提醒你</span>
      <div className="notification-banner-actions">
        <button
          type="button"
          className="notification-banner-enable"
          onClick={() => void onEnable()}
        >
          开启
        </button>
        <button
          type="button"
          className="notification-banner-dismiss"
          onClick={() => setDismissed(true)}
          aria-label="关闭"
        >
          ×
        </button>
      </div>
    </div>
  );
}
