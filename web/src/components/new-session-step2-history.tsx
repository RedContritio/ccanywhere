import { Label } from '@/components/ui/label';
import type { HistorySummary } from '../state/projects.js';
import { ListBase } from './list-base.js';

interface Props {
  readonly history: readonly HistorySummary[];
  readonly resumeId: string;
  readonly historyLoading: boolean;
  readonly renderSecondary: (h: HistorySummary) => string;
  readonly onSelectResumeId: (id: string) => void;
}

/**
 * Step 2 of NewSessionDialog: history-session picker for resume mode.
 * Pure controlled component — history fetch + resumeId state live in
 * NewSessionDialog.
 */
export function Step2HistoryPicker({
  history,
  resumeId,
  historyLoading,
  renderSecondary,
  onSelectResumeId,
}: Props): JSX.Element {
  return (
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
          renderSecondary={renderSecondary}
          onSelect={onSelectResumeId}
          ariaLabel="历史会话"
          emptyLabel="该项目还没有可接续的历史会话"
        />
      )}
    </div>
  );
}
