import { z } from 'zod';
import type { SessionState } from '../session/types.js';

export const ClientFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), data: z.string() }),
  z.object({
    type: z.literal('resize'),
    cols: z.number().int().min(1).max(1000),
    rows: z.number().int().min(1).max(1000),
  }),
  z.object({ type: z.literal('ping') }),
]);
export type ClientFrame = z.infer<typeof ClientFrameSchema>;

export type ServerFrame =
  /**
   * Full-state restore. Sent on first connect or when the client's
   * `lastSeq` falls outside the server scrollback ring (data evicted).
   * Client should `term.reset()` before writing this.
   */
  | { type: 'snapshot'; upToSeq: number; data: string }
  /**
   * Incremental cc bytes. `seq` is the cumulative byte counter AFTER
   * this frame's data has been written — the client persists it as
   * `lastSeq` to feed back on reconnect via `?lastSeq=N`.
   */
  | { type: 'output'; seq: number; data: string }
  | { type: 'status'; state: SessionState }
  | { type: 'error'; message: string }
  | { type: 'pong' };
