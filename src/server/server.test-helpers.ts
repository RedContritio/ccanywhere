import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../config/schema.js';
import { DeviceStore } from '../devices/store.js';
import { ProjectStore } from '../projects/store.js';
import { TokenStore } from '../tokens/store.js';
import type { Token } from '../tokens/types.js';
import { UserStore } from '../users/store.js';
import type { User } from '../users/types.js';

export const INTERNAL_HOOK_TOKEN = 'h'.repeat(32);
export const CLI_TOKEN = 'c'.repeat(32);

export const baseConfig: Config = {
  port: 7878,
  bindHost: '127.0.0.1',
  claudeBin: 'sh',
  scrollbackBytes: 4096,
  deletedSessionTtlMs: 600_000,
  wsHeartbeat: { intervalMs: 30_000, timeoutMs: 60_000 },
  outputFps: 60,
  // Placeholder: each describe block creates a real tmp dir + ProjectStore;
  // buildServer reads from projectStore, not config.projectsRoot. Tests that
  // exercise multi-user cwd guard MUST override `projectsRoot` /
  // `guestProjectsRoot` to the tmp dirs in `TestProjectsEnv`.
  projectsRoot: '/tmp/ccanywhere-test-placeholder',
  guestProjectsRoot: '/tmp/ccanywhere-test-guest-placeholder',
  webOrigin: 'http://localhost:7878',
  cookieName: 'ccanywhere_session',
};

export interface LimitedUserWithToken {
  readonly user: User;
  readonly token: Token;
  readonly plaintext: string;
  readonly authCookie: string;
}

export interface CreateLimitedUserOpts {
  readonly costLimitUsd?: number | null;
  readonly tokensLimit?: number | null;
  readonly ttlMs?: number;
}

export interface TestProjectsEnv {
  projectsRoot: string;
  guestProjectsRoot: string;
  projectStore: ProjectStore;
  deviceStore: DeviceStore;
  userStore: UserStore;
  tokenStore: TokenStore;
  owner: User;
  demoCwd: string;
  /** Cookie header value pre-formatted for `headers.cookie`. */
  authCookie: string;
  /** sessionId extracted from authCookie. */
  sessionId: string;
  /** Create a limited user + active token; default ttl 24h, costLimitUsd 10. */
  createLimitedUserWithToken: (
    username: string,
    opts?: CreateLimitedUserOpts,
  ) => LimitedUserWithToken;
  cleanup: () => void;
}

export function setupProjects(): TestProjectsEnv {
  const projectsRoot = mkdtempSync(join(tmpdir(), 'ccanywhere-projects-'));
  const guestProjectsRoot = mkdtempSync(join(tmpdir(), 'ccanywhere-guests-'));
  mkdirSync(join(projectsRoot, 'demo'));
  const statePath = join(projectsRoot, '.projects-state.json');
  const projectStore = new ProjectStore({ projectsRoot, statePath });
  const userStore = new UserStore({
    statePath: join(projectsRoot, '.users.json'),
    guestProjectsRoot,
  });
  const owner = userStore.getOwner();
  const tokenStore = new TokenStore({
    statePath: join(projectsRoot, '.tokens.json'),
  });
  const deviceStore = new DeviceStore({
    statePath: join(projectsRoot, '.devices.json'),
    ownerId: owner.id,
  });
  const { sessionId } = deviceStore.__seedActiveDevice('test-device');
  return {
    projectsRoot,
    guestProjectsRoot,
    projectStore,
    deviceStore,
    userStore,
    tokenStore,
    owner,
    demoCwd: join(projectsRoot, 'demo'),
    authCookie: `ccanywhere_session=${sessionId}`,
    sessionId,
    createLimitedUserWithToken: (username, opts = {}) => {
      const user = userStore.createLimitedUser({
        username,
        costLimitUsd: opts.costLimitUsd === undefined ? 10 : opts.costLimitUsd,
        tokensLimit: opts.tokensLimit === undefined ? null : opts.tokensLimit,
      });
      const { token, plaintext } = tokenStore.issue({
        userId: user.id,
        ttlMs: opts.ttlMs ?? 24 * 60 * 60 * 1000,
      });
      return {
        user,
        token,
        plaintext,
        authCookie: `ccanywhere_session=${plaintext}`,
      };
    },
    cleanup: () => {
      rmSync(projectsRoot, { recursive: true, force: true });
      rmSync(guestProjectsRoot, { recursive: true, force: true });
    },
  };
}
