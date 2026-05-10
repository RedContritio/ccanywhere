import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { USERNAME_RE, type User } from './types.js';

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
  /** Absolute path; createLimitedUser mkdirs `<guestProjectsRoot>/<username>/`. */
  readonly guestProjectsRoot: string;
  readonly now?: () => number;
}

export interface CreateLimitedUserInput {
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
  private readonly guestProjectsRoot: string;
  private readonly now: () => number;
  private readonly users = new Map<string, User>();

  constructor(opts: UserStoreOptions) {
    this.statePath = opts.statePath;
    this.guestProjectsRoot = resolve(opts.guestProjectsRoot);
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
   * Project root for this user — owner uses Config.projectsRoot (caller
   * supplies); limited user lives under `<guestProjectsRoot>/<username>/`.
   */
  projectsRootFor(user: User, ownerProjectsRoot: string): string {
    return user.kind === 'owner'
      ? resolve(ownerProjectsRoot)
      : join(this.guestProjectsRoot, user.username);
  }

  createLimitedUser(input: CreateLimitedUserInput): User {
    const username = input.username.normalize('NFC');
    if (!USERNAME_RE.test(username)) {
      throw new UserStoreError(`invalid username: ${JSON.stringify(username)}`);
    }
    if (input.costLimitUsd === null && input.tokensLimit === null) {
      throw new UserStoreError('limited user must set at least one quota limit');
    }
    if (this.findByUsername(username) !== null) {
      throw new UserStoreError(`user already exists: ${username}`);
    }
    const userDir = join(this.guestProjectsRoot, username);
    if (existsSync(userDir)) {
      throw new UserStoreError(`fs guard: ${userDir} already exists`);
    }

    // mkdir → users.json; persist failure rolls back rmdir to avoid fs guard deadlock
    mkdirSync(userDir, { mode: 0o700, recursive: false });
    const user: User = {
      id: randomUUID(),
      username,
      kind: 'limited',
      createdAt: this.now(),
      lastLoginAt: null,
      quota: {
        cost: { limitUsd: input.costLimitUsd, usedUsd: 0 },
        tokens: { limit: input.tokensLimit, used: 0 },
      },
    };
    this.users.set(user.id, user);
    try {
      this.persist();
    } catch (err) {
      this.users.delete(user.id);
      try {
        rmdirSync(userDir);
      } catch {
        // best-effort cleanup
      }
      throw err;
    }
    return user;
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
      throw new UserStoreError('limited user must keep at least one quota limit');
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
    if (Array.isArray(parsed.users)) {
      for (const u of parsed.users) {
        if (typeof u?.id === 'string') this.users.set(u.id, u);
      }
    }
  }

  private persist(): void {
    const dir = dirname(this.statePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const state: PersistedState = { users: Array.from(this.users.values()) };
    writeFileSync(this.statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
  }
}
