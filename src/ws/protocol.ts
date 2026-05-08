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
  | { type: 'snapshot'; data: string }
  | { type: 'output'; data: string }
  | { type: 'status'; state: SessionState }
  | { type: 'error'; message: string }
  | { type: 'pong' };
