import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { Project } from '../state/projects.js';
import { ListBase } from './list-base.js';
import { SortButton } from './sort-button.js';

export type ProjectSortField = 'modified' | 'name';
export type ProjectSortDir = 'asc' | 'desc';
export type ProjectAction = 'idle' | 'new';

interface Props {
  readonly sortedProjects: readonly Project[];
  readonly projectId: string;
  readonly projectAction: ProjectAction;
  readonly sortField: ProjectSortField;
  readonly sortDir: ProjectSortDir;
  readonly mode: 'create' | 'resume';
  readonly newProjectName: string;
  readonly newProjectBusy: boolean;
  /** "modified" → fmtRelative timestamp string for secondary line. */
  readonly renderSecondary: (p: Project) => string;
  readonly onSelectProject: (id: string) => void;
  readonly onToggleSort: (field: ProjectSortField) => void;
  readonly onProjectAction: (action: ProjectAction) => void;
  readonly onSetNewProjectName: (name: string) => void;
  readonly onSubmitNewProject: () => void;
  readonly onCancelNewProject: () => void;
  readonly onModeChange: (mode: 'create' | 'resume') => void;
}

/**
 * Step 1 of NewSessionDialog: project picker + sort + inline new-project
 * form + create/resume mode tabs. Pure controlled component — all state
 * lives in NewSessionDialog (m-new-session-dialog-steps).
 */
export function Step1ProjectPicker({
  sortedProjects,
  projectId,
  projectAction,
  sortField,
  sortDir,
  mode,
  newProjectName,
  newProjectBusy,
  renderSecondary,
  onSelectProject,
  onToggleSort,
  onProjectAction,
  onSetNewProjectName,
  onSubmitNewProject,
  onCancelNewProject,
  onModeChange,
}: Props): JSX.Element {
  return (
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
              onClick={() => onToggleSort('modified')}
            >
              时间
            </SortButton>
            <SortButton
              active={sortField === 'name'}
              dir={sortField === 'name' ? sortDir : null}
              onClick={() => onToggleSort('name')}
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
            renderSecondary={renderSecondary}
            onSelect={onSelectProject}
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
            onChange={(e) => onSetNewProjectName(e.target.value)}
            disabled={newProjectBusy}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                onSubmitNewProject();
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                onCancelNewProject();
              }
            }}
            className="flex-1"
          />
          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={onSubmitNewProject}
            disabled={newProjectBusy || newProjectName.trim() === ''}
          >
            {newProjectBusy ? '创建中…' : '创建'}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onCancelNewProject}
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
          onClick={() => onProjectAction('new')}
        >
          + 新建项目
        </Button>
      )}

      <div className="space-y-2">
        <Label>模式</Label>
        <Tabs
          value={mode}
          onValueChange={(v) => onModeChange(v as 'create' | 'resume')}
        >
          <TabsList>
            <TabsTrigger value="create">全新会话</TabsTrigger>
            <TabsTrigger value="resume">从历史接续</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
    </>
  );
}
