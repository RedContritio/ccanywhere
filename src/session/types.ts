export type SessionState = 'starting' | 'idle' | 'busy' | 'dead';

export type SessionMode = 'fresh' | 'resume';

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
