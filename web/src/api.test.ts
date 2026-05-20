import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, newIdempotencyKey, type ApiError } from './api.js';
import { resetAuthStoreForTest, useAuthStore } from './state/auth.js';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

describe('api wrapper', () => {
  beforeEach(() => {
    localStorage.clear();
    resetAuthStoreForTest();
    useAuthStore.getState().setPaired('dev-1', 'laptop');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('sends credentials: include so the session cookie travels with the request', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true }));
    await api('/api/whatever');
    expect(spy).toHaveBeenCalledOnce();
    const init = spy.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.credentials).toBe('include');
    // No Authorization header — auth lives in the cookie now.
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.['Authorization']).toBeUndefined();
  });

  it('attaches Idempotency-Key on POST when provided', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ id: 'a' }, { status: 201 }));
    await api('/api/sessions', {
      method: 'POST',
      body: { projectId: 'demo', mode: 'create' },
      idempotencyKey: 'KEY-1',
    });
    const init = spy.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.['Idempotency-Key']).toBe('KEY-1');
    expect(headers?.['Content-Type']).toBe('application/json');
  });

  it('does NOT attach Idempotency-Key when not provided', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ id: 'a' }));
    await api('/api/sessions', { method: 'POST', body: { x: 1 } });
    const init = spy.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.['Idempotency-Key']).toBeUndefined();
  });

  it('triggers soft logout on 401 — clears active session, preserves stored slots', async () => {
    useAuthStore.getState().setPaired('dev-1', 'laptop');
    useAuthStore
      .getState()
      .setLimitedSession('user-1', 'alice', 'a'.repeat(64));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 401 }));
    await expect(api('/api/x')).rejects.toMatchObject({ code: 'unauthorized' });
    const after = useAuthStore.getState();
    expect(after.deviceId).toBeNull();
    expect(after.kind).toBeNull();
    expect(after.verifiedAt).toBeNull();
    // Stored owner slot + limited users survive — /login offers
    // whichever path the user prefers.
    expect(after.ownerDeviceId).toBe('dev-1');
    expect(after.limitedUsers).toHaveLength(1);
  });

  it('parses error envelope on 4xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ error: { code: 'invalid_request', message: 'bad' } }, { status: 400 }),
    );
    try {
      await api('/api/x');
      expect.fail('expected throw');
    } catch (err) {
      const apiErr = err as ApiError;
      expect(apiErr.code).toBe('invalid_request');
      expect(apiErr.status).toBe(400);
    }
  });

  it('returns undefined on 204', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    const r = await api('/api/x', { method: 'DELETE' });
    expect(r).toBeUndefined();
  });

  it('wraps fetch network errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(api('/api/x')).rejects.toMatchObject({ code: 'network_error', status: 0 });
  });

  it('newIdempotencyKey returns a UUID string', () => {
    const k = newIdempotencyKey();
    expect(k).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });
});
