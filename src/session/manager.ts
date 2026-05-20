import { randomUUID } from 'node:crypto';
import { spawn as ptySpawn } from 'node-pty';
import { logger } from '../log.js';
import { makeDeadStub, type DeadStub } from './dead-stub.js';
import type { SessionManagerOptions, SpawnOptions, SpawnResult } from './manager-types.js';
import type { SessionRegistry } from './registry.js';
import { ScreenState } from './screen-state.js';
import { Scrollback } from './scrollback.js';
import { SessionImpl } from './session-impl.js';
import { buildSpawnCommand } from './spawn-command.js';
import type { Session, SessionInfo, SessionRow } from './types.js';

export type {
  SessionManagerOptions,
  SpawnOptions,
  SpawnResult,
} from './manager-types.js';
export type { Session, SessionRow } from './types.js';
export type { DeadStub } from './dead-stub.js';

const DEFAULT_DELETED_TTL_MS = 10 * 60 * 1000;

function makeSessionInfo(id: string, opts: SpawnOptions): SessionInfo {
  const base = {
    id,
    projectId: opts.projectId,
    cwd: opts.cwd,
    mode: opts.mode,
    createdAt: Date.now(),
    userId: opts.userId,
  };
  return opts.resumeSessionId !== undefined
    ? { ...base, resumeSessionId: opts.resumeSessionId }
    : base;
}

export class SessionManager {
  private readonly sessions = new Map<string, SessionImpl>();
  /** PTY-exited sessions: disjoint from `sessions`, kept for Resume. */
  private readonly deadStubs = new Map<string, DeadStub>();
  /** cc resumeSessionId → ccanywhere id: avoid two cc procs on one jsonl
   * (anthropics/claude-code#26964). Stale entries cleared on attach recheck. */
  private readonly _activeResumeTargets = new Map<string, string>();
  private readonly deletedSessionTtlMs: number;
  private readonly registry: SessionRegistry | undefined;
  /** : late-wired by buildServer after building QuotaWatcher. */
  private lifecycleObserver: SessionManagerOptions['lifecycleObserver'];
  private readonly pendingWrites = new Set<Promise<unknown>>();

  constructor(options: SessionManagerOptions = {}) {
    this.deletedSessionTtlMs = options.deletedSessionTtlMs ?? DEFAULT_DELETED_TTL_MS;
    if (this.deletedSessionTtlMs <= 0) {
      throw new RangeError(`deletedSessionTtlMs must be positive, got ${this.deletedSessionTtlMs}`);
    }
    this.registry = options.registry;
    this.lifecycleObserver = options.lifecycleObserver;
  }

  /** : late-wire observer after SessionManager construction. */
  setLifecycleObserver(observer: SessionManagerOptions['lifecycleObserver']): void {
    this.lifecycleObserver = observer;
  }

  /** Boot-time sync recovery: GC stale soft-deleted, load rest as dead stubs. */
  loadDeadStubs(now: number = Date.now()): void {
    if (this.registry === undefined) return;
    const all = this.registry.loadAllSync();
    const ttl = this.deletedSessionTtlMs;
    for (const p of all) {
      // Active wins over stub (re-load after spawn / duplicate load).
      if (this.sessions.has(p.info.id)) continue;
      if (p.deletedAt !== null && p.deletedAt + ttl < now) {
        this.trackWrite(this.registry.delete(p.info.id));
        continue;
      }
      this.deadStubs.set(
        p.info.id,
        makeDeadStub(p.info, p.deletedAt, p.lastScreen, p.deletedAt ?? now),
      );
    }
    logger.info({ count: this.deadStubs.size }, 'session registry loaded dead stubs');
  }

  spawn(opts: SpawnOptions): SpawnResult {
    this.gc(Date.now());
    const attached = this.tryAttachExisting(opts);
    if (attached !== null) return attached;
    const id = opts.forcedSessionId ?? randomUUID();
    const cols = opts.cols ?? 100;
    const rows = opts.rows ?? 30;

    // host = identity spawn; shared-container
    // wraps in `docker exec -it -u <user> -e KEY=VAL ...` via helper.
    const { command, args, ptyEnv } = buildSpawnCommand(opts);
    const pty = ptySpawn(command, [...args], {
      cwd: opts.cwd,
      cols,
      rows,
      env: ptyEnv,
      name: 'xterm-256color',
    });
    const info = makeSessionInfo(id, opts);
    const session = new SessionImpl(
      info,
      pty,
      new Scrollback(opts.scrollbackBytes),
      new ScreenState(cols, rows),
      (lastScreen) => this.handleSessionExit(id, lastScreen),
    );
    this.sessions.set(id, session);
    this.deadStubs.delete(id); // resume-from-dead: no duplicate in list()
    if (this.registry !== undefined) {
      this.trackWrite(this.registry.save(info, null));
      this.trackWrite(this.registry.deleteScreen(id)); // stale snapshot
    }
    if (opts.mode === 'resume' && opts.resumeSessionId !== undefined) {
      this.bindResumeLock(opts.resumeSessionId, id, session);
    }
    session.setState('idle');
    logger.debug(
      {
        sessionId: id,
        projectId: info.projectId,
        cwd: opts.cwd,
        mode: opts.mode,
        resumeSessionId: opts.resumeSessionId ?? null,
        cols,
        rows,
        envOverrides: Object.keys(opts.env ?? {}),
      },
      'session spawned',
    );
    // observer must swallow its own errors (QuotaWatcher does).
    this.lifecycleObserver?.start(session);
    return { kind: 'created', session };
  }

  private tryAttachExisting(opts: SpawnOptions): SpawnResult | null {
    if (opts.mode !== 'resume' || opts.resumeSessionId === undefined) {
      return null;
    }
    const existingId = this._activeResumeTargets.get(opts.resumeSessionId);
    if (existingId === undefined) return null;
    const existing = this.sessions.get(existingId);
    if (
      existing !== undefined &&
      existing.deletedAt === null &&
      existing.state !== 'dead'
    ) {
      return { kind: 'attached', existingId };
    }
    // Stale entry — exit listener hasn't fired yet. Drop and fall through.
    this._activeResumeTargets.delete(opts.resumeSessionId);
    return null;
  }

  private bindResumeLock(lockKey: string, id: string, session: SessionImpl): void {
    this._activeResumeTargets.set(lockKey, id);
    // Identity-check on release: newer reclaim must not wipe new owner.
    session.on('exit', () => {
      if (this._activeResumeTargets.get(lockKey) === id) {
        this._activeResumeTargets.delete(lockKey);
      }
    });
  }

  /** Dead → active: spawn a new cc PTY reusing the original id/jsonl. */
  resumeDeadStub(
    id: string,
    spawnOpts: Omit<
      SpawnOptions,
      'mode' | 'resumeSessionId' | 'forcedSessionId' | 'projectId' | 'cwd' | 'userId'
    >,
  ): SpawnResult {
    const stub = this.deadStubs.get(id);
    if (stub === undefined) {
      throw new Error(`resumeDeadStub: no dead stub for ${id}`);
    }
    if (stub.deletedAt !== null) {
      throw new Error(`resumeDeadStub: stub ${id} is soft-deleted, cannot resume`);
    }
    // Lock key uses cc jsonl id (resume mode preserves original).
    return this.spawn({
      ...spawnOpts,
      projectId: stub.info.projectId,
      cwd: stub.info.cwd,
      userId: stub.info.userId,
      mode: 'resume',
      resumeSessionId: stub.info.resumeSessionId ?? id,
      forcedSessionId: id,
    });
  }

  /** Soft-delete for active or dead rows. Returns false on unknown id. */
  markDeleted(id: string): boolean {
    const session = this.sessions.get(id);
    if (session !== undefined) {
      session.markDeleted();
      if (this.registry !== undefined) {
        this.trackWrite(this.registry.save(session.info, session.deletedAt));
      }
      return true;
    }
    const stub = this.deadStubs.get(id);
    if (stub !== undefined) {
      if (stub.deletedAt !== null) return true;
      const updated = makeDeadStub(stub.info, Date.now(), stub.lastScreen, stub.exitedAt);
      this.deadStubs.set(id, updated);
      if (this.registry !== undefined) {
        this.trackWrite(this.registry.save(stub.info, updated.deletedAt));
      }
      return true;
    }
    return false;
  }

  /** Active SessionImpl access (PTY-bound methods). Dead rows return undefined. */
  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  /** Dead-stub access for the resume / screen endpoints. */
  getDeadStub(id: string): DeadStub | undefined {
    return this.deadStubs.get(id);
  }

  /** Look up either map; used by DELETE / auth-check paths. */
  findRow(id: string): SessionRow | undefined {
    const active = this.sessions.get(id);
    if (active !== undefined) return active;
    return this.deadStubs.get(id);
  }

  /** Last-frame text from a dead stub (workspace preview). */
  getScreenSnapshot(id: string): string | undefined {
    return this.deadStubs.get(id)?.lastScreen;
  }

  list(): SessionRow[] {
    this.gc(Date.now());
    return [...this.sessions.values(), ...this.deadStubs.values()];
  }

  listActive(): Session[] {
    this.gc(Date.now());
    return [...this.sessions.values()].filter((s) => s.deletedAt === null);
  }

  /** Hard-delete soft-deleted rows past ttl. now injectable for tests. */
  gc(now: number): void {
    const ttl = this.deletedSessionTtlMs;
    for (const [id, s] of this.sessions) {
      if (s.deletedAt !== null && s.deletedAt + ttl < now) {
        this.sessions.delete(id);
        if (this.registry !== undefined) {
          this.trackWrite(this.registry.delete(id));
        }
      }
    }
    for (const [id, stub] of this.deadStubs) {
      if (stub.deletedAt !== null && stub.deletedAt + ttl < now) {
        this.deadStubs.delete(id);
        if (this.registry !== undefined) {
          this.trackWrite(this.registry.delete(id));
        }
      }
    }
  }

  /** Awaits pending writes (shutdown flush, no PTY kill). Loops because
   *  handleSessionExit can trackWrite during await — snapshot leaks. */
  async detach(): Promise<void> {
    while (this.pendingWrites.size > 0) {
      await Promise.allSettled([...this.pendingWrites]);
    }
  }

  async killAll(): Promise<void> {
    await Promise.all(this.listActive().map((s) => s.kill()));
  }

  private handleSessionExit(id: string, lastScreen: string): void {
    const session = this.sessions.get(id);
    if (session === undefined) return;
    const deletedAt = session.deletedAt;
    this.sessions.delete(id);
    const stub = makeDeadStub(session.info, deletedAt, lastScreen, Date.now());
    this.deadStubs.set(id, stub);
    if (this.registry !== undefined) {
      this.trackWrite(this.registry.save(session.info, deletedAt));
      this.trackWrite(this.registry.saveScreen(id, lastScreen));
    }
    this.lifecycleObserver?.stop(id);
  }

  private trackWrite(p: Promise<unknown>): void {
    this.pendingWrites.add(p);
    void p.finally(() => this.pendingWrites.delete(p));
  }
}
