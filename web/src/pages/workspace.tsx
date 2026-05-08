import { useNavigate } from 'react-router-dom';
import { ThemeToggle } from '../components/theme-toggle.js';
import { useAuthStore } from '../state/auth.js';

export function WorkspacePage(): JSX.Element {
  const label = useAuthStore((s) => s.label);
  const logout = useAuthStore((s) => s.logout);
  const navigate = useNavigate();

  const onLogout = (): void => {
    logout();
    navigate('/login', { replace: true });
  };

  return (
    <div className="workspace">
      <header className="workspace-header">
        <div className="header-brand">ccanywhere</div>
        <div className="header-spacer" />
        <span className="header-device">{label ?? 'unnamed'}</span>
        <ThemeToggle />
        <button type="button" className="header-logout" onClick={onLogout}>
          登出
        </button>
      </header>
      <div className="workspace-body">
        <aside className="session-pane">
          <div className="session-pane-header">
            <span>会话</span>
            <button type="button" className="session-new-btn" disabled title="phase 4 后续">
              + 新建
            </button>
          </div>
          <div className="session-pane-empty">
            phase 4-2/3 之后这里会显示 session 列表。
          </div>
        </aside>
        <section className="terminal-pane">
          <div className="terminal-pane-empty">
            选中一个 session 显示 xterm.js 终端（phase 4-4 之后）。
          </div>
        </section>
      </div>
    </div>
  );
}
