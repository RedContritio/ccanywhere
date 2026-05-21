import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useActiveSessionStore } from './prefs.js';
import { useSessionsStore } from './sessions.js';
import { useUiStore } from './ui.js';

const STALE_REDIRECT_MS = 5000;

/**
 * URL ↔ store ↔ remote active-session three-way sync + stale-URL recovery
 * extracted from workspace.tsx.
 *
 * Behavior:
 * - URL has :id → mirror to useUiStore.currentSessionId AND PUT to
 * /api/me/active-session (via useActiveSessionStore.setRemote) so
 * other devices see the same pick on next probe
 * - URL has no :id → pick candidate (priority: currentSessionId >
 * remoteActiveSessionId, gated on remoteActiveLoaded so first paint
 * doesn't bounce away). Only honored if a live (non-deletedAt)
 * session matches
 * - URL has :id but session not found (and !loading && !error) → 5s
 * setTimeout navigate('/workspace'); cancel if session appears mid-wait
 *
 * Used once by WorkspacePage. Reads/writes via zustand selectors so the
 * caller doesn't need to pre-thread any state through.
 */
export function useWorkspaceRouting(): void {
  const { id } = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const sessions = useSessionsStore((s) => s.sessions);
  const sessionsError = useSessionsStore((s) => s.error);
  const sessionsLoading = useSessionsStore((s) => s.loading);
  const currentSessionId = useUiStore((s) => s.currentSessionId);
  const selectSession = useUiStore((s) => s.selectSession);
  const remoteActiveSessionId = useActiveSessionStore((s) => s.sessionId);
  const remoteActiveLoaded = useActiveSessionStore((s) => s.loaded);
  const setRemoteActiveSession = useActiveSessionStore((s) => s.setRemote);

  // URL → store, plus cross-device sync.
  useEffect(() => {
    if (id !== undefined) {
      if (currentSessionId !== id) selectSession(id);
      if (remoteActiveSessionId !== id) {
        void setRemoteActiveSession(id);
      }
      return;
    }
    const candidate =
      (currentSessionId !== null && currentSessionId) ||
      (remoteActiveLoaded ? remoteActiveSessionId : null);
    if (
      candidate !== null &&
      sessions.some((s) => s.id === candidate && s.deletedAt === null)
    ) {
      navigate(`/workspace/${candidate}`, { replace: true });
    }
  }, [
    id,
    currentSessionId,
    remoteActiveSessionId,
    remoteActiveLoaded,
    sessions,
    selectSession,
    setRemoteActiveSession,
    navigate,
  ]);

  // Stale URL recovery: /workspace/<id> with no matching live session
  // bounces back to /workspace after 5s (recycled by GC, deleted in
  // another tab, never existed). !loading + !error guards a still-
  // resolving fetch — cleanup cancels the redirect if the session
  // appears mid-wait.
  const currentSession =
    id !== undefined ? sessions.find((s) => s.id === id) : undefined;
  useEffect(() => {
    if (id === undefined) return;
    if (currentSession !== undefined) return;
    if (sessionsLoading) return;
    if (sessionsError !== null) return;
    const t = setTimeout(
      () => navigate('/workspace', { replace: true }),
      STALE_REDIRECT_MS,
    );
    return () => clearTimeout(t);
  }, [id, currentSession, sessionsLoading, sessionsError, navigate]);
}
