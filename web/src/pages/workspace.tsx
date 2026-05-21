import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import {
  NewSessionDialog,
  type CreateRequest,
} from '../components/new-session-dialog.js';
import { FeedbackDialog } from '../components/feedback-dialog.js';
import { QuotaExhaustedDialog } from '../components/quota-exhausted-dialog.js';
import { QuotaPanel } from '../components/quota-panel.js';
import { ShareCreateDialog } from '../components/share-create-dialog.js';
import { WorkspaceMainPane } from '../components/workspace-main-pane.js';
import { WorkspaceSidebarContent } from '../components/workspace-sidebar-content.js';
import { logoutServer } from '../auth-flow.js';
import { useEffectiveTheme } from '../state/use-theme.js';
import { useBackgroundPoll } from '../state/use-background-poll.js';
import { useCompletionNotify } from '../state/use-completion-notify.js';
import { useWorkspaceRouting } from '../state/use-workspace-routing.js';
import { newIdempotencyKey } from '../api.js';
import { useAuthStore } from '../state/auth.js';
import { useActiveSessionStore } from '../state/prefs.js';
import { useProjectsStore } from '../state/projects.js';
import { useSessionsStore } from '../state/sessions.js';
import { useUiStore } from '../state/ui.js';

export function WorkspacePage(): JSX.Element {
  const { id } = useParams<{ id?: string }>();
  const navigate = useNavigate();

  const projects = useProjectsStore((s) => s.projects);
  const sessions = useSessionsStore((s) => s.sessions);
  const fetchProjects = useProjectsStore((s) => s.fetchProjects);
  const fetchSessions = useSessionsStore((s) => s.fetchSessions);
  const createSession = useSessionsStore((s) => s.createSession);
  const deleteSession = useSessionsStore((s) => s.deleteSession);
  const resumeSession = useSessionsStore((s) => s.resumeSession);
  const sessionsError = useSessionsStore((s) => s.error);
  const sessionsLoading = useSessionsStore((s) => s.loading);

  const loadActiveSession = useActiveSessionStore((s) => s.load);

  const label = useAuthStore((s) => s.label);
  const deviceId = useAuthStore((s) => s.deviceId);
  const userKind = useAuthStore((s) => s.kind);
  const clearSession = useAuthStore((s) => s.clearSession);

  // currentSessionId getter only — selectSession + remoteActive sync moved
  // into useWorkspaceRouting hook below.
  useUiStore((s) => s.currentSessionId);

  const [newDialogOpen, setNewDialogOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [quotaOpen, setQuotaOpen] = useState(false);
  const [quotaExhaustedReason, setQuotaExhaustedReason] = useState<string | null>(null);
  const [shareSessionId, setShareSessionId] = useState<string | null>(null);
  const idemKeyRef = useRef<string>('');

  useBackgroundPoll();
  useCompletionNotify(navigate);
  // URL ↔ store ↔ remote sync + stale URL recovery — see hook docstring.
  useWorkspaceRouting();

  useEffect(() => {
    void fetchProjects();
    void fetchSessions();
    void loadActiveSession();
  }, [fetchProjects, fetchSessions, loadActiveSession]);

  const onLogout = async (): Promise<void> => {
    // Clear the server-side cookie first; otherwise probeSession on the
    // login page still sees a valid session and bounces straight back to
    // /workspace, where RequireAuth (deviceId === null) bounces it to
    // /login again — infinite loop, blank screen.
    //
    // clearSession (not unpair): keep deviceId/label so the login page
    // can offer one-tap webauthn re-auth without forcing a fresh pair.
    await logoutServer();
    clearSession();
    navigate('/login', { replace: true });
  };

  const onOpenNew = (): void => {
    idemKeyRef.current = newIdempotencyKey();
    setNewDialogOpen(true);
  };

  const effectiveTheme = useEffectiveTheme();
  const onCreate = async (req: CreateRequest): Promise<void> => {
    const created = await createSession(
      { ...req, webTheme: effectiveTheme },
      idemKeyRef.current,
    );
    navigate(`/workspace/${created.id}`);
  };

  const onDelete = async (sid: string): Promise<void> => {
    try {
      await deleteSession(sid);
      if (id === sid) navigate('/workspace', { replace: true });
    } catch {
      // store records error; nothing to do here
    }
  };

  const onResumeRaw = async (sid: string): Promise<void> => {
    await resumeSession(sid, { webTheme: effectiveTheme });
  };

  const currentSession =
    id !== undefined ? sessions.find((s) => s.id === id) : undefined;
  const currentProject =
    currentSession !== undefined
      ? projects.find((p) => p.id === currentSession.projectId)
      : undefined;

  // The drawer wraps the workspace header + session list on mobile. On
  // desktop it stays open inline (CSS turns the transform into a no-op).
  // Auto-close after picking a session so the terminal isn't hidden by
  // the drawer the whole time.
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  useEffect(() => {
    closeDrawer();
  }, [id, closeDrawer]);

  return (
    <div
      data-workspace
      className="relative flex h-[100svh] w-full flex-row overflow-hidden bg-bg font-sans text-fg"
    >
      {/* Desktop: persistent sidebar (md+). */}
      <aside className="hidden min-h-0 w-80 shrink-0 flex-col border-r border-border bg-bg-elevated md:flex">
        <WorkspaceSidebarContent
          label={label}
          sessions={sessions}
          projects={projects}
          currentId={id}
          onLogout={() => void onLogout()}
          onNew={onOpenNew}
          onDelete={(sid) => void onDelete(sid)}
          onSettings={() => navigate('/settings')}
          onQuota={() => setQuotaOpen(true)}
          onFeedback={() => setFeedbackOpen(true)}
        />
      </aside>
      {/* Mobile: Sheet drawer (radix Dialog under the hood — focus trap,
       * Escape, aria-modal, animation free). safe-area-inset-left keeps
       * the content clear of iPhone landscape swipe bar. */}
      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent
          side="left"
          className="w-[min(85vw,360px)] border-r border-border bg-bg-elevated p-0 pl-[env(safe-area-inset-left)] md:hidden"
        >
          <WorkspaceSidebarContent
            label={label}
            sessions={sessions}
            projects={projects}
            currentId={id}
            onLogout={() => void onLogout()}
            onNew={onOpenNew}
            onDelete={(sid) => void onDelete(sid)}
            onSettings={() => navigate('/settings')}
            onQuota={() => setQuotaOpen(true)}
            onFeedback={() => setFeedbackOpen(true)}
          />
        </SheetContent>
      </Sheet>
      <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg">
        <section className="flex min-w-0 flex-1 flex-col">
          <WorkspaceMainPane
            id={id}
            currentSession={currentSession}
            currentProject={currentProject}
            sessionsLoading={sessionsLoading}
            sessionsError={sessionsError}
            deviceId={deviceId}
            label={label}
            projectCount={projects.length}
            activeSessionCount={sessions.filter((s) => s.deletedAt === null).length}
            onOpenDrawer={() => setDrawerOpen(true)}
            onOpenNew={onOpenNew}
            onDelete={onDelete}
            onResume={onResumeRaw}
            onOpenShare={(sid) => setShareSessionId(sid)}
            onQuotaExhausted={(reason) => setQuotaExhaustedReason(reason)}
          />
        </section>
      </main>
      <NewSessionDialog
        open={newDialogOpen}
        projects={projects}
        onClose={() => setNewDialogOpen(false)}
        onCreate={onCreate}
      />
      <FeedbackDialog
        open={feedbackOpen}
        onClose={() => setFeedbackOpen(false)}
      />
      <QuotaPanel open={quotaOpen} onClose={() => setQuotaOpen(false)} />
      <QuotaExhaustedDialog
        reason={quotaExhaustedReason}
        userKind={userKind}
        onClose={() => setQuotaExhaustedReason(null)}
        onOpenQuotaPanel={() => setQuotaOpen(true)}
      />
      <ShareCreateDialog
        open={shareSessionId !== null}
        sessionId={shareSessionId}
        projectName={
          shareSessionId === null
            ? ''
            : (projects.find(
                (p) =>
                  p.id ===
                  sessions.find((s) => s.id === shareSessionId)?.projectId,
              )?.name ??
              sessions.find((s) => s.id === shareSessionId)?.projectId ??
              '')
        }
        onClose={() => setShareSessionId(null)}
      />
    </div>
  );
}
