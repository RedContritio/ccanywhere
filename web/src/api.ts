import { useAuthStore } from './state/auth.js';

export interface ApiError extends Error {
  code: string;
  status: number;
  details?: unknown;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: object;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const token = useAuthStore.getState().token;
  if (token === null) {
    throw makeError('not_authenticated', 0, 'no token in auth store');
  }

  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
  };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (method === 'POST' && opts.idempotencyKey !== undefined) {
    headers['Idempotency-Key'] = opts.idempotencyKey;
  }

  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
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

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}
