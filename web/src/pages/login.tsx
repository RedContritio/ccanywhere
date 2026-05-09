import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { probeSession, runLogin, runPair } from '../auth-flow.js';
import { ThemeToggle } from '../components/theme-toggle.js';
import { useAuthStore } from '../state/auth.js';

type Mode =
  | { kind: 'probing' }
  | { kind: 'idle'; suggestLogin: boolean }
  | { kind: 'pairing-create'; label: string }
  | { kind: 'pairing-await' }
  | { kind: 'logging-in' }
  | { kind: 'error'; message: string };

export function LoginPage(): JSX.Element {
  const navigate = useNavigate();
  const setPaired = useAuthStore((s) => s.setPaired);
  const markVerified = useAuthStore((s) => s.markVerified);
  const logout = useAuthStore((s) => s.logout);
  const deviceId = useAuthStore((s) => s.deviceId);
  const storedLabel = useAuthStore((s) => s.label);

  const [mode, setMode] = useState<Mode>({ kind: 'probing' });
  const [labelInput, setLabelInput] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  // Boot: probe existing cookie session; if it's live, go straight to /workspace.
  // If we have a stored deviceId but no live session, offer one-click login.
  //
  // Edge case: cookie still valid but localStorage was wiped (manual clear,
  // older client logged out before we shipped the server-side logout call,
  // etc.). In that case probeSession returns the device but our store has
  // null deviceId — RequireAuth would bounce back to /login and we'd loop.
  // Rebuild the snapshot from /api/auth/me so RequireAuth sees a non-null
  // deviceId.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const me = await probeSession();
      if (cancelled) return;
      if (me !== null) {
        setPaired(me.id, me.label);
        navigate('/workspace', { replace: true });
        return;
      }
      setMode({ kind: 'idle', suggestLogin: deviceId !== null });
    })();
    return () => {
      cancelled = true;
    };
  }, [deviceId, setPaired, navigate]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const onPairSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    const label = labelInput.trim();
    if (label.length === 0) return;
    setMode({ kind: 'pairing-create', label });
    abortRef.current = new AbortController();
    void runPair({
      label,
      signal: abortRef.current.signal,
      onPending: () => setMode({ kind: 'pairing-await' }),
    })
      .then((r) => {
        setPaired(r.deviceId, label);
        navigate('/workspace', { replace: true });
      })
      .catch((err: unknown) => {
        setMode({
          kind: 'error',
          message: err instanceof Error ? err.message : 'pair failed',
        });
      });
  };

  const onLoginClick = (): void => {
    if (deviceId === null) return;
    setMode({ kind: 'logging-in' });
    void runLogin(deviceId)
      .then((ok) => {
        if (ok) {
          markVerified();
          navigate('/workspace', { replace: true });
        } else {
          // Credential miss / device revoked — wipe local state.
          logout();
          setMode({
            kind: 'error',
            message: 'login failed — device may have been revoked, please pair again',
          });
        }
      })
      .catch((err: unknown) => {
        setMode({
          kind: 'error',
          message: err instanceof Error ? err.message : 'login error',
        });
      });
  };

  const cancelPair = (): void => {
    abortRef.current?.abort();
    setMode({ kind: 'idle', suggestLogin: deviceId !== null });
  };

  return (
    <main className="login-page">
      <div className="login-page-corner">
        <ThemeToggle />
      </div>
      <div className="login-card">
        <h1 className="login-title">CC anywhere</h1>
        <p className="login-subtitle">把本地 cc 映射到 web 的远程入口</p>

        {mode.kind === 'probing' && <p className="login-hint">检查会话状态…</p>}

        {mode.kind === 'idle' && mode.suggestLogin && (
          <div className="login-form">
            <p className="login-hint">
              已配对设备
              {storedLabel !== null ? (
                <>
                  ：<strong>{storedLabel}</strong>
                </>
              ) : (
                ''
              )}
            </p>
            <button type="button" className="login-submit" onClick={onLoginClick}>
              用本机生物识别登入
            </button>
            <button
              type="button"
              className="login-link"
              onClick={() => {
                logout();
                setMode({ kind: 'idle', suggestLogin: false });
              }}
            >
              重新配对其他设备
            </button>
          </div>
        )}

        {mode.kind === 'idle' && !mode.suggestLogin && (
          <form onSubmit={onPairSubmit} className="login-form">
            <label className="login-field">
              <span>设备名</span>
              <input
                type="text"
                value={labelInput}
                onChange={(e) => setLabelInput(e.target.value)}
                placeholder="iPhone / 工作 mac / 朋友的笔记本"
                required
                autoFocus
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <p className="login-hint">
              点击「申请配对」会调用浏览器的生物识别（Touch ID / Face ID / 指纹），
              然后等待 mac 上 <code>ccanywhere approve</code> 命令通过。
            </p>
            <button
              type="submit"
              className="login-submit"
              disabled={labelInput.trim().length === 0}
            >
              申请配对
            </button>
          </form>
        )}

        {mode.kind === 'pairing-create' && (
          <p className="login-hint">请用生物识别完成「{mode.label}」的注册…</p>
        )}

        {mode.kind === 'pairing-await' && (
          <div className="login-form">
            <p className="login-hint">申请已提交，正在等待审批…</p>
            <button type="button" className="login-link" onClick={cancelPair}>
              取消
            </button>
          </div>
        )}

        {mode.kind === 'logging-in' && <p className="login-hint">正在用生物识别登入…</p>}

        {mode.kind === 'error' && (
          <div className="login-form">
            <p className="login-error" role="alert">
              {mode.message}
            </p>
            <button
              type="button"
              className="login-link"
              onClick={() => setMode({ kind: 'idle', suggestLogin: deviceId !== null })}
            >
              重试
            </button>
          </div>
        )}
      </div>
    </main>
  );
}
