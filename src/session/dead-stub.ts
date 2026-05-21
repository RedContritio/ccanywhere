import type { SessionInfo, SessionRow } from './types.js';

/**
 * Snapshot of a session whose PTY has exited. Persisted across server
 * restarts so the workspace UI can show the user the last screen they
 * saw + a Resume button to spawn a new cc PTY with `--resume <id>`.
 *
 * `deletedAt` distinguishes B-class dead (user DELETE → soft delete,
 * GC ttl later hard removes the metadata) from A/C/D-class dead (cc
 * exit / shutdown / crash → keep indefinitely until user actively
 * deletes).
 */
export interface DeadStub extends SessionRow {
  readonly info: SessionInfo;
  readonly state: 'dead';
  readonly deletedAt: number | null;
  readonly lastScreen: string;
  readonly exitedAt: number;
}

export function makeDeadStub(
  info: SessionInfo,
  deletedAt: number | null,
  lastScreen: string,
  exitedAt: number,
): DeadStub {
  return { info, state: 'dead', deletedAt, lastScreen, exitedAt };
}
