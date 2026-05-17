import type { Config } from '../config/schema.js';
import { logger } from '../log.js';
import type { IsolationStatus } from '../server/server.js';

/**
 * m-user-runtime-schema. Validate config.isolationPolicy + per-user
 * runtime + emit boot banner. Fatal-exits on D3 (owner != host) or D5
 * (strict + container runtime configured). Returns IsolationStatus
 * snapshot for /healthz exposure.
 *
 * Exported so unit tests can drive it without spinning up the full
 * serve loop.
 */
export function resolveIsolation(
  config: Config,
  ownerUsername: string,
): IsolationStatus {
  const policy = config.isolationPolicy;
  const users = config.users ?? {};

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
    for (const [username, userCfg] of Object.entries(users)) {
      if (username === ownerUsername) continue;
      if (userCfg.runtime !== 'host') {
        ignored.push(`${username}=${userCfg.runtime}`);
      }
    }
    if (ignored.length > 0) {
      logger.warn(
        { ignored },
        `isolationPolicy: host-only — per-user runtime overrides ` +
          `ignored: ${ignored.join(', ')}`,
      );
    }
    logIsolationBanner(policy, users, ownerUsername, 'host-only');
    return { mode: 'host-only', ready: true };
  }

  // D5: strict / fallback + any non-owner shared-container → fatal.
  // Phase 2 m-user-shared-container ships actual container spawn; until
  // then, silent fallback to host would hide the isolation gap. Fail
  // loud so admin notices.
  //
  // Treat undefined runtime as 'shared-container' (schema default):
  // 既有 multi-user prod config 没显式配 runtime 启动也 fatal, 走
  // ccanywhere schema bump 同步流程 (admin 看到 fatal → 编辑
  // config 显式声明 runtime: 'host' 或切 host-only). D2 amendment.
  for (const [username, userCfg] of Object.entries(users)) {
    if (username === ownerUsername) continue;
    const runtime = userCfg.runtime ?? 'shared-container';
    if (runtime === 'shared-container') {
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
    // 'host' OK; 'isolated-container' rejected at schema parse.
  }

  logIsolationBanner(policy, users, ownerUsername, 'all-host');
  return { mode: policy, ready: true };
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
