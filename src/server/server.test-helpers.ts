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
  // Placeholder: each describe block creates a real tmp workspace + ProjectStore;
  // buildServer reads from projectStore, not config.workspace. Tests that
  // exercise multi-user cwd guard MUST override `workspace` to the tmp dir
  // in `TestProjectsEnv`.
  workspace: '/tmp/ccanywhere-test-placeholder',
  webOrigin: 'http://localhost:7878',
  cookieName: 'ccanywhere_session',
};

export interface UserWithToken {
  readonly user: User;
  readonly token: Token;
  readonly plaintext: string;
  readonly authCookie: string;
}

export interface CreateUserOpts {
  readonly costLimitUsd?: number | null;
  readonly tokensLimit?: number | null;
  readonly ttlMs?: number;
}

export interface TestProjectsEnv {
  workspace: string;
  /** owner ProjectStore root (legacy "projectsRoot"); lives at <workspace>/owner/. */
  ownerProjectsRoot: string;
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
  /** Create a user + active token; default ttl 24h, costLimitUsd 10. */
  createUserWithToken: (
    username: string,
    opts?: CreateUserOpts,
  ) => UserWithToken;
  cleanup: () => void;
}

export function setupProjects(): TestProjectsEnv {
  // m-user-symmetric: workspace 是所有 user 项目根的父目录。owner 走默认
  // <workspace>/owner/，便于测试覆盖默认路径解析。
  const workspace = mkdtempSync(join(tmpdir(), 'ccanywhere-workspace-'));
  const ownerProjectsRoot = join(workspace, 'owner');
  mkdirSync(ownerProjectsRoot);
  mkdirSync(join(ownerProjectsRoot, 'demo'));
  const statePath = join(ownerProjectsRoot, '.projects-state.json');
  const projectStore = new ProjectStore({ projectsRoot: ownerProjectsRoot, statePath });
  const userStore = new UserStore({
    statePath: join(workspace, '.users.json'),
    workspace,
  });
  const owner = userStore.getOwner();
  const tokenStore = new TokenStore({
    statePath: join(workspace, '.tokens.json'),
  });
  const deviceStore = new DeviceStore({
    statePath: join(workspace, '.devices.json'),
    ownerId: owner.id,
  });
  const { sessionId } = deviceStore.__seedActiveDevice('test-device');
  return {
    workspace,
    ownerProjectsRoot,
    projectStore,
    deviceStore,
    userStore,
    tokenStore,
    owner,
    demoCwd: join(ownerProjectsRoot, 'demo'),
    authCookie: `ccanywhere_session=${sessionId}`,
    sessionId,
    createUserWithToken: (username, opts = {}) => {
      const user = userStore.createUser({
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
      rmSync(workspace, { recursive: true, force: true });
    },
  };
}
