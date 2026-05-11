import { create } from 'zustand';
import { api } from '../api.js';
import { recordOp } from './ops-log.js';

export interface Project {
  id: string;
  name: string;
  cwd: string;
  /** epoch-ms; directory mtime on the server side. */
  modifiedAt: number;
}

export interface HistorySummary {
  sessionId: string;
  modifiedAt: number;
  preview: string;
}

interface ProjectsStore {
  projects: Project[];
  loading: boolean;
  error: string | null;
  fetchProjects: () => Promise<void>;
  fetchHistory: (projectId: string) => Promise<HistorySummary[]>;
  /** Create a new project subdir under the server's projectsRoot. */
  createProject: (name: string) => Promise<Project>;
  /** Hide a project (server-side soft-delete; directory remains on disk). */
  hideProject: (id: string) => Promise<void>;
}

const initial = {
  projects: [] as Project[],
  loading: false,
  error: null as string | null,
};

export const useProjectsStore = create<ProjectsStore>((set) => ({
  ...initial,
  fetchProjects: async () => {
    set({ loading: true, error: null });
    try {
      const { projects } = await api<{ projects: Project[] }>('/api/projects');
      set({ projects, loading: false });
    } catch (err) {
      set({ error: (err as Error).message, loading: false });
    }
  },
  fetchHistory: async (projectId) => {
    const { history } = await api<{ history: HistorySummary[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/history`,
    );
    return history;
  },
  createProject: async (name) => {
    const created = await api<Project>('/api/projects', {
      method: 'POST',
      body: { name },
    });
    recordOp('project.create', { id: created.id });
    set((s) => ({
      projects: s.projects.some((p) => p.id === created.id)
        ? s.projects
        : [...s.projects, created].sort((a, b) => a.id.localeCompare(b.id)),
    }));
    return created;
  },
  hideProject: async (id) => {
    await api<void>(`/api/projects/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    recordOp('project.hide', { id });
    set((s) => ({ projects: s.projects.filter((p) => p.id !== id) }));
  },
}));

/** Tests only. */
export function resetProjectsStoreForTest(): void {
  useProjectsStore.setState({ ...initial });
}
