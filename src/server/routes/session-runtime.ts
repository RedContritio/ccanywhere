import { join, relative } from 'node:path';
import type { ContainerUserSync } from '../../container/user-sync.js';
import type { TokenIssuer } from '../../proxy/tokens.js';
import type { User } from '../../users/types.js';

/**
 * Shared between sessions.ts + sessions-resume.ts. cc reads COLORFGBG
 * when its `theme` setting is `"auto"` to pick dark vs light. Format
 * `<fg>;<bg>`; bg=0 → dark, bg=15 → light.
 */
export function buildThemeEnv(
  webTheme: 'dark' | 'light' | undefined,
): Record<string, string> {
  if (webTheme === undefined) return {};
  return webTheme === 'dark'
    ? { COLORFGBG: '15;0' }
    : { COLORFGBG: '0;15' };
}

/**
 * m-user-shared-container C5: deps required to spawn user sessions
 * inside the shared container. Optional in BuildServerOptions — when
 * absent, ALL user.runtime overrides degrade to host (per-user runtime
 * map already enforces host via resolveIsolation).
 */
export interface SessionContainerDeps {
  /** name of the long-running shared container (per ccanywhere instance) */
  readonly containerName: string;
  readonly userSync: ContainerUserSync;
  readonly tokenIssuer: TokenIssuer;
  /**
   * URL the user container's claude reaches the anthropic proxy at;
   * typically `http://host.docker.internal:62276`. Container's
   * `ANTHROPIC_BASE_URL` env points here.
   */
  readonly proxyBaseUrl: string;
  /**
   * D9 amendment: absolute host path of `config.workspace`. mounted
   * 1:1 into the container at `containerWorkspacePath` so project
   * cwds resolve. session-runtime translates host project.cwd into
   * container path via this prefix.
   */
  readonly hostWorkspace: string;
  /**
   * D9 amendment: container-internal mount point of hostWorkspace.
   * Typically `/workspace`. Set by container-init alongside the
   * `docker run -v <hostWorkspace>:<containerWorkspacePath>` arg.
   */
  readonly containerWorkspacePath: string;
  /**
   * m-host-credentials-share D3: container-internal mount point of the
   * host `userClaudeRoot` (typically `/var/lib/ccanywhere/user-claude`).
   * Per-spawn `CLAUDE_CONFIG_DIR` is set to `<root>/<username>` so cc
   * finds per-user jsonl history + settings.json + CLAUDE.md.
   * ContainerUserSync.ensureUser is responsible for mkdir + chown +
   * chmod 0700 on the per-user sub-dir.
   */
  readonly userClaudeContainerRoot: string;
  /**
   * m-host-credentials-share D10: owner's `CLAUDE_CODE_OAUTH_TOKEN`
   * (sk-ant-oat-...) injected per-spawn so container cc binary connects
   * to anthropic directly (anthropic 2026-02 policy bans third-party
   * OAuth Bearer proxies). Required for shared-container path; absence
   * means user spawn can't reach anthropic (D6 trust model accepts
   * token visibility in container env).
   */
  readonly ownerOauthToken: string | undefined;
}

export interface SessionRuntimeOverlay {
  readonly runtime?: 'host' | 'shared-container';
  readonly container?: {
    readonly name: string;
    readonly unixUser: string;
    /** D9 amendment: -w <path> for docker exec; container-internal cwd */
    readonly workingDir?: string;
  };
  readonly env?: Record<string, string>;
  /**
   * m-host-credentials-share: spawn `command` override. container path
   * sets this to the container-internal claude binary (`claude` on PATH,
   * installed via `npm install -g @anthropic-ai/claude-code` in the
   * image) so spawn doesn't try to exec the host `config.claudeBin`
   * path inside the container.
   */
  readonly command?: string;
}

/**
 * Decide SpawnOptions overlay for a session based on per-user runtime
 * (from IsolationResolution) + container deps availability.
 *
 * - perUserRuntime says 'shared-container' AND deps present: ensure
 *   unix account exists in container + issue short bearer + assemble
 *   env (ANTHROPIC_BASE_URL/AUTH_TOKEN/CLAUDE_CONFIG_DIR + telemetry
 *   off) → return runtime+container+env overlay
 * - else: return overlay with merged baseEnv only (host path, identity
 *   spawn — caller's existing spawn call works as before)
 *
 * Side-effect: when shared-container path, ensureUser may run
 * `useradd` in container on first call per user (idempotent).
 */
export async function buildSessionRuntimeOverlay(
  user: User | undefined,
  perUserRuntime:
    | ReadonlyMap<string, 'host' | 'shared-container'>
    | undefined,
  deps: SessionContainerDeps | undefined,
  baseEnv: Record<string, string>,
  projectCwd?: string,
): Promise<SessionRuntimeOverlay> {
  const effective =
    user !== undefined ? (perUserRuntime?.get(user.username) ?? 'host') : 'host';
  if (effective !== 'shared-container' || deps === undefined || user === undefined) {
    return Object.keys(baseEnv).length > 0 ? { env: { ...baseEnv } } : {};
  }

  // shared-container path: ensure user account + inject env + translate
  // host project.cwd → container working dir (D9).
  //
  // m-host-credentials-share D10: anthropic 2026-02 policy bans third-
  // party Bearer with OAuth subscription token (only cc binary itself
  // is first-party). proxy forward path is dead — container cc must
  // connect directly to anthropic. Inject owner's setup-token via
  // CLAUDE_CODE_OAUTH_TOKEN env (cc-supported, 1-year long-lived).
  // Trust model D6 accepts the token visible inside container env;
  // shared-container deployments require owner-trusted users only.
  await deps.userSync.ensureUser(user.username);
  const env: Record<string, string> = {
    ...baseEnv,
    CLAUDE_CONFIG_DIR: `${deps.userClaudeContainerRoot}/${user.username}`,
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    // 告诉容器内 cc terminal 支持 24-bit truecolor. 默认 docker exec
    // 设 TERM=xterm (16-color), cc 把 brand orange 映射成最近 ANSI
    // red. xterm.js 在 web 端支持 truecolor; COLORTERM=truecolor 让 cc
    // 知道.
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  };
  if (deps.ownerOauthToken !== undefined) {
    env['CLAUDE_CODE_OAUTH_TOKEN'] = deps.ownerOauthToken;
  }

  let workingDir: string | undefined;
  if (projectCwd !== undefined) {
    // host: <hostWorkspace>/<rest> ; container: <containerWorkspacePath>/<rest>
    const rel = relative(deps.hostWorkspace, projectCwd);
    if (!rel.startsWith('..')) {
      workingDir = join(deps.containerWorkspacePath, rel);
    }
    // rel.startsWith('..') means projectCwd is OUTSIDE hostWorkspace (e.g.
    // user with workspace override). serve-isolation rejects this combo
    // at startup, but defensively skip workingDir here so we don't pass
    // a bogus path; container default WORKDIR will at least let claude
    // start.
  }

  return {
    runtime: 'shared-container',
    container: {
      name: deps.containerName,
      unixUser: user.username,
      ...(workingDir !== undefined ? { workingDir } : {}),
    },
    env,
    command: 'claude',
  };
}
