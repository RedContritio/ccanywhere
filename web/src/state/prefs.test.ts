import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resetPrefsStoresForTest,
  useActiveSessionStore,
  usePrefsStore,
} from './prefs.js';

function mockJsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('usePrefsStore', () => {
  beforeEach(() => {
    resetPrefsStoresForTest();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('initial state: not loaded, no toolbar, no error', () => {
    const s = usePrefsStore.getState();
    expect(s.toolbar).toBeNull();
    expect(s.loaded).toBe(false);
    expect(s.loadError).toBeNull();
  });

  it('load() with empty server response → loaded:true, toolbar:null', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockJsonResponse({}));
    await usePrefsStore.getState().load();
    const s = usePrefsStore.getState();
    expect(s.loaded).toBe(true);
    expect(s.toolbar).toBeNull();
    expect(s.loadError).toBeNull();
  });

  it('load() with toolbar response stores it', async () => {
    const layout = { rows: 1, cols: 3, cells: [null, null, null] };
    globalThis.fetch = vi.fn().mockResolvedValue(mockJsonResponse({ toolbar: layout }));
    await usePrefsStore.getState().load();
    expect(usePrefsStore.getState().toolbar).toEqual(layout);
  });

  it('load() on network error keeps loaded:false + records error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('boom'));
    await usePrefsStore.getState().load();
    const s = usePrefsStore.getState();
    expect(s.loaded).toBe(false);
    expect(s.loadError).toMatch(/boom/);
  });

  it('saveToolbar PUTs and updates local state', async () => {
    const layout = {
      rows: 1,
      cols: 3,
      cells: [
        { id: 'esc', label: 'Esc', action: 'plain' as const, payload: '\x1b' },
        null,
        null,
      ],
    };
    const fetchFn = vi.fn().mockResolvedValue(mockJsonResponse({ toolbar: layout }));
    globalThis.fetch = fetchFn;
    await usePrefsStore.getState().saveToolbar(layout);
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/me/preferences',
      expect.objectContaining({ method: 'PUT' }),
    );
    expect(usePrefsStore.getState().toolbar).toEqual(layout);
  });

  it('saveToolbar(null) clears local toolbar after server returns {}', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockJsonResponse({}));
    await usePrefsStore.getState().saveToolbar(null);
    expect(usePrefsStore.getState().toolbar).toBeNull();
  });
});

describe('useActiveSessionStore', () => {
  beforeEach(() => {
    resetPrefsStoresForTest();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('load() stores remote sessionId', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(mockJsonResponse({ sessionId: 'abc-123' }));
    await useActiveSessionStore.getState().load();
    const s = useActiveSessionStore.getState();
    expect(s.loaded).toBe(true);
    expect(s.sessionId).toBe('abc-123');
  });

  it('load() error keeps loaded:false silently', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('net'));
    await useActiveSessionStore.getState().load();
    expect(useActiveSessionStore.getState().loaded).toBe(false);
  });

  it('setRemote() optimistically updates local then PUTs', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(mockJsonResponse({ sessionId: 'new-sid' }));
    globalThis.fetch = fetchFn;
    await useActiveSessionStore.getState().setRemote('new-sid');
    expect(useActiveSessionStore.getState().sessionId).toBe('new-sid');
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/me/active-session',
      expect.objectContaining({ method: 'PUT' }),
    );
  });

  it('setRemote() local wins on server PUT failure', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('server down'));
    await useActiveSessionStore.getState().setRemote('local-sid');
    expect(useActiveSessionStore.getState().sessionId).toBe('local-sid');
  });
});
