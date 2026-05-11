import type { SessionState } from '@/state/sessions';
import { cn } from '@/lib/utils';

/**
 * SessionState 4 状态显式映射。所有显示 session state 的地方必须用
 * 这个组件 — grep 不应有任何其它处硬编码 `state === 'busy'` 来选颜色
 * (per F7)。
 *
 * 视觉 (per DP7)：纯 monospace 文字，颜色由 fg 表达。无背景 pill /
 * 圆点 / 方括号。颜色映射：
 *  - starting → text-brand (蓝紫，准备中)
 *  - idle     → text-fg-muted (静默)
 *  - busy     → text-warning (琥珀，运行中)
 *  - dead     → text-danger (红，已死)
 */
const stateLabel: Record<SessionState, string> = {
  starting: 'starting',
  idle: 'idle',
  busy: 'busy',
  dead: 'dead',
};

const stateColor: Record<SessionState, string> = {
  starting: 'text-brand',
  idle: 'text-fg-muted',
  busy: 'text-warning',
  dead: 'text-danger',
};

export interface StatusBadgeProps {
  readonly state: SessionState;
  readonly className?: string;
}

export function StatusBadge({
  state,
  className,
}: StatusBadgeProps): JSX.Element {
  return (
    <span
      className={cn(
        'font-mono text-xs leading-none',
        stateColor[state],
        className,
      )}
      aria-label={`state: ${state}`}
    >
      {stateLabel[state]}
    </span>
  );
}
