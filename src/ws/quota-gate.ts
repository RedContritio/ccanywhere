import type { Session } from '../session/manager.js';
import type { UserStore } from '../users/store.js';

export interface QuotaGateResult {
  readonly blocked: boolean;
  readonly reason?: string;
}

/**
 * Auto-emitted xterm escape sequences that DO NOT count as user input
 * for quota purposes. cc enables focus tracking via `CSI ?1004 h`;
 * xterm then pushes `\x1b[I` (focus in) / `\x1b[O` (focus out) into
 * the PTY whenever the window/terminal focus changes — even when the
 * user is just tapping to select text. Letting these through keeps cc's
 * focus state accurate without popping a quota_exhausted dialog every
 * focus shift.
 */
const HARMLESS_CONTROL_SEQUENCES: ReadonlySet<string> = new Set([
  '\x1b[I',
  '\x1b[O',
]);

/**
 * synchronous in-memory gate evaluated on every WS
 * `input` frame before writing to the PTY. Owner kind / unknown user /
 * missing UserStore / harmless control sequences all pass through;
 * otherwise check the per-user cost / tokens limits using the latest
 * QuotaWatcher-written `used` values. Cost first then tokens (mirror
 * of  "first to trip" semantics).
 */
export function evaluateQuotaGate(
  userStore: UserStore | undefined,
  session: Session,
  data: string,
): QuotaGateResult {
  if (HARMLESS_CONTROL_SEQUENCES.has(data)) return { blocked: false };
  if (userStore === undefined) return { blocked: false };
  const user = userStore.findById(session.info.userId);
  if (user === null) return { blocked: false };
  if (user.kind === 'owner') return { blocked: false };

  const cost = user.quota.cost;
  if (cost.limitUsd !== null && cost.usedUsd >= cost.limitUsd) {
    return {
      blocked: true,
      reason: `cost quota exhausted: $${cost.usedUsd.toFixed(2)} / $${cost.limitUsd.toFixed(2)}`,
    };
  }
  const tokens = user.quota.tokens;
  if (tokens.limit !== null && tokens.used >= tokens.limit) {
    return {
      blocked: true,
      reason: `tokens quota exhausted: ${tokens.used} / ${tokens.limit}`,
    };
  }
  return { blocked: false };
}
