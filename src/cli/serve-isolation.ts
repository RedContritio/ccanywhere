import type { Config } from '../config/schema.js';
import { logger } from '../log.js';
import type { IsolationStatus } from '../server/server.js';

export interface IsolationResolution {
  /** Subset reported via /healthz (JSON-serializable). */
  readonly status: IsolationStatus;
  /**
   * Effective per-user runtime after isolationPolicy override applied
   * (D4 host-only → all non-owner 'host'; otherwise per-user config or
   * default). Lookup by username; missing key = 'host' (owner or
   * unknown user). sessions.ts uses this for spawn dispatch (C5).
   */
  readonly perUserRuntime: ReadonlyMap<string, 'host' | 'shared-container'>;
}

export interface ResolveIsolationOpts {
  /**
   * When true, non-owner `runtime: 'shared-container'` no longer
   * fatals but flows into perUserRuntime map. Default false keeps
   * the fail-safe (fatal on container config). serve.ts sets true
   * after docker-detect passes AND container deps are wired.
   */
  readonly sharedContainerReady?: boolean;
}

/**
 * Validate config.isolationPolicy + per-user runtime + emit boot
 * banner. Fatal-exits when owner != host, or when strict + container
 * runtime configured without sharedContainerReady. Returns
 * IsolationResolution: status snapshot for /healthz + per-user
 * runtime map for sessions.ts dispatch.
 *
 * Exported so unit tests can drive it without spinning up the full
 * serve loop.
 */
export function resolveIsolation(
  config: Config,
  ownerUsername: string,
  opts: ResolveIsolationOpts = {},
): IsolationResolution {
  const policy = config.isolationPolicy;
  const users = config.users ?? {};
  const sharedReady = opts.sharedContainerReady ?? false;

  // Owner MUST be host. Schema default is 'host' so admin who
  // doesn't list owner at all (common in existing prod) passes
  // silently. We only reject when admin explicitly set owner.runtime
  // to a non-host value.
  const ownerCfg = users[ownerUsername];
  // runtime may be undefined here when callers bypass schema parse and
  // build Config objects by hand (tests, future programmatic uses).
  // In normal prod loadConfig path, zod default fills 'host' already.
  if (
    ownerCfg !== undefined &&
    ownerCfg.runtime !== undefined &&
    ownerCfg.runtime !== 'host'
  ) {
    logger.fatal(
      { ownerUsername, configured: ownerCfg.runtime },
      `users.${ownerUsername}.runtime: '${ownerCfg.runtime}' invalid — ` +
        `owner MUST be 'host'. Remove the field or set to 'host'.`,
    );
    process.exit(2);
  }

  // host-only mode → override all non-owner runtime to host;
  // explicit per-user container configs become audit-logged ignores.
  if (policy === 'host-only') {
    const ignored: string[] = [];
    const map = new Map<string, 'host'>();
    for (const [username, userCfg] of Object.entries(users)) {
      if (username === ownerUsername) continue;
      if (userCfg.runtime !== 'host') {
        ignored.push(`${username}=${userCfg.runtime}`);
      }
      map.set(username, 'host');
    }
    if (ignored.length > 0) {
      logger.warn(
        { ignored },
        `isolationPolicy: host-only — per-user runtime overrides ` +
          `ignored: ${ignored.join(', ')}`,
      );
    }
    logIsolationBanner(policy, users, ownerUsername, 'host-only');
    return {
      status: { mode: 'host-only', ready: true },
      perUserRuntime: map,
    };
  }

  // strict / fallback + any non-owner shared-container.
  // - sharedContainerReady=true: non-fatal; runtime enters
  //   perUserRuntime map for sessions.ts dispatch
  // - sharedContainerReady=false: fatal (avoid silent fallback to
  //   host hiding the isolation gap)
  //
  // Treat undefined runtime as 'shared-container' (schema default):
  // existing multi-user prod config without explicit runtime fatals
  // on startup; admin must edit config to declare runtime: 'host' or
  // switch to host-only.
  const perUserRuntime = new Map<string, 'host' | 'shared-container'>();
  for (const [username, userCfg] of Object.entries(users)) {
    if (username === ownerUsername) continue;
    const runtime = userCfg.runtime ?? 'shared-container';
    if (runtime === 'shared-container') {
      if (!sharedReady) {
        logger.fatal(
          { username, runtime: userCfg.runtime },
          `users.${username}.runtime: ` +
            `${userCfg.runtime === undefined ? '<unset, default shared-container>' : `'${userCfg.runtime}'`} ` +
            `but container runtime not ready. ` +
            `Fix: set users.${username}.runtime: 'host' OR ` +
            `top-level isolationPolicy: 'host-only' to override all.`,
        );
        process.exit(2);
      }
      // workspace override + shared-container not supported (override
      // path is outside the container workspace mount, project cwd
      // can't be translated). Caller must use 'host' runtime.
      if (userCfg.workspace !== undefined) {
        logger.fatal(
          { username, workspace: userCfg.workspace },
          `users.${username}: workspace override + runtime: ` +
            `'shared-container' not supported. Remove the workspace ` +
            `override OR switch runtime to 'host'.`,
        );
        process.exit(2);
      }
      perUserRuntime.set(username, 'shared-container');
    } else {
      perUserRuntime.set(username, 'host');
    }
    // 'isolated-container' rejected at schema parse.
  }

  logIsolationBanner(policy, users, ownerUsername, 'all-host');
  return {
    status: { mode: policy, ready: true },
    perUserRuntime,
  };
}

function logIsolationBanner(
  policy: 'strict' | 'fallback' | 'host-only',
  users: Record<
    string,
    {
      workspace?: string | undefined;
      runtime: 'host' | 'shared-container' | 'isolated-container';
    }
  >,
  ownerUsername: string,
  effective: 'all-host' | 'host-only',
): void {
  const nonOwnerCount = Object.keys(users).filter(
    (u) => u !== ownerUsername,
  ).length;
  const hostTotal = 1 + nonOwnerCount;
  const suffix =
    effective === 'host-only' ? ' (host-only override active)' : '';
  logger.info(
    {
      isolationPolicy: policy,
      effective,
      hostUsers: hostTotal,
      ownerUsername,
    },
    `isolation: ${policy} mode, ${hostTotal} user(s) on host${suffix}`,
  );
}
