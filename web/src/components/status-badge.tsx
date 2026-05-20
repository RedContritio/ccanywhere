import type { SessionState } from '@/state/sessions';
import { cn } from '@/lib/utils';

/**
 * SessionState 4 状态显式映射。所有显示 session state 的地方必须用
 * 这个组件 — grep 不应有任何其它处硬编码 `state === 'busy'` 来选颜色
 * (per F7)。
 *
 * 两种 variant：
 *  - `text` (default)：mono 文字 (idle / busy / dead / starting)，
 *    用在 session-list 行内（紧凑数据视图，需明确字面状态）
 *  - `dot`：彩色圆点，用在 terminal header（紧贴 project 名，sans 一
 *    行，避免 mono/sans 视觉混排冲突）
 *
 * 颜色映射（两种 variant 共享）：
 *  - starting → brand (蓝紫，准备中)
 *  - idle     → fg-muted (静默)
 *  - busy     → warning (琥珀，运行中)
 *  - dead     → danger (红，已死)
 */
const stateLabel: Record<SessionState, string> = {
  starting: 'starting',
  idle: 'idle',
  busy: 'busy',
  dead: 'dead',
};

//  (B27): mobile users (often limited e2e users
// not familiar with shell jargon) get the Chinese variant; desktop keeps
// the mono `idle / busy / ...` for power users / tighter info density.
const stateLabelZh: Record<SessionState, string> = {
  starting: '启动中',
  idle: '空闲',
  busy: '忙',
  dead: '已结束',
};

const stateTextColor: Record<SessionState, string> = {
  starting: 'text-brand',
  idle: 'text-fg-muted',
  busy: 'text-warning',
  dead: 'text-danger',
};

const stateBg: Record<SessionState, string> = {
  starting: 'bg-brand',
  idle: 'bg-fg-muted',
  busy: 'bg-warning',
  dead: 'bg-danger',
};

export interface StatusBadgeProps {
  readonly state: SessionState;
  readonly variant?: 'text' | 'dot';
  readonly className?: string;
}

export function StatusBadge({
  state,
  variant = 'text',
  className,
}: StatusBadgeProps): JSX.Element {
  if (variant === 'dot') {
    return (
      <span
        className={cn('inline-block h-2 w-2 rounded-full', stateBg[state], className)}
        role="status"
        aria-label={`state: ${state}`}
        title={stateLabel[state]}
      />
    );
  }
  return (
    <span
      className={cn('text-xs leading-none', stateTextColor[state], className)}
      aria-label={`state: ${state}`}
    >
      <span className="hidden font-mono md:inline">{stateLabel[state]}</span>
      <span className="md:hidden">{stateLabelZh[state]}</span>
    </span>
  );
}
