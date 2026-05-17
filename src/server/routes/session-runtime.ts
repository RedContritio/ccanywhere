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
}

export interface SessionRuntimeOverlay {
  readonly runtime?: 'host' | 'shared-container';
  readonly container?: { readonly name: string; readonly unixUser: string };
  readonly env?: Record<string, string>;
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
): Promise<SessionRuntimeOverlay> {
  const effective =
    user !== undefined ? (perUserRuntime?.get(user.username) ?? 'host') : 'host';
  if (effective !== 'shared-container' || deps === undefined || user === undefined) {
    return Object.keys(baseEnv).length > 0 ? { env: { ...baseEnv } } : {};
  }

  // shared-container path: ensure user account + issue bearer + env.
  await deps.userSync.ensureUser(user.username);
  const issued = deps.tokenIssuer.issue(user.id);

  const env: Record<string, string> = {
    ...baseEnv,
    ANTHROPIC_BASE_URL: deps.proxyBaseUrl,
    ANTHROPIC_AUTH_TOKEN: issued.token,
    CLAUDE_CONFIG_DIR: `/home/${user.username}/.claude`,
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
  };

  return {
    runtime: 'shared-container',
    container: { name: deps.containerName, unixUser: user.username },
    env,
  };
}
