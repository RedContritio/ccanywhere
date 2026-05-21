import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  probeSession,
  runLogin,
  runPair,
  runTokenLogin,
  type TokenLoginResult,
} from '../auth-flow.js';
import { ThemeToggle } from '../components/theme-toggle.js';
import {
  useAuthStore,
  type LimitedUserRecord,
  type TokenRecord,
} from '../state/auth.js';

type Mode =
  | { kind: 'probing' }
  | { kind: 'idle' }
  | { kind: 'pairing-create'; label: string }
  | { kind: 'pairing-await' }
  | { kind: 'logging-in' }
  | { kind: 'trying-user'; username: string }
  | { kind: 'token-input' }
  | { kind: 'token-submitting' }
  | { kind: 'error'; message: string; suggestTokenInput?: boolean };

export function LoginPage(): JSX.Element {
  const navigate = useNavigate();
  const setPaired = useAuthStore((s) => s.setPaired);
  const setLimitedSession = useAuthStore((s) => s.setLimitedSession);
  const markVerified = useAuthStore((s) => s.markVerified);
  const forgetToken = useAuthStore((s) => s.forgetToken);
  const forgetOwnerCredential = useAuthStore((s) => s.forgetOwnerCredential);
  const ownerDeviceId = useAuthStore((s) => s.ownerDeviceId);
  const ownerLabel = useAuthStore((s) => s.ownerLabel);
  const limitedUsers = useAuthStore((s) => s.limitedUsers);

  const [mode, setMode] = useState<Mode>({ kind: 'probing' });
  const [labelInput, setLabelInput] = useState('');
  const [tokenInput, setTokenInput] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  // Boot: probe existing cookie session; if it's live, go straight to /workspace.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const me = await probeSession();
      if (cancelled) return;
      if (me !== null) {
        if (me.kind === 'limited') setLimitedSession(me.id, me.label, null);
        else setPaired(me.id, me.label);
        navigate('/workspace', { replace: true });
        return;
      }
      setMode({ kind: 'idle' });
    })();
    return () => {
      cancelled = true;
    };
  }, [setPaired, setLimitedSession, navigate]);

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
    if (ownerDeviceId === null) return;
    setMode({ kind: 'logging-in' });
    void runLogin(ownerDeviceId)
      .then((ok) => {
        if (ok) {
          markVerified();
          setPaired(ownerDeviceId, ownerLabel ?? '');
          navigate('/workspace', { replace: true });
        } else {
          forgetOwnerCredential();
          setMode({
            kind: 'error',
            message: '生物识别登入失败 — 设备可能已被撤销，请重新配对',
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

  // Try one plaintext token against the server with capped exponential
  // backoff for transient failures. Returns the final TokenLoginResult
  // so the caller can decide whether to forget the token (invalid) or
  // preserve it (transient).
  //
  // On `ok: true`, also updates the store via probeSession → setLimitedSession.
  const tryToken = async (t: string): Promise<TokenLoginResult> => {
    // 500ms, 1s, 2s, 4s — give up after 4 attempts (~7.5s total).
    const BACKOFF_MS = [500, 1000, 2000, 4000];
    let result: TokenLoginResult = {
      ok: false,
      reason: 'transient',
      message: '未尝试',
    };
    for (let i = 0; i <= BACKOFF_MS.length; i++) {
      result = await runTokenLogin(t);
      if (result.ok) {
        const me = await probeSession();
        if (me !== null && me.kind === 'limited') {
          setLimitedSession(me.id, me.label, t);
        } else {
          // probeSession failed (e.g. cookie domain mismatch) but the
          // server accepted the token — use the username it echoed as
          // both userId and label. Never use the token plaintext as
          // the visible label (sidebar bug).
          setLimitedSession(result.user.username, result.user.username, t);
        }
        return result;
      }
      // Invalid = server-authoritative rejection. No point retrying.
      if (result.reason === 'invalid') return result;
      // Transient — back off and retry (unless we're out of attempts).
      const delay = BACKOFF_MS[i];
      if (delay === undefined) break;
      await new Promise((r) => setTimeout(r, delay));
    }
    return result;
  };

  const submitNewToken = (t: string): void => {
    if (t.length < 32) return;
    setMode({ kind: 'token-submitting' });
    void (async () => {
      const r = await tryToken(t);
      if (r.ok) {
        navigate('/workspace', { replace: true });
        return;
      }
      // submitNewToken's token isn't in the store yet — invalid /
      // transient both surface as plain error messages here. Nothing
      // to forget either way.
      setMode({ kind: 'error', message: r.message });
    })();
  };

  const onTokenSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    submitNewToken(tokenInput.trim());
  };

  // Click a stored user → try its tokens newest-expiry-first.
  // - invalid token → forget it, move to next token
  // - transient (network glitch / 5xx, after backoff cap) → stop, KEEP
  // the token, surface "network issue, please retry"
  // - all tokens exhausted as invalid → KEEP the user record (with
  // empty tokens) so the device remembers it's been used here;
  // surface a hint nudging the user to paste a fresh token.
  const onPickUser = (user: LimitedUserRecord): void => {
    if (user.tokens.length === 0) {
      setTokenInput('');
      setMode({ kind: 'token-input' });
      return;
    }
    setMode({ kind: 'trying-user', username: user.username });
    void (async () => {
      const sorted: TokenRecord[] = [...user.tokens].sort(
        (a, b) => b.expiresAt - a.expiresAt,
      );
      for (const t of sorted) {
        const r = await tryToken(t.token);
        if (r.ok) {
          navigate('/workspace', { replace: true });
          return;
        }
        if (r.reason === 'transient') {
          setMode({
            kind: 'error',
            message: `网络异常，未能完成 ${user.username} 的登录：${r.message}`,
          });
          return;
        }
        forgetToken(user.userId, t.token);
      }
      setMode({
        kind: 'error',
        message: `${user.username} 的已存 token 都已失效，请输入新 token`,
        suggestTokenInput: true,
      });
    })();
  };

  const cancelPair = (): void => {
    abortRef.current?.abort();
    setMode({ kind: 'idle' });
  };

  return (
    <main className="relative grid min-h-screen place-items-center bg-bg px-4 py-8 font-sans text-fg">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-sm space-y-5 rounded-lg border border-border bg-bg-elevated p-6">
        <header className="space-y-1">
          <h1 className="text-lg font-semibold tracking-tight"><span className="text-claude">CC</span> anywhere</h1>
          <p className="text-xs text-fg-muted">
            在任何屏幕上，继续你的 cc。
          </p>
        </header>

        {mode.kind === 'probing' && <Hint>检查会话状态…</Hint>}

        {mode.kind === 'idle' && (
          <IdleChoices
            ownerDeviceId={ownerDeviceId}
            ownerLabel={ownerLabel}
            limitedUsers={limitedUsers}
            labelInput={labelInput}
            setLabelInput={setLabelInput}
            onPairSubmit={onPairSubmit}
            onLoginClick={onLoginClick}
            onPickUser={onPickUser}
            onSwitchToTokenInput={() => {
              setTokenInput('');
              setMode({ kind: 'token-input' });
            }}
          />
        )}

        {mode.kind === 'token-input' && (
          <form onSubmit={onTokenSubmit} className="space-y-4">
            <Field>
              <Label htmlFor="login-token">Token</Label>
              <Input
                id="login-token"
                type="password"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder="64 位十六进制 token"
                required
                autoFocus
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
              />
            </Field>
            <Button
              type="submit"
              className="w-full"
              disabled={tokenInput.trim().length < 32}
            >
              登录
            </Button>
            <LinkButton onClick={() => setMode({ kind: 'idle' })}>
              返回
            </LinkButton>
          </form>
        )}

        {mode.kind === 'token-submitting' && <Hint>正在验证 token…</Hint>}

        {mode.kind === 'trying-user' && (
          <Hint>正在用 {mode.username} 的已存 token 登录…</Hint>
        )}

        {mode.kind === 'pairing-create' && (
          <Hint>
            请用生物识别完成「
            <span className="font-mono text-fg">{mode.label}</span>
            」的注册…
          </Hint>
        )}

        {mode.kind === 'pairing-await' && (
          <div className="space-y-3">
            <Hint>申请已提交，正在等待审批…</Hint>
            <LinkButton onClick={cancelPair}>取消</LinkButton>
          </div>
        )}

        {mode.kind === 'logging-in' && <Hint>正在用生物识别登入…</Hint>}

        {mode.kind === 'error' && (
          <div className="space-y-3">
            <p className="text-sm text-danger" role="alert">
              {mode.message}
            </p>
            {mode.suggestTokenInput === true && (
              <Button
                type="button"
                className="w-full"
                onClick={() => {
                  setTokenInput('');
                  setMode({ kind: 'token-input' });
                }}
              >
                输入新 token
              </Button>
            )}
            <LinkButton onClick={() => setMode({ kind: 'idle' })}>
              返回
            </LinkButton>
          </div>
        )}
      </div>
    </main>
  );
}

function Field({ children }: { children: React.ReactNode }): JSX.Element {
  return <div className="space-y-1.5">{children}</div>;
}

function Hint({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <p className="text-xs leading-relaxed text-fg-muted">{children}</p>
  );
}

function Code({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <code className="rounded-sm bg-bg px-1 py-0.5 font-mono text-[11px] text-fg">
      {children}
    </code>
  );
}

function LinkButton({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-center text-xs text-fg-muted underline-offset-4 hover:text-fg hover:underline"
    >
      {children}
    </button>
  );
}

/**
 * Renders the idle login screen: owner webauthn (if any) → stored
 * limited-user buttons (one per user) → "用新 token 登录" link. Each
 * limited-user button delegates to onPickUser which runs the auto-try
 * sequence over that user's tokens (newest-expiry first).
 *
 * When no credentials are stored at all, the form falls back to the
 * pair flow (owner first-time setup) plus a token-input escape link.
 */
function IdleChoices(props: {
  ownerDeviceId: string | null;
  ownerLabel: string | null;
  limitedUsers: readonly LimitedUserRecord[];
  labelInput: string;
  setLabelInput: (s: string) => void;
  onPairSubmit: (e: FormEvent<HTMLFormElement>) => void;
  onLoginClick: () => void;
  onPickUser: (u: LimitedUserRecord) => void;
  onSwitchToTokenInput: () => void;
}): JSX.Element {
  const {
    ownerDeviceId,
    ownerLabel,
    limitedUsers,
    labelInput,
    setLabelInput,
    onPairSubmit,
    onLoginClick,
    onPickUser,
    onSwitchToTokenInput,
  } = props;
  const hasOwner = ownerDeviceId !== null;
  const hasLimited = limitedUsers.length > 0;

  if (hasOwner || hasLimited) {
    return (
      <div className="space-y-3">
        {hasOwner && (
          <>
            <p className="text-sm text-fg-muted">
              已配对设备
              {ownerLabel !== null && ownerLabel !== '' && (
                <>
                  ：<span className="font-mono text-fg">{ownerLabel}</span>
                </>
              )}
            </p>
            <Button type="button" className="w-full" onClick={onLoginClick}>
              用本机生物识别登入
            </Button>
          </>
        )}
        {hasLimited && (
          <div className="space-y-2">
            {hasOwner && (
              <p className="text-xs text-fg-muted">或继续以受限用户身份登录</p>
            )}
            {limitedUsers.map((u) => (
              <Button
                key={u.userId}
                type="button"
                variant="outline"
                className="w-full justify-between gap-2"
                onClick={() => onPickUser(u)}
              >
                <span className="truncate font-mono">{u.username}</span>
                {u.tokens.length > 1 && (
                  <span className="text-xs text-fg-muted">
                    {u.tokens.length} token
                  </span>
                )}
              </Button>
            ))}
          </div>
        )}
        <LinkButton onClick={onSwitchToTokenInput}>用新 token 登录</LinkButton>
      </div>
    );
  }

  return (
    <form onSubmit={onPairSubmit} className="space-y-4">
      <Field>
        <Label htmlFor="login-label">设备名</Label>
        <Input
          id="login-label"
          type="text"
          value={labelInput}
          onChange={(e) => setLabelInput(e.target.value)}
          placeholder="iPhone / 工作 mac / 朋友的笔记本"
          required
          autoFocus
          autoComplete="off"
          spellCheck={false}
        />
      </Field>
      <Hint>
        点击「配对此设备」会调用浏览器的生物识别（Touch ID / Face ID /
        指纹），然后等待 mac 上 <Code>ccanywhere approve</Code> 命令通过。
      </Hint>
      <Button
        type="submit"
        className="w-full"
        disabled={labelInput.trim().length === 0}
      >
        配对此设备
      </Button>
      <LinkButton onClick={onSwitchToTokenInput}>
        用 token 登录（受限用户）
      </LinkButton>
    </form>
  );
}
