import { create } from 'zustand';
import { api } from '../api.js';
import type { ToolbarLayout } from '../components/toolbar-layout.js';

/**
 * `api()` only speaks GET/POST/DELETE; preferences + active-session use
 * PUT. Reach for fetch directly so we don't have to widen the shared
 * helper for two callers.
 */
async function apiPut<T>(path: string, body: object): Promise<T> {
  const res = await fetch(path, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const err = (await res.json()) as { error?: { message?: string } };
      if (err.error?.message) detail = err.error.message;
    } catch {
      // body not JSON
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

/**
 * User preferences synced via `/api/me/preferences`. Server is the single
 * source of truth (cross-device). On load failure `loaded:false` is kept
 * so callers fall back to defaults without pretending the server confirmed
 * an empty layout.
 */
interface PrefsState {
  toolbar: ToolbarLayout | null;
  /** True after the first successful GET (even if server returned {}). */
  loaded: boolean;
  loadError: string | null;
}

interface PrefsActions {
  load: () => Promise<void>;
  /** PUT the new toolbar; null clears (server returns {} → default). */
  saveToolbar: (toolbar: ToolbarLayout | null) => Promise<void>;
  /** Local-only reset on logout. */
  resetLocal: () => void;
}

interface PrefsResponse {
  readonly toolbar?: ToolbarLayout;
}

const prefsInitial: PrefsState = {
  toolbar: null,
  loaded: false,
  loadError: null,
};

export const usePrefsStore = create<PrefsState & PrefsActions>()((set) => ({
  ...prefsInitial,
  load: async () => {
    try {
      const body = await api<PrefsResponse>('/api/me/preferences');
      set({ toolbar: body.toolbar ?? null, loaded: true, loadError: null });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'load failed';
      set({ loadError: msg });
    }
  },
  saveToolbar: async (toolbar) => {
    const body = await apiPut<PrefsResponse>('/api/me/preferences', { toolbar });
    set({ toolbar: body.toolbar ?? null });
  },
  resetLocal: () => set({ ...prefsInitial }),
}));

/**
 * Active-session sync (cross-device). Separate store from prefs because
 * the lifecycle differs — prefs are stable intent, activeSessionId is
 * ephemeral runtime state. Server stores it on user record (not under
 * preferences), exposed via `/api/me/active-session`.
 */
interface ActiveSessionState {
  sessionId: string | null;
  loaded: boolean;
}

interface ActiveSessionActions {
  load: () => Promise<void>;
  /** Set locally + PUT to server (best-effort; local wins on PUT failure). */
  setRemote: (sessionId: string | null) => Promise<void>;
  resetLocal: () => void;
}

interface ActiveSessionResponse {
  readonly sessionId: string | null;
}

const activeSessionInitial: ActiveSessionState = {
  sessionId: null,
  loaded: false,
};

export const useActiveSessionStore = create<ActiveSessionState & ActiveSessionActions>()(
  (set) => ({
    ...activeSessionInitial,
    load: async () => {
      try {
        const body = await api<ActiveSessionResponse>('/api/me/active-session');
        set({ sessionId: body.sessionId, loaded: true });
      } catch {
        // Silent on load — caller treats absent server answer same as null.
      }
    },
    setRemote: async (sessionId) => {
      set({ sessionId });
      try {
        await apiPut<ActiveSessionResponse>('/api/me/active-session', { sessionId });
      } catch {
        // Best effort — local store already reflects the user's intent;
        // next page load will reconcile via load() if the PUT failed.
      }
    },
    resetLocal: () => set({ ...activeSessionInitial }),
  }),
);

/** Tests only. */
export function resetPrefsStoresForTest(): void {
  usePrefsStore.setState({ ...prefsInitial });
  useActiveSessionStore.setState({ ...activeSessionInitial });
}
