/**
 * In-memory ring buffer of user-side operations. Pushed from store
 * actions and other meaningful user-initiated events (theme switch,
 * drawer toggle, …) so the feedback dialog can attach a recent action
 * trail for debugging without asking the user to reproduce.
 *
 * Module-scoped (not a zustand store) — these are write-only events with
 * no UI subscription needs; a singleton buffer is simpler and lighter.
 */

export interface OpRecord {
  /** epoch-ms when the op was recorded. */
  readonly ts: number;
  /** Short identifier like 'session.create' / 'theme.cycle'. */
  readonly kind: string;
  /** Optional JSON-serializable detail. Avoid PII; ids are fine. */
  readonly payload?: Record<string, unknown>;
}

// Trace event budget derived from the retention window we want and the
// dominant source's peak rate. Don't tweak the constant directly —
// adjust the inputs:
//
// - `RETENTION_WINDOW_S` — how far back we want a feedback submission
// to retain context. 60s = "user notices a glitch, drags, taps
// drawer, taps 反馈, types a title, submits" still has the original
// trigger trail.
//
// - `PEAK_EV_PER_S` — server's `outputFps` (60) caps `term.write`
// emission, so that's the dominant frame-rate-bound source.
// Throttled touch / mouse / selection events contribute ~30 ev/s
// under heavy interaction. Worst-case combined ≈ 90 ev/s.
//
// - `HEADROOM` — short bursts can momentarily exceed PEAK_EV_PER_S
// during a TUI repaint storm; 1.2× absorbs them without truncation.
//
// Body size impact: ~120 B per op JSON × MAX_OPS ≈ 780 KB worst-case
// POST body, comfortably under fastify's default 1 MB limit and within
// what a slow mobile uplink (0.4 Mbps observed in dogfood) can ship in
// ~16 s. The server schema cap (src/server/routes/feedback.ts) is set
// generously above this so legitimate submissions are never 400'd —
// growing this constant doesn't require a server change as long as it
// stays well under that ceiling.
const RETENTION_WINDOW_S = 60;
const PEAK_EV_PER_S = 90;
const HEADROOM = 1.2;
export const MAX_OPS = Math.ceil(RETENTION_WINDOW_S * PEAK_EV_PER_S * HEADROOM);
const buffer: OpRecord[] = [];

export function recordOp(kind: string, payload?: Record<string, unknown>): void {
  const op: OpRecord = payload === undefined
    ? { ts: Date.now(), kind }
    : { ts: Date.now(), kind, payload };
  buffer.push(op);
  if (buffer.length > MAX_OPS) buffer.shift();
}

const lastByKind = new Map<string, number>();

/**
 * Per-kind throttle. Useful for high-frequency events (touchmove,
 * synthesized mousemove during drag) where we want a sample, not the
 * whole stream — the ring is finite and the user's *most recent* action
 * trail matters more than a dense recording of any single moment.
 */
export function recordOpThrottled(
  kind: string,
  payload: Record<string, unknown> | undefined,
  intervalMs: number,
): void {
  const now = Date.now();
  const last = lastByKind.get(kind) ?? 0;
  if (now - last < intervalMs) return;
  lastByKind.set(kind, now);
  recordOp(kind, payload);
}

export function snapshotOps(): OpRecord[] {
  return [...buffer];
}

/** Tests only. */
export function resetOpsForTest(): void {
  buffer.length = 0;
  lastByKind.clear();
}
