import { useEffect, useRef } from 'react';
import type { NavigateFunction } from 'react-router-dom';
import { useSessionsStore, type SessionState } from './sessions.js';
import { useUiStore } from './ui.js';

/**
 * Watch sessions for busy → idle transitions on non-selected sessions
 * while the tab is hidden, and pop a desktop notification. Click brings
 * the tab to the front and routes to the session.
 */
export function useCompletionNotify(navigate: NavigateFunction): void {
  const sessions = useSessionsStore((s) => s.sessions);
  const projects = useSessionsStore((s) => s.projects);
  const currentId = useUiStore((s) => s.currentSessionId);
  const prevStates = useRef<Map<string, SessionState>>(new Map());

  useEffect(() => {
    const supportsNotif = typeof Notification !== 'undefined';

    if (!supportsNotif || Notification.permission !== 'granted') {
      // Still record current states so we don't fire a false "first
      // transition" right after the user grants permission.
      prevStates.current = new Map(sessions.map((s) => [s.id, s.state]));
      return;
    }

    for (const s of sessions) {
      const prev = prevStates.current.get(s.id);
      const becameIdle = prev === 'busy' && s.state === 'idle';
      const notSelected = s.id !== currentId;
      const inBackground = document.hidden;

      if (becameIdle && notSelected && inBackground) {
        const proj = projects.find((p) => p.id === s.projectId);
        const body = `${proj?.name ?? s.projectId} 的对话已就绪`;
        const n = new Notification('cc 完成响应', {
          body,
          tag: `ccanywhere-${s.id}`,
        });
        n.onclick = (): void => {
          window.focus();
          navigate(`/workspace/${s.id}`);
          n.close();
        };
      }
      prevStates.current.set(s.id, s.state);
    }

    // Drop tracked entries for sessions that no longer exist
    for (const id of Array.from(prevStates.current.keys())) {
      if (!sessions.some((s) => s.id === id)) prevStates.current.delete(id);
    }
  }, [sessions, projects, currentId, navigate]);
}
