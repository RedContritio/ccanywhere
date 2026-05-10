import type { ScreenState } from './screen-state.js';
import type { Scrollback } from './scrollback.js';

export type SessionState = 'starting' | 'idle' | 'busy' | 'dead';

export type SessionMode = 'create' | 'resume';

export interface SessionInfo {
  readonly id: string;
  readonly projectId: string;
  readonly cwd: string;
  readonly mode: SessionMode;
  readonly resumeSessionId?: string;
  readonly createdAt: number;
}

export interface DataEvent {
  readonly sessionId: string;
  readonly data: string;
}

export interface StatusEvent {
  readonly sessionId: string;
  readonly state: SessionState;
}

export interface ExitEvent {
  readonly sessionId: string;
  readonly code: number;
  readonly signal?: number;
}

export interface SessionEventMap {
  data: DataEvent;
  status: StatusEvent;
  exit: ExitEvent;
}

export type SessionEventName = keyof SessionEventMap;

export type SessionListener<E extends SessionEventName> = (event: SessionEventMap[E]) => void;

export interface PtyDataChunkRecord {
  readonly ts: number;
  readonly len: number;
  /** First 32 bytes hex-escaped; control bytes shown as \xNN. */
  readonly head: string;
}

export interface Session {
  readonly info: SessionInfo;
  readonly state: SessionState;
  readonly scrollback: Scrollback;
  readonly screenState: ScreenState;
  readonly deletedAt: number | null;
  readonly lastDataAt: number | null;
  readonly exitCode: number | null;
  readonly recentDataChunks: readonly PtyDataChunkRecord[];
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): Promise<void>;
  setState(next: SessionState): void;
  markDeleted(): void;
  on<E extends SessionEventName>(event: E, fn: SessionListener<E>): () => void;
}
