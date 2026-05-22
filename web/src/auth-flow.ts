import {
  startAuthentication,
  startRegistration,
} from '@simplewebauthn/browser';
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/browser';

/**
 * Browser-side WebAuthn flow helpers. The server side lives in
 * src/server/routes/auth.ts; this module just wraps fetch + the
 * simplewebauthn browser bindings, returning shaped success/failure
 * results to keep callers free of try/catch boilerplate.
 */

export interface RegisterInitResponse {
  pendingId: string;
  options: PublicKeyCredentialCreationOptionsJSON;
}

export interface RegisterStatusPending {
  status: 'awaiting-registration' | 'awaiting-approval' | 'rejected';
}
export interface RegisterStatusApproved {
  status: 'approved';
  deviceId: string;
}
export type RegisterStatus = RegisterStatusPending | RegisterStatusApproved;

export interface LoginInitResponse {
  tempId: string;
  options: PublicKeyCredentialRequestOptionsJSON;
}

async function postJSON<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  });
  const ct = res.headers.get('content-type') ?? '';
  const data: unknown = ct.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    const msg =
      typeof data === 'object' && data !== null && 'error' in data
        ? ((data as { error?: { message?: string } }).error?.message ?? `HTTP ${res.status}`)
        : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data as T;
}

export async function registerInit(label: string): Promise<RegisterInitResponse> {
  return await postJSON<RegisterInitResponse>('/api/auth/register-init', { label });
}

export async function registerComplete(
  pendingId: string,
  attestation: RegistrationResponseJSON,
): Promise<{ status: 'awaiting-approval' }> {
  return await postJSON('/api/auth/register-complete', { pendingId, attestation });
}

export async function fetchRegisterStatus(pendingId: string): Promise<RegisterStatus> {
  const res = await fetch(
    `/api/auth/register-status?pendingId=${encodeURIComponent(pendingId)}`,
    { credentials: 'include' },
  );
  if (!res.ok) {
    throw new Error(`register-status failed: ${res.status}`);
  }
  return (await res.json()) as RegisterStatus;
}

export async function loginInit(deviceId: string): Promise<LoginInitResponse> {
  return await postJSON<LoginInitResponse>('/api/auth/login-init', { deviceId });
}

export async function loginComplete(
  tempId: string,
  assertion: AuthenticationResponseJSON,
): Promise<{ ok: true; deviceId: string }> {
  return await postJSON('/api/auth/login-complete', { tempId, assertion });
}

/**
 * Probes the cookie session: returns the device summary if logged in, null
 * if not. Used on app boot to decide whether to render workspace or login.
 */
export interface SessionProbe {
  readonly id: string;
  readonly label: string;
  readonly kind: 'owner' | 'limited';
}

export async function probeSession(): Promise<SessionProbe | null> {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'include' });
    if (res.status === 401) return null;
    if (!res.ok) return null;
    const body = (await res.json()) as {
      id: string;
      label: string;
      kind?: 'owner' | 'limited';
    };
    // Default to 'owner' for backward-compat when talking to a pre-multi-user
    // server (shouldn't happen in prod, but defensive).
    return { id: body.id, label: body.label, kind: body.kind ?? 'owner' };
  } catch {
    return null;
  }
}

/**
 * Result of a token-login attempt. `invalid` means the server
 * authoritatively rejected the token (401) — caller should forget it.
 * `transient` means the request never got an authoritative answer
 * (network down, 5xx, fetch threw) — caller should NOT forget the
 * token; back off and retry. Other 4xx are also surfaced as
 * `transient` to err on the side of preserving credentials; UX shows
 * the message so the user can decide.
 */
export type TokenLoginResult =
  | { ok: true; user: { username: string; kind: 'limited' } }
  | { ok: false; reason: 'invalid'; message: string }
  | { ok: false; reason: 'transient'; message: string };

export async function runTokenLogin(
  plaintext: string,
): Promise<TokenLoginResult> {
  let res: Response;
  try {
    res = await fetch('/api/auth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ token: plaintext }),
    });
  } catch (err) {
    return {
      ok: false,
      reason: 'transient',
      message: err instanceof Error ? err.message : '网络错误',
    };
  }
  if (res.status === 401) {
    return { ok: false, reason: 'invalid', message: 'token 无效或已过期' };
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      if (body.error?.message) detail = body.error.message;
    } catch {
      // body not JSON; keep generic message
    }
    return { ok: false, reason: 'transient', message: detail };
  }
  const body = (await res.json()) as {
    ok: boolean;
    user: { username: string; kind: 'limited' };
  };
  return { ok: true, user: body.user };
}

export async function logoutServer(): Promise<void> {
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
  } catch {
    // Best effort.
  }
}

export interface PairResult {
  deviceId: string;
}

/**
 * Drives the full register flow:
 * register-init → navigator.credentials.create → register-complete →
 * poll register-status until 'approved' or 'rejected' or timeout.
 */
export async function runPair(input: {
  label: string;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  signal?: AbortSignal;
  onPending?: () => void;
}): Promise<PairResult> {
  const { pendingId, options } = await registerInit(input.label);
  const attestation = await startRegistration({ optionsJSON: options });
  await registerComplete(pendingId, attestation);
  input.onPending?.();
  const interval = input.pollIntervalMs ?? 2_000;
  const timeoutAt = Date.now() + (input.pollTimeoutMs ?? 30 * 60 * 1000);
  for (;;) {
    if (input.signal?.aborted) throw new Error('cancelled');
    if (Date.now() > timeoutAt) throw new Error('approval timeout');
    await sleep(interval, input.signal);
    const s = await fetchRegisterStatus(pendingId);
    if (s.status === 'approved') return { deviceId: s.deviceId };
    if (s.status === 'rejected') throw new Error('rejected by approver');
  }
}

/** Drives the login flow. Returns true on success, false on credential miss. */
export async function runLogin(deviceId: string): Promise<boolean> {
  let init: LoginInitResponse;
  try {
    init = await loginInit(deviceId);
  } catch {
    return false;
  }
  let assertion: AuthenticationResponseJSON;
  try {
    assertion = await startAuthentication({ optionsJSON: init.options });
  } catch {
    return false;
  }
  try {
    await loginComplete(init.tempId, assertion);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('cancelled'));
      return;
    }
    const t = setTimeout(() => resolve(), ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new Error('cancelled'));
      },
      { once: true },
    );
  });
}
