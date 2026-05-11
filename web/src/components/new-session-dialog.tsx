import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  useProjectsStore,
  type HistorySummary,
  type Project,
} from '../state/projects.js';
import { DialogBase } from './dialog-base.js';
import { ListBase } from './list-base.js';
import { SortButton } from './sort-button.js';

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
}: Props): JSX.Element {
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
  // 'asc' is the user-intuitive default per field:
  //   modified asc = most-recently-modified first
  //   name     asc = a → z
  const [sortField, setSortField] = useState<ProjectSortField>('modified');
  const [sortDir, setSortDir] = useState<ProjectSortDir>('asc');

  const [projectAction, setProjectAction] = useState<ProjectAction>('idle');
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectBusy, setNewProjectBusy] = useState(false);

  // Fix `now` per dialog open so relative-time strings don't drift mid-render.
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
        if (!cancelled)
          setError(err instanceof Error ? err.message : '加载历史失败');
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
    <DialogBase
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
      title={stepTitle}
      size="lg"
      footer={
        <>
          {step === 2 ? (
            <Button
              type="button"
              variant="secondary"
              onClick={() => setStep(1)}
              disabled={submitting}
            >
              上一步
            </Button>
          ) : (
            <Button
              type="button"
              variant="secondary"
              onClick={onClose}
              disabled={submitting}
            >
              取消
            </Button>
          )}
          <Button
            type="submit"
            form="new-session-form"
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
          </Button>
        </>
      }
    >
      <form
        id="new-session-form"
        onSubmit={onPrimary}
        className="space-y-4"
      >
        {step === 1 && (
          <>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>项目</Label>
                <div
                  className="inline-flex gap-1 text-xs"
                  role="group"
                  aria-label="排序"
                >
                  <SortButton
                    active={sortField === 'modified'}
                    dir={sortField === 'modified' ? sortDir : null}
                    onClick={() => toggleSort('modified')}
                  >
                    时间
                  </SortButton>
                  <SortButton
                    active={sortField === 'name'}
                    dir={sortField === 'name' ? sortDir : null}
                    onClick={() => toggleSort('name')}
                  >
                    名称
                  </SortButton>
                </div>
              </div>
              {sortedProjects.length > 0 ? (
                <ListBase
                  items={sortedProjects}
                  selectedKey={projectId}
                  getKey={(p) => p.id}
                  renderPrimary={(p) => p.name}
                  renderSecondary={(p) =>
                    fmtRelative(p.modifiedAt, nowRef.current)
                  }
                  onSelect={setProjectId}
                  ariaLabel="项目"
                />
              ) : (
                <p className="text-xs text-fg-muted">
                  还没有项目。点击「+ 新建项目」，或在 mac 的 Projects/ 下
                  手动 mkdir。
                </p>
              )}
            </div>

            {projectAction === 'new' ? (
              <div className="flex items-center gap-2">
                <Input
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
                  className="flex-1"
                />
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  onClick={() => void submitNewProject()}
                  disabled={newProjectBusy || newProjectName.trim() === ''}
                >
                  {newProjectBusy ? '创建中…' : '创建'}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setProjectAction('idle');
                    setNewProjectName('');
                  }}
                  disabled={newProjectBusy}
                >
                  取消
                </Button>
              </div>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setProjectAction('new')}
              >
                + 新建项目
              </Button>
            )}

            <div className="space-y-2">
              <Label>模式</Label>
              <Tabs
                value={mode}
                onValueChange={(v) => setMode(v as 'create' | 'resume')}
              >
                <TabsList>
                  <TabsTrigger value="create">全新会话</TabsTrigger>
                  <TabsTrigger value="resume">从历史接续</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
          </>
        )}

        {step === 2 && (
          <div className="space-y-2">
            <Label>选择要接续的会话</Label>
            {historyLoading ? (
              <p className="text-xs text-fg-muted">加载历史中...</p>
            ) : (
              <ListBase
                items={history}
                selectedKey={resumeId}
                getKey={(h) => h.sessionId}
                renderPrimary={(h) =>
                  h.preview.length > 0 ? h.preview.slice(0, 80) : '(无预览)'
                }
                renderSecondary={(h) =>
                  fmtRelative(h.modifiedAt, nowRef.current)
                }
                onSelect={setResumeId}
                ariaLabel="历史会话"
                emptyLabel="该项目还没有可接续的历史会话"
              />
            )}
          </div>
        )}

        {error !== null && (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        )}
      </form>
    </DialogBase>
  );
}

