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
   * m-user-shared-container C5: when true, D5 unlocks — non-owner
   * `runtime: 'shared-container'` no longer fatals but flows into
   * perUserRuntime map. Default false keeps Phase 1.B behavior (fatal
   * on container config). serve.ts sets true after docker-detect
   * passes AND container deps are wired.
   */
  readonly sharedContainerReady?: boolean;
}

/**
 * m-user-runtime-schema. Validate config.isolationPolicy + per-user
 * runtime + emit boot banner. Fatal-exits on D3 (owner != host) or D5
 * (strict + container runtime configured without sharedContainerReady).
 * Returns IsolationResolution: status snapshot for /healthz + per-user
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

  // D3: owner MUST be host. Schema default is 'host' so admin who
  // doesn't list owner at all (common in既有 prod) passes silently.
  // We only reject when admin explicitly set owner.runtime to a
  // non-host value.
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
        `owner MUST be 'host' (D3 m-user-runtime-schema). Remove the ` +
        `field or set to 'host'.`,
    );
    process.exit(2);
  }

  // D4: host-only mode → override all non-owner runtime to host;
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

  // D5: strict / fallback + any non-owner shared-container.
  // - sharedContainerReady=true (C5 wire): non-fatal; runtime enters
  //   perUserRuntime map for sessions.ts dispatch
  // - sharedContainerReady=false (Phase 1.B default): fatal (避免
  //   silent fallback to host hiding isolation gap)
  //
  // Treat undefined runtime as 'shared-container' (schema default):
  // 既有 multi-user prod config 没显式配 runtime 启动 fatal (D2
  // amendment); 走 ccanywhere schema bump 同步流程, admin 编辑
  // config 显式声明 runtime: 'host' 或切 host-only.
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
            `but container runtime is Phase 2 (m-user-shared-container) — ` +
            `not ready. Fix: set users.${username}.runtime: 'host' OR ` +
            `top-level isolationPolicy: 'host-only' to override all.`,
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
