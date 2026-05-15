import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { USERNAME_RE, type User, type UserPreferences } from './types.js';

export class UserStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserStoreError';
  }
}

interface PersistedState {
  readonly users: ReadonlyArray<User>;
}

export interface UserStoreOptions {
  readonly statePath: string;
  /**
   * Default user-projects parent directory. Each user's project root
   * defaults to `<workspace>/<username>/` unless `userOverrides[username]
   * .workspace` provides an absolute path override (m-user-symmetric).
   */
  readonly workspace: string;
  readonly userOverrides?: Record<string, { workspace?: string | undefined }> | undefined;
  readonly now?: () => number;
}

export interface CreateUserInput {
  readonly username: string;
  readonly costLimitUsd: number | null;
  readonly tokensLimit: number | null;
}

export interface SetQuotaLimitInput {
  /** undefined = leave unchanged; null = clear (must not leave both null). */
  readonly costLimitUsd?: number | null;
  readonly tokensLimit?: number | null;
  readonly reset?: boolean;
}

export class UserStore {
  private readonly statePath: string;
  private readonly workspace: string;
  private readonly userOverrides: Record<string, { workspace?: string | undefined }> | undefined;
  private readonly now: () => number;
  private readonly users = new Map<string, User>();

  constructor(opts: UserStoreOptions) {
    this.statePath = opts.statePath;
    this.workspace = resolve(opts.workspace);
    this.userOverrides = opts.userOverrides;
    this.now = opts.now ?? (() => Date.now());
    this.load();
    this.ensureOwner();
  }

  list(): User[] {
    return Array.from(this.users.values()).sort((a, b) => a.createdAt - b.createdAt);
  }

  findById(id: string): User | null {
    return this.users.get(id) ?? null;
  }

  findByUsername(username: string): User | null {
    const normalized = username.normalize('NFC');
    for (const u of this.users.values()) {
      if (u.username === normalized) return u;
    }
    return null;
  }

  getOwner(): User {
    for (const u of this.users.values()) {
      if (u.kind === 'owner') return u;
    }
    throw new UserStoreError('owner missing — store invariant violated');
  }

  /**
   * Project root for this user. Returns the user's `users.<name>.workspace`
   * override (absolute path) if present, else `<workspace>/<username>/`.
   * `kind` does NOT influence the lookup — owner and user resolve through
   * the same path (m-user-symmetric).
   */
  projectsRootFor(user: User): string {
    const override = this.userOverrides?.[user.username]?.workspace;
    if (override !== undefined) return resolve(override);
    return join(this.workspace, user.username);
  }

  createUser(input: CreateUserInput): User {
    const username = input.username.normalize('NFC');
    if (!USERNAME_RE.test(username)) {
      throw new UserStoreError(`invalid username: ${JSON.stringify(username)}`);
    }
    if (input.costLimitUsd === null && input.tokensLimit === null) {
      throw new UserStoreError('user must set at least one quota limit');
    }
    if (this.findByUsername(username) !== null) {
      throw new UserStoreError(`user already exists: ${username}`);
    }
    // Pre-build the User so we can resolve its target dir via the unified
    // projectsRootFor (honors any override the operator set ahead of time).
    const candidate: User = {
      id: randomUUID(),
      username,
      kind: 'user',
      createdAt: this.now(),
      lastLoginAt: null,
      quota: {
        cost: { limitUsd: input.costLimitUsd, usedUsd: 0 },
        tokens: { limit: input.tokensLimit, used: 0 },
      },
      preferences: {},
      lastActiveSessionId: null,
    };
    const userDir = this.projectsRootFor(candidate);
    if (existsSync(userDir)) {
      throw new UserStoreError(`fs guard: ${userDir} already exists`);
    }

    // mkdir → users.json; persist failure rolls back rmdir to avoid fs guard deadlock
    mkdirSync(userDir, { mode: 0o700, recursive: false });
    this.users.set(candidate.id, candidate);
    try {
      this.persist();
    } catch (err) {
      this.users.delete(candidate.id);
      try {
        rmdirSync(userDir);
      } catch {
        // best-effort cleanup
      }
      throw err;
    }
    return candidate;
  }

  touchLogin(userId: string): void {
    const u = this.users.get(userId);
    if (!u) return;
    this.users.set(userId, { ...u, lastLoginAt: this.now() });
    this.persist();
  }

  setQuotaUsage(userId: string, costUsd: number, totalTokens: number): void {
    const u = this.users.get(userId);
    if (!u) return;
    this.users.set(userId, {
      ...u,
      quota: {
        cost: { ...u.quota.cost, usedUsd: costUsd },
        tokens: { ...u.quota.tokens, used: totalTokens },
      },
    });
    this.persist();
  }

  /**
   * Returns the user's preferences object. null only when the user id is
   * unknown — present users always have at least `{}`.
   */
  getPreferences(userId: string): UserPreferences | null {
    const u = this.users.get(userId);
    return u ? u.preferences : null;
  }

  /**
   * Replace preferences wholesale. Caller is responsible for validating
   * `prefs` against the schema; UserStore stores them verbatim and never
   * merges with the prior value.
   */
  setPreferences(userId: string, prefs: UserPreferences): User {
    const u = this.users.get(userId);
    if (!u) throw new UserStoreError(`user not found: ${userId}`);
    const next: User = { ...u, preferences: prefs };
    this.users.set(userId, next);
    this.persist();
    return next;
  }

  /**
   * Cross-device "last selected session". null clears the selection. The
   * server stores the id verbatim — staleness (session deleted) is
   * resolved on the client when it joins against the live sessions list.
   */
  setLastActiveSession(userId: string, sessionId: string | null): User {
    const u = this.users.get(userId);
    if (!u) throw new UserStoreError(`user not found: ${userId}`);
    const next: User = { ...u, lastActiveSessionId: sessionId };
    this.users.set(userId, next);
    this.persist();
    return next;
  }

  setQuotaLimit(userId: string, input: SetQuotaLimitInput): User {
    const u = this.users.get(userId);
    if (!u) throw new UserStoreError(`user not found: ${userId}`);
    if (u.kind === 'owner') {
      throw new UserStoreError('cannot set quota on owner');
    }
    const costLimitUsd =
      input.costLimitUsd !== undefined ? input.costLimitUsd : u.quota.cost.limitUsd;
    const tokensLimit =
      input.tokensLimit !== undefined ? input.tokensLimit : u.quota.tokens.limit;
    if (costLimitUsd === null && tokensLimit === null) {
      throw new UserStoreError('user must keep at least one quota limit');
    }
    const next: User = {
      ...u,
      quota: {
        cost: {
          limitUsd: costLimitUsd,
          usedUsd: input.reset ? 0 : u.quota.cost.usedUsd,
        },
        tokens: {
          limit: tokensLimit,
          used: input.reset ? 0 : u.quota.tokens.used,
        },
      },
    };
    this.users.set(userId, next);
    this.persist();
    return next;
  }

  private ensureOwner(): void {
    for (const u of this.users.values()) {
      if (u.kind === 'owner') return;
    }
    const owner: User = {
      id: randomUUID(),
      username: 'owner',
      kind: 'owner',
      createdAt: this.now(),
      lastLoginAt: null,
      quota: {
        cost: { limitUsd: null, usedUsd: 0 },
        tokens: { limit: null, used: 0 },
      },
      preferences: {},
      lastActiveSessionId: null,
    };
    this.users.set(owner.id, owner);
    this.persist();
  }

  private load(): void {
    if (!existsSync(this.statePath)) return;
    let raw: string;
    try {
      raw = readFileSync(this.statePath, 'utf8');
    } catch {
      return;
    }
    let parsed: Partial<PersistedState>;
    try {
      parsed = JSON.parse(raw) as Partial<PersistedState>;
    } catch {
      return;
    }
    if (!Array.isArray(parsed.users)) return;
    let dirty = false;
    for (const u of parsed.users) {
      if (typeof u?.id !== 'string') continue;
      // m-user-symmetric: legacy 'limited' kind migrated to 'user'.
      // m-user-prefs: legacy records lack `preferences` and
      // `lastActiveSessionId`. Coerce to defaults so downstream code
      // (route handlers, ?? fallbacks) always sees defined values.
      let kind = u.kind;
      if ((kind as string) === 'limited') {
        kind = 'user';
        dirty = true;
      }
      const migrated: User = {
        ...u,
        kind,
        preferences: u.preferences ?? {},
        lastActiveSessionId:
          u.lastActiveSessionId === undefined ? null : u.lastActiveSessionId,
      };
      this.users.set(u.id, migrated);
    }
    if (dirty) this.persist();
  }

  private persist(): void {
    const dir = dirname(this.statePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const state: PersistedState = { users: Array.from(this.users.values()) };
    writeFileSync(this.statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
  }
}
