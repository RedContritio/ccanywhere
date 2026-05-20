import { NotificationBanner } from './notification-banner.js';
import { SessionList } from './session-list.js';
import { SidebarGlobalActions } from './workspace-header-actions.js';
import { WorkspaceSidebarHeader } from './workspace-sidebar-header.js';
import type { Project } from '../state/projects.js';
import type { Session } from '../state/sessions.js';

interface Props {
  readonly label: string | null;
  readonly sessions: readonly Session[];
  readonly projects: readonly Project[];
  readonly currentId: string | undefined;
  readonly onLogout: () => void;
  readonly onNew: () => void;
  readonly onDelete: (sid: string) => void;
  readonly onSettings: () => void;
  readonly onQuota: () => void;
  readonly onFeedback: () => void;
}

/**
 * Sidebar interior — header (CC anywhere title + label + theme + logout) +
 * notification banner + session list + global actions footer. Extracted
 * so the same content can mount inside the persistent desktop `<aside>`
 * AND the mobile `<Sheet>` drawer without duplication
 *  */
export function WorkspaceSidebarContent({
  label,
  sessions,
  projects,
  currentId,
  onLogout,
  onNew,
  onDelete,
  onSettings,
  onQuota,
  onFeedback,
}: Props): JSX.Element {
  return (
    <>
      <WorkspaceSidebarHeader label={label} onLogout={onLogout} />
      <NotificationBanner />
      <SessionList
        sessions={sessions}
        projects={projects}
        currentId={currentId}
        onNew={onNew}
        onDelete={onDelete}
      />
      <SidebarGlobalActions
        onSettings={onSettings}
        onQuota={onQuota}
        onFeedback={onFeedback}
      />
    </>
  );
}
