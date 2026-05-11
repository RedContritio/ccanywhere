import { useAuthStore } from './state/auth.js';

export interface ApiError extends Error {
  code: string;
  status: number;
  details?: unknown;
}

export interface ResponseMeta {
  readonly status: number;
  readonly idempotencyReplayed: boolean;
  readonly idempotencyStored: boolean;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: object;
  idempotencyKey?: string;
  signal?: AbortSignal;
  /** Called once with response status + ccanywhere idempotency headers
   *  before the body is decoded. Lets callers record trace context
   *  (POST /api/sessions in particular needs to know whether the request
   *  was a 200 attach vs 201 created — both look the same in the body). */
  onMeta?: (meta: ResponseMeta) => void;
}

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (method === 'POST' && opts.idempotencyKey !== undefined) {
    headers['Idempotency-Key'] = opts.idempotencyKey;
  }

  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      credentials: 'include',
      body: opts.body !== undefined ? JSON.stringify(opts.body) : null,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
  } catch (err) {
    throw makeError(
      'network_error',
      0,
      err instanceof Error ? err.message : 'network error',
    );
  }

  if (res.status === 401) {
    useAuthStore.getState().logout();
    throw makeError('unauthorized', 401, 'session expired');
  }

  if (opts.onMeta !== undefined) {
    opts.onMeta({
      status: res.status,
      idempotencyReplayed: res.headers.get('idempotency-replayed') === 'true',
      idempotencyStored: res.headers.get('idempotency-stored') === 'true',
    });
  }

  const ct = res.headers.get('content-type') ?? '';
  if (res.status === 204 || res.headers.get('content-length') === '0') {
    return undefined as T;
  }

  let body: unknown = null;
  if (ct.includes('application/json')) {
    try {
      body = await res.json();
    } catch {
      throw makeError('invalid_response', res.status, 'response not valid JSON');
    }
  } else {
    body = await res.text();
  }

  if (!res.ok) {
    const errBody = (body ?? {}) as { error?: { code?: string; message?: string } };
    throw makeError(
      errBody.error?.code ?? `status_${res.status}`,
      res.status,
      errBody.error?.message ?? `HTTP ${res.status}`,
      body,
    );
  }

  return body as T;
}

function makeError(
  code: string,
  status: number,
  message: string,
  details?: unknown,
): ApiError {
  const err = new Error(message) as ApiError;
  err.name = 'ApiError';
  err.code = code;
  err.status = status;
  if (details !== undefined) err.details = details;
  return err;
}

/**
 * Generate a UUID v4 idempotency key.
 *
 * `crypto.randomUUID` is gated to "secure context" (HTTPS / localhost), so
 * it's `undefined` when ccanywhere is reached over plain HTTP via frpc.
 * `crypto.getRandomValues` works in insecure contexts too, so we build the
 * UUID by hand from 16 random bytes when randomUUID isn't available.
 */
export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  // RFC 4122 v4: set version (4) and variant (10xx) bits.
  const b6 = bytes[6] ?? 0;
  const b8 = bytes[8] ?? 0;
  bytes[6] = (b6 & 0x0f) | 0x40;
  bytes[8] = (b8 & 0x3f) | 0x80;
  const hex = (n: number): string => n.toString(16).padStart(2, '0');
  const h = Array.from(bytes, hex);
  return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${h[9]}-${h[10]}${h[11]}${h[12]}${h[13]}${h[14]}${h[15]}`;
}
