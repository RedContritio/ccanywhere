import { useEffect } from 'react';
import { useSessionsStore } from './sessions.js';

const POLL_MS = 5_000;

/**
 * When the tab is hidden, poll /api/sessions every 5 seconds so the
 * non-selected sessions' state changes (busy → idle in particular)
 * are visible to the foreground UI / notification logic. When the tab
 * is visible, polling stops — the user can see the list directly and
 * the active session is already on a WebSocket.
 */
export function useBackgroundPoll(): void {
  const fetchSessions = useSessionsStore((s) => s.fetchSessions);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    const start = (): void => {
      if (timer !== null) return;
      timer = setInterval(() => {
        void fetchSessions();
      }, POLL_MS);
    };
    const stop = (): void => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };

    const onVisibility = (): void => {
      if (document.hidden) start();
      else stop();
    };

    if (document.hidden) start();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [fetchSessions]);
}
