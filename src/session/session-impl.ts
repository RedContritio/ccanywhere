import { type IPty } from 'node-pty';
import { logger } from '../log.js';
import type { ScreenState } from './screen-state.js';
import type { Scrollback } from './scrollback.js';
import type {
  PtyDataChunkRecord,
  Session,
  SessionEventMap,
  SessionEventName,
  SessionInfo,
  SessionListener,
  SessionState,
} from './types.js';

const KILL_TERM_AFTER_MS = 2_000;
const KILL_FORCE_AFTER_MS = 7_000;

function escapeHead(data: string, max = 32): string {
  return data
    .slice(0, max)
    .replace(/[\x00-\x1f\x7f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

export class SessionImpl implements Session {
  state: SessionState = 'starting';
  deletedAt: number | null = null;
  lastDataAt: number | null = null;
  exitCode: number | null = null;
  private readonly _recentDataChunks: PtyDataChunkRecord[] = [];

  get recentDataChunks(): readonly PtyDataChunkRecord[] {
    return this._recentDataChunks;
  }

  private readonly listeners: {
    [E in SessionEventName]: Set<SessionListener<E>>;
  } = {
    data: new Set(),
    status: new Set(),
    exit: new Set(),
  };

  private killing = false;
  private killResolvers: Array<() => void> = [];

  constructor(
    public readonly info: SessionInfo,
    private readonly pty: IPty,
    public readonly scrollback: Scrollback,
    public readonly screenState: ScreenState,
    /**
     * Invoked once on PTY exit with the last-visible-frame text from
     * screenState.snapshot(). Caller (SessionManager) persists this to
     * the registry so the workspace UI can show user the final screen
     * + a Resume button after restart. Captured BEFORE dispose() so the
     * headless buffer is still readable.
     */
    private readonly onSnapshotReady?: (text: string) => void,
  ) {
    this.pty.onData((data) => {
      this.scrollback.append(data);
      this.screenState.feed(data);
      this.lastDataAt = Date.now();
      // Append-only: every PTY chunk for the lifetime of the session.
      // Memory bound is the session itself — exit() releases this array
      // along with the rest of SessionImpl.
      this._recentDataChunks.push({
        ts: this.lastDataAt,
        len: data.length,
        head: escapeHead(data),
      });
      this.emit('data', { sessionId: this.info.id, data });
    });
    this.pty.onExit(({ exitCode, signal }) => {
      this.state = 'dead';
      this.exitCode = exitCode;
      // Capture the last visible frame BEFORE dispose so the manager
      // can persist it for the post-restart Resume preview.
      let lastScreen = '';
      try {
        lastScreen = this.screenState.snapshot();
      } catch (err) {
        logger.warn(
          { err, sessionId: this.info.id },
          'screenState snapshot on exit failed',
        );
      }
      if (this.onSnapshotReady !== undefined) {
        try {
          this.onSnapshotReady(lastScreen);
        } catch (err) {
          logger.warn(
            { err, sessionId: this.info.id },
            'onSnapshotReady callback threw',
          );
        }
      }
      this.emit('status', { sessionId: this.info.id, state: 'dead' });
      const exitPayload =
        signal === undefined
          ? { sessionId: this.info.id, code: exitCode }
          : { sessionId: this.info.id, code: exitCode, signal };
      this.emit('exit', exitPayload);
      const resolvers = this.killResolvers;
      this.killResolvers = [];
      for (const r of resolvers) r();
      // Free the headless terminal — process-heavy on long sessions.
      try {
        this.screenState.dispose();
      } catch {
        // best effort
      }
    });
  }

  write(data: string): void {
    if (this.state === 'dead') return;
    this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.state === 'dead') return;
    if (cols < 1 || rows < 1) {
      throw new RangeError(`resize requires positive cols/rows, got ${cols}x${rows}`);
    }
    this.pty.resize(cols, rows);
    this.screenState.resize(cols, rows);
  }

  setState(next: SessionState): void {
    if (this.state === next) return;
    if (this.state === 'dead') return;
    this.state = next;
    this.emit('status', { sessionId: this.info.id, state: next });
  }

  markDeleted(): void {
    if (this.deletedAt !== null) return;
    this.deletedAt = Date.now();
    if (this.state !== 'dead') {
      void this.kill();
    }
  }

  kill(): Promise<void> {
    if (this.state === 'dead') return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.killResolvers.push(resolve);
      if (this.killing) return;
      this.killing = true;
      try {
        this.pty.kill('SIGINT');
      } catch (err) {
        logger.warn({ err, sessionId: this.info.id }, 'SIGINT failed');
      }
      setTimeout(() => {
        if (this.state === 'dead') return;
        try {
          this.pty.kill('SIGTERM');
        } catch (err) {
          logger.warn({ err, sessionId: this.info.id }, 'SIGTERM failed');
        }
      }, KILL_TERM_AFTER_MS).unref();
      setTimeout(() => {
        if (this.state === 'dead') return;
        try {
          this.pty.kill('SIGKILL');
        } catch (err) {
          logger.warn({ err, sessionId: this.info.id }, 'SIGKILL failed');
        }
      }, KILL_FORCE_AFTER_MS).unref();
    });
  }

  on<E extends SessionEventName>(event: E, fn: SessionListener<E>): () => void {
    this.listeners[event].add(fn);
    return () => {
      this.listeners[event].delete(fn);
    };
  }

  private emit<E extends SessionEventName>(event: E, payload: SessionEventMap[E]): void {
    for (const fn of this.listeners[event]) {
      try {
        fn(payload);
      } catch (err) {
        logger.error({ err, event, sessionId: this.info.id }, 'session listener threw');
      }
    }
  }
}
