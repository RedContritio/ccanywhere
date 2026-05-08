import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../state/auth.js';

type Status =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string };

export function LoginPage(): JSX.Element {
  const [token, setToken] = useState('');
  const [label, setLabel] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const login = useAuthStore((s) => s.login);
  const navigate = useNavigate();

  const onSubmit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    const t = token.trim();
    if (t.length === 0) return;
    setStatus({ kind: 'loading' });

    let res: Response;
    try {
      res = await fetch('/api/projects', {
        headers: { Authorization: `Bearer ${t}` },
      });
    } catch {
      setStatus({ kind: 'error', message: '服务不可达，检查网络或 frp 链路' });
      return;
    }

    if (res.status === 401) {
      setStatus({ kind: 'error', message: 'token 无效' });
      return;
    }
    if (!res.ok) {
      setStatus({ kind: 'error', message: `服务返回 ${res.status}` });
      return;
    }

    login(t, label.trim().length > 0 ? label.trim() : 'unnamed');
    navigate('/workspace', { replace: true });
  };

  return (
    <main className="login-page">
      <div className="login-card">
        <h1 className="login-title">CC anywhere</h1>
        <p className="login-subtitle">把本地 cc 映射到 web 的远程入口</p>
        <form onSubmit={(e) => void onSubmit(e)} className="login-form">
          <label className="login-field">
            <span>Token</span>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="config.json 中的 tokens[].token"
              required
              autoFocus
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label className="login-field">
            <span>设备标签（可选）</span>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="laptop / phone"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          {status.kind === 'error' && (
            <p className="login-error" role="alert">
              {status.message}
            </p>
          )}
          <button
            type="submit"
            className="login-submit"
            disabled={status.kind === 'loading' || token.trim().length === 0}
          >
            {status.kind === 'loading' ? '验证中…' : '登入'}
          </button>
        </form>
      </div>
    </main>
  );
}
