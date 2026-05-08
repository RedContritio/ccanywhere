import { useEffect, useState } from 'react';
import type { HistorySummary, Project } from '../state/sessions.js';
import { useSessionsStore } from '../state/sessions.js';

export interface CreateRequest {
  projectId: string;
  mode: 'fresh' | 'resume';
  sessionId?: string;
}

interface Props {
  readonly open: boolean;
  readonly projects: readonly Project[];
  readonly onClose: () => void;
  readonly onCreate: (req: CreateRequest) => Promise<void>;
}

export function NewSessionDialog({
  open,
  projects,
  onClose,
  onCreate,
}: Props): JSX.Element | null {
  const fetchHistory = useSessionsStore((s) => s.fetchHistory);
  const createProject = useSessionsStore((s) => s.createProject);
  const hideProject = useSessionsStore((s) => s.hideProject);

  const [projectId, setProjectId] = useState<string>(projects[0]?.id ?? '');
  const [mode, setMode] = useState<'fresh' | 'resume'>('fresh');
  const [history, setHistory] = useState<HistorySummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [resumeId, setResumeId] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Inline new-project form state.
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectBusy, setNewProjectBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setProjectId(projects[0]?.id ?? '');
      setMode('fresh');
      setHistory([]);
      setResumeId('');
      setSubmitting(false);
      setError(null);
      setNewProjectOpen(false);
      setNewProjectName('');
      setNewProjectBusy(false);
    }
  }, [open, projects]);

  // Keep projectId valid as the projects list mutates (create / hide).
  useEffect(() => {
    if (!open) return;
    if (projectId === '') {
      if (projects.length > 0) setProjectId(projects[0]!.id);
      return;
    }
    if (!projects.some((p) => p.id === projectId)) {
      setProjectId(projects[0]?.id ?? '');
    }
  }, [open, projects, projectId]);

  useEffect(() => {
    if (!open || mode !== 'resume' || projectId === '') return;
    let cancelled = false;
    setHistoryLoading(true);
    fetchHistory(projectId)
      .then((h) => {
        if (!cancelled) {
          setHistory(h);
          setResumeId(h[0]?.sessionId ?? '');
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '加载历史失败');
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, mode, projectId, fetchHistory]);

  if (!open) return null;

  const canSubmit =
    projectId.length > 0 &&
    !submitting &&
    (mode === 'fresh' || (mode === 'resume' && resumeId.length > 0));

  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const req: CreateRequest =
        mode === 'fresh' ? { projectId, mode } : { projectId, mode, sessionId: resumeId };
      await onCreate(req);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败');
    } finally {
      setSubmitting(false);
    }
  };

  const submitNewProject = async (): Promise<void> => {
    const name = newProjectName.trim();
    if (name.length === 0) return;
    setNewProjectBusy(true);
    setError(null);
    try {
      const created = await createProject(name);
      setProjectId(created.id);
      setNewProjectOpen(false);
      setNewProjectName('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建项目失败');
    } finally {
      setNewProjectBusy(false);
    }
  };

  const onHideClick = async (): Promise<void> => {
    if (projectId === '') return;
    const confirmed = window.confirm(
      `隐藏项目 "${projectId}"？目录会保留在磁盘上；恢复时可在 ~/.config/ccanywhere/projects-state.json 里手动删除该 id。`,
    );
    if (!confirmed) return;
    setError(null);
    try {
      await hideProject(projectId);
    } catch (err) {
      setError(err instanceof Error ? err.message : '隐藏项目失败');
    }
  };

  return (
    <div className="dialog-backdrop" onClick={onClose} role="presentation">
      <div
        className="dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-session-title"
      >
        <h2 id="new-session-title" className="dialog-title">
          新建会话
        </h2>

        <label className="dialog-field">
          <span>项目</span>
          {projects.length > 0 ? (
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          ) : (
            <p className="dialog-hint">
              还没有项目。点击"+ 新建项目"，或在你 mac 的 Projects/ 下手动 mkdir 一个子目录。
            </p>
          )}
        </label>

        <div className="dialog-project-actions">
          {newProjectOpen ? (
            <div className="dialog-new-project">
              <input
                type="text"
                placeholder="目录名（直接落在 Projects/ 下）"
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                disabled={newProjectBusy}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submitNewProject();
                  if (e.key === 'Escape') {
                    setNewProjectOpen(false);
                    setNewProjectName('');
                  }
                }}
              />
              <button
                type="button"
                className="dialog-link"
                onClick={() => void submitNewProject()}
                disabled={newProjectBusy || newProjectName.trim() === ''}
              >
                {newProjectBusy ? '创建中…' : '创建'}
              </button>
              <button
                type="button"
                className="dialog-link"
                onClick={() => {
                  setNewProjectOpen(false);
                  setNewProjectName('');
                }}
                disabled={newProjectBusy}
              >
                取消
              </button>
            </div>
          ) : (
            <>
              <button
                type="button"
                className="dialog-link"
                onClick={() => setNewProjectOpen(true)}
              >
                + 新建项目
              </button>
              {projectId.length > 0 && projects.length > 0 && (
                <button
                  type="button"
                  className="dialog-link is-danger"
                  onClick={() => void onHideClick()}
                >
                  隐藏选中
                </button>
              )}
            </>
          )}
        </div>

        <fieldset className="dialog-mode">
          <legend>模式</legend>
          <label>
            <input
              type="radio"
              name="mode"
              value="fresh"
              checked={mode === 'fresh'}
              onChange={() => setMode('fresh')}
            />
            <span>全新会话</span>
          </label>
          <label>
            <input
              type="radio"
              name="mode"
              value="resume"
              checked={mode === 'resume'}
              onChange={() => setMode('resume')}
            />
            <span>从历史接续</span>
          </label>
        </fieldset>

        {mode === 'resume' && (
          <label className="dialog-field">
            <span>历史会话</span>
            {historyLoading ? (
              <p className="dialog-hint">加载历史中...</p>
            ) : history.length === 0 ? (
              <p className="dialog-hint">该项目还没有可接续的历史会话。</p>
            ) : (
              <select value={resumeId} onChange={(e) => setResumeId(e.target.value)}>
                {history.map((h) => (
                  <option key={h.sessionId} value={h.sessionId}>
                    {h.preview.length > 0 ? h.preview.slice(0, 60) : '(无预览)'} —{' '}
                    {new Date(h.modifiedAt).toLocaleString()}
                  </option>
                ))}
              </select>
            )}
          </label>
        )}

        {error !== null && (
          <p className="dialog-error" role="alert">
            {error}
          </p>
        )}

        <div className="dialog-actions">
          <button type="button" className="dialog-cancel" onClick={onClose} disabled={submitting}>
            取消
          </button>
          <button
            type="button"
            className="dialog-submit"
            onClick={() => void submit()}
            disabled={!canSubmit}
          >
            {submitting ? '创建中...' : '创建'}
          </button>
        </div>
      </div>
    </div>
  );
}
