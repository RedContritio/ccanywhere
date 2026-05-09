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

const MAX_OPS = 50;
const buffer: OpRecord[] = [];

export function recordOp(kind: string, payload?: Record<string, unknown>): void {
  const op: OpRecord = payload === undefined
    ? { ts: Date.now(), kind }
    : { ts: Date.now(), kind, payload };
  buffer.push(op);
  if (buffer.length > MAX_OPS) buffer.shift();
}

export function snapshotOps(): OpRecord[] {
  return [...buffer];
}

/** Tests only. */
export function resetOpsForTest(): void {
  buffer.length = 0;
}
