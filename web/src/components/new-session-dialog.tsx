import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  useProjectsStore,
  type HistorySummary,
  type Project,
} from '../state/projects.js';
import { SelectableList } from './selectable-list.js';

export interface CreateRequest {
  projectId: string;
  mode: 'create' | 'resume';
  sessionId?: string;
}

interface Props {
  readonly open: boolean;
  readonly projects: readonly Project[];
  readonly onClose: () => void;
  readonly onCreate: (req: CreateRequest) => Promise<void>;
}

type ProjectSortField = 'modified' | 'name';
type ProjectSortDir = 'asc' | 'desc';
type ProjectAction = 'idle' | 'new';
type Step = 1 | 2;

function fmtRelative(epochMs: number, now: number): string {
  const sec = Math.max(0, Math.round((now - epochMs) / 1000));
  if (sec < 60) return '刚刚';
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`;
  if (sec < 86_400) return `${Math.floor(sec / 3600)} 小时前`;
  if (sec < 86_400 * 7) return `${Math.floor(sec / 86_400)} 天前`;
  return new Date(epochMs).toISOString().slice(0, 10);
}

export function NewSessionDialog({
  open,
  projects,
  onClose,
  onCreate,
}: Props): JSX.Element | null {
  const fetchHistory = useProjectsStore((s) => s.fetchHistory);
  const createProject = useProjectsStore((s) => s.createProject);

  const [step, setStep] = useState<Step>(1);
  const [projectId, setProjectId] = useState<string>('');
  const [mode, setMode] = useState<'create' | 'resume'>('create');
  const [history, setHistory] = useState<HistorySummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [resumeId, setResumeId] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Default sort: most-recently-modified first; click same field to flip dir,
  // click the other field to switch + reset dir to asc.
  const [sortField, setSortField] = useState<ProjectSortField>('modified');
  const [sortDir, setSortDir] = useState<ProjectSortDir>('asc');

  const [projectAction, setProjectAction] = useState<ProjectAction>('idle');
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectBusy, setNewProjectBusy] = useState(false);

  // Fix `now` per dialog open so the relative-time strings don't drift
  // mid-render. Reset on every open.
  const nowRef = useRef<number>(Date.now());

  useEffect(() => {
    if (open) {
      nowRef.current = Date.now();
      setStep(1);
      setProjectId('');
      setMode('create');
      setHistory([]);
      setResumeId('');
      setSubmitting(false);
      setError(null);
      setProjectAction('idle');
      setNewProjectName('');
      setNewProjectBusy(false);
    }
  }, [open]);

  // If the previously-selected project disappears (was hidden / removed),
  // clear the selection — don't silently switch to a different project.
  useEffect(() => {
    if (!open) return;
    if (projectId === '') return;
    if (!projects.some((p) => p.id === projectId)) {
      setProjectId('');
    }
  }, [open, projects, projectId]);

  // Load history when entering step 2.
  useEffect(() => {
    if (!open || step !== 2 || projectId === '') return;
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
  }, [open, step, projectId, fetchHistory]);

  const sortedProjects = useMemo(() => {
    const copy = [...projects];
    // 'asc' is the user-intuitive default for each field:
    //   modified asc = most-recently-modified first
    //   name     asc = a → z
    // 'desc' flips both. Implementation note: we sort once per field, then
    // reverse for desc — keeps the comparator definitions trivially correct.
    if (sortField === 'name') {
      copy.sort((a, b) => a.id.localeCompare(b.id));
    } else {
      copy.sort((a, b) => b.modifiedAt - a.modifiedAt);
    }
    if (sortDir === 'desc') copy.reverse();
    return copy;
  }, [projects, sortField, sortDir]);

  const toggleSort = (field: ProjectSortField): void => {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  };

  if (!open) return null;

  const canAdvanceFromStep1 =
    projectId.length > 0 && !submitting && projectAction === 'idle';

  const submitCreate = async (): Promise<void> => {
    if (!canAdvanceFromStep1) return;
    setSubmitting(true);
    setError(null);
    try {
      await onCreate({ projectId, mode: 'create' });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败');
    } finally {
      setSubmitting(false);
    }
  };

  const submitResume = async (): Promise<void> => {
    if (resumeId.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      await onCreate({ projectId, mode: 'resume', sessionId: resumeId });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败');
    } finally {
      setSubmitting(false);
    }
  };

  const onPrimary = (e: FormEvent): void => {
    e.preventDefault();
    if (step === 1) {
      if (mode === 'create') void submitCreate();
      else setStep(2);
    } else {
      void submitResume();
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
      setProjectAction('idle');
      setNewProjectName('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建项目失败');
    } finally {
      setNewProjectBusy(false);
    }
  };

  const stepTitle =
    step === 2
      ? '选择历史会话 · 2/2'
      : mode === 'resume'
        ? '新建会话 · 1/2'
        : '新建会话';

  return (
    <div className="dialog-backdrop" onClick={onClose} role="presentation">
      <form
        className="dialog"
        onClick={(e) => e.stopPropagation()}
        onSubmit={onPrimary}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-session-title"
      >
        <h2 id="new-session-title" className="dialog-title">
          {stepTitle}
        </h2>

        {step === 1 && (
          <>
            <div className="dialog-field">
              <div className="dialog-field-row">
                <span>项目</span>
                <div className="dialog-sort-toggle" role="group" aria-label="排序">
                  <button
                    type="button"
                    className={`dialog-sort-btn ${sortField === 'modified' ? 'is-active' : ''}`}
                    onClick={() => toggleSort('modified')}
                    title={
                      sortField === 'modified'
                        ? sortDir === 'asc'
                          ? '最近修改优先（点击切换为最久优先）'
                          : '最久修改优先（点击切换为最近优先）'
                        : '按修改时间排序'
                    }
                  >
                    时间
                    {sortField === 'modified' && (
                      <span className="dialog-sort-arrow" aria-hidden="true">
                        {sortDir === 'asc' ? ' ↓' : ' ↑'}
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    className={`dialog-sort-btn ${sortField === 'name' ? 'is-active' : ''}`}
                    onClick={() => toggleSort('name')}
                    title={
                      sortField === 'name'
                        ? sortDir === 'asc'
                          ? 'A→Z（点击切换为 Z→A）'
                          : 'Z→A（点击切换为 A→Z）'
                        : '按名称排序'
                    }
                  >
                    名称
                    {sortField === 'name' && (
                      <span className="dialog-sort-arrow" aria-hidden="true">
                        {sortDir === 'asc' ? ' ↓' : ' ↑'}
                      </span>
                    )}
                  </button>
                </div>
              </div>
              {sortedProjects.length > 0 ? (
                <SelectableList
                  items={sortedProjects}
                  selectedId={projectId}
                  getId={(p) => p.id}
                  renderPrimary={(p) => p.name}
                  renderSecondary={(p) => fmtRelative(p.modifiedAt, nowRef.current)}
                  onSelect={setProjectId}
                  ariaLabel="项目"
                />
              ) : (
                <p className="dialog-hint">
                  还没有项目。点击"+ 新建项目"，或在 mac 的 Projects/ 下手动 mkdir。
                </p>
              )}
            </div>

            <div className="dialog-project-actions">
              {projectAction === 'new' && (
                <div className="dialog-new-project">
                  <input
                    type="text"
                    placeholder="目录名（直接落在 Projects/ 下）"
                    value={newProjectName}
                    onChange={(e) => setNewProjectName(e.target.value)}
                    disabled={newProjectBusy}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        void submitNewProject();
                      }
                      if (e.key === 'Escape') {
                        e.preventDefault();
                        setProjectAction('idle');
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
                      setProjectAction('idle');
                      setNewProjectName('');
                    }}
                    disabled={newProjectBusy}
                  >
                    取消
                  </button>
                </div>
              )}
              {projectAction === 'idle' && (
                <button
                  type="button"
                  className="dialog-link"
                  onClick={() => setProjectAction('new')}
                >
                  + 新建项目
                </button>
              )}
            </div>

            <fieldset className="dialog-mode">
              <legend>模式</legend>
              <label>
                <input
                  type="radio"
                  name="mode"
                  value="create"
                  checked={mode === 'create'}
                  onChange={() => setMode('create')}
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
          </>
        )}

        {step === 2 && (
          <div className="dialog-field">
            <span>选择要接续的会话</span>
            {historyLoading ? (
              <p className="dialog-hint">加载历史中...</p>
            ) : history.length === 0 ? (
              <p className="dialog-hint">该项目还没有可接续的历史会话。</p>
            ) : (
              <SelectableList
                items={history}
                selectedId={resumeId}
                getId={(h) => h.sessionId}
                renderPrimary={(h) =>
                  h.preview.length > 0 ? h.preview.slice(0, 80) : '(无预览)'
                }
                renderSecondary={(h) => fmtRelative(h.modifiedAt, nowRef.current)}
                onSelect={setResumeId}
                ariaLabel="历史会话"
              />
            )}
          </div>
        )}

        {error !== null && (
          <p className="dialog-error" role="alert">
            {error}
          </p>
        )}

        <div className="dialog-actions">
          {step === 2 ? (
            <button
              type="button"
              className="dialog-cancel"
              onClick={() => setStep(1)}
              disabled={submitting}
            >
              上一步
            </button>
          ) : (
            <button
              type="button"
              className="dialog-cancel"
              onClick={onClose}
              disabled={submitting}
            >
              取消
            </button>
          )}
          <button
            type="submit"
            className="dialog-submit"
            disabled={
              step === 1
                ? !canAdvanceFromStep1
                : submitting || resumeId.length === 0
            }
          >
            {step === 1
              ? mode === 'create'
                ? submitting
                  ? '创建中...'
                  : '创建'
                : '下一步'
              : submitting
                ? '创建中...'
                : '创建'}
          </button>
        </div>
      </form>
    </div>
  );
}
