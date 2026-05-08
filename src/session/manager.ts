import { randomUUID } from 'node:crypto';
import { spawn as ptySpawn, type IPty } from 'node-pty';
import { logger } from '../log.js';
import { Scrollback } from './scrollback.js';
import type {
  SessionEventMap,
  SessionEventName,
  SessionInfo,
  SessionListener,
  SessionMode,
  SessionState,
} from './types.js';

export interface SpawnOptions {
  readonly projectId: string;
  readonly cwd: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cols?: number;
  readonly rows?: number;
  readonly env?: Readonly<Record<string, string>>;
  readonly scrollbackBytes: number;
  readonly mode: SessionMode;
  readonly resumeSessionId?: string;
}

export interface Session {
  readonly info: SessionInfo;
  readonly state: SessionState;
  readonly scrollback: Scrollback;
  readonly deletedAt: number | null;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): Promise<void>;
  setState(next: SessionState): void;
  markDeleted(): void;
  on<E extends SessionEventName>(event: E, fn: SessionListener<E>): () => void;
}

const KILL_TERM_AFTER_MS = 2_000;
const KILL_FORCE_AFTER_MS = 7_000;

class SessionImpl implements Session {
  state: SessionState = 'starting';
  deletedAt: number | null = null;

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
  ) {
    this.pty.onData((data) => {
      this.scrollback.append(data);
      this.emit('data', { sessionId: this.info.id, data });
    });
    this.pty.onExit(({ exitCode, signal }) => {
      this.state = 'dead';
      this.emit('status', { sessionId: this.info.id, state: 'dead' });
      const exitPayload =
        signal === undefined
          ? { sessionId: this.info.id, code: exitCode }
          : { sessionId: this.info.id, code: exitCode, signal };
      this.emit('exit', exitPayload);
      const resolvers = this.killResolvers;
      this.killResolvers = [];
      for (const r of resolvers) r();
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

function buildEnv(extra: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') out[k] = v;
  }
  if (extra) {
    for (const [k, v] of Object.entries(extra)) out[k] = v;
  }
  return out;
}

export interface SessionManagerOptions {
  /**
   * Time after `deletedAt` a soft-deleted session is physically removed from the
   * manager's map. Defaults to 10 minutes. GC runs opportunistically on spawn / list calls.
   */
  readonly deletedSessionTtlMs?: number;
}

const DEFAULT_DELETED_TTL_MS = 10 * 60 * 1000;

export class SessionManager {
  private readonly sessions = new Map<string, SessionImpl>();
  private readonly deletedSessionTtlMs: number;

  constructor(options: SessionManagerOptions = {}) {
    this.deletedSessionTtlMs = options.deletedSessionTtlMs ?? DEFAULT_DELETED_TTL_MS;
    if (this.deletedSessionTtlMs <= 0) {
      throw new RangeError(
        `deletedSessionTtlMs must be positive, got ${this.deletedSessionTtlMs}`,
      );
    }
  }

  spawn(opts: SpawnOptions): Session {
    this.gc(Date.now());
    const id = randomUUID();
    const cols = opts.cols ?? 100;
    const rows = opts.rows ?? 30;

    // Inherit the parent process environment (HOME, PATH, …) so cc reads
    // the user's ~/.claude/ for auth + settings. We MUST NOT override
    // CLAUDE_CONFIG_DIR — earlier auto-injection (M5) shadowed user auth
    // and forced a fresh cc login on every web-spawned session.
    const env = buildEnv(opts.env);

    const pty = ptySpawn(opts.command, [...opts.args], {
      cwd: opts.cwd,
      cols,
      rows,
      env,
      name: 'xterm-256color',
    });

    const info: SessionInfo =
      opts.resumeSessionId === undefined
        ? {
            id,
            projectId: opts.projectId,
            cwd: opts.cwd,
            mode: opts.mode,
            createdAt: Date.now(),
          }
        : {
            id,
            projectId: opts.projectId,
            cwd: opts.cwd,
            mode: opts.mode,
            resumeSessionId: opts.resumeSessionId,
            createdAt: Date.now(),
          };

    const session = new SessionImpl(info, pty, new Scrollback(opts.scrollbackBytes));
    this.sessions.set(id, session);

    session.setState('idle');

    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  list(): Session[] {
    this.gc(Date.now());
    return [...this.sessions.values()];
  }

  listActive(): Session[] {
    this.gc(Date.now());
    return [...this.sessions.values()].filter((s) => s.deletedAt === null);
  }

  /**
   * Remove soft-deleted sessions whose deletedAt + ttl has elapsed.
   * `now` is injectable for tests; production callers pass Date.now().
   */
  gc(now: number): void {
    const ttl = this.deletedSessionTtlMs;
    for (const [id, s] of this.sessions) {
      if (s.deletedAt !== null && s.deletedAt + ttl < now) {
        this.sessions.delete(id);
      }
    }
  }

  async killAll(): Promise<void> {
    await Promise.all(this.list().map((s) => s.kill()));
  }
}
