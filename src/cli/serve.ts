import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { ConfigError, defaultConfigPath, loadConfig } from '../config/loader.js';
import { resolveConfigDir } from '../config/paths.js';
import { DeviceStore } from '../devices/store.js';
import { logger } from '../log.js';
import { ProjectStore, ProjectStoreError, ensureProjectsRoot } from '../projects/store.js';
import { QuotaPathError, runStartupSanityCheck } from '../quota/path.js';
import { maybePricingStaleWarn } from '../quota/pricing.js';
import { buildServer } from '../server/server.js';
import { SessionManager } from '../session/manager.js';
import { SessionRegistry } from '../session/registry.js';
import { ShareStore } from '../share/store.js';
import { TokenStore } from '../tokens/store.js';
import { UserStore } from '../users/store.js';
import { initContainerStack } from './container-init.js';
import { startProxyCohost } from './proxy-cohost.js';
import { resolveIsolation } from './serve-isolation.js';

/**
 * Read the cliToken from `<configDir>/cli-token`, or create one if
 * missing. The CLI subcommands (approve / devices / revoke) read the same
 * file (looked up via the same configDir) to authenticate against
 * `/api/internal/*`.
 */
function ensureCliToken(configDir: string): string {
  const path = join(configDir, 'cli-token');
  if (existsSync(path)) {
    const v = readFileSync(path, 'utf8').trim();
    if (v.length >= 16) return v;
  }
  const v = randomBytes(32).toString('hex');
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${v}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort.
  }
  return v;
}

export async function runServe(configPathArg?: string): Promise<void> {
  const configPath = configPathArg !== undefined ? resolve(configPathArg) : defaultConfigPath();
  let config;
  try {
    config = loadConfig(configPath);
  } catch (err) {
    if (err instanceof ConfigError) {
      logger.fatal(err.message);
      process.exit(2);
    }
    throw err;
  }
  const configDir = resolveConfigDir(config, configPath);

  // workspace 是所有 user 项目根的父目录。每 user 默认
  // 走 <workspace>/<username>/，可通过 users.<username>.workspace 显式
  // override。owner 的 username 不是字面 'owner'——prod 实例可能用任何
  // 合法 username（首次 ensureOwner 默认 'owner'，但允许手动改）。
  const workspace = resolve(config.workspace);
  mkdirSync(workspace, { recursive: true, mode: 0o700 });

  // per-user `~/.claude` state root.
  // Single bind mount into shared container (`/var/lib/ccanywhere/
  // user-claude:rw`); per-user sub-dirs created on-demand by
  // ContainerUserSync.ensureUser. Default falls under configDir so an
  // unconfigured deployment Just Works (no schema bump required).
  const userClaudeRoot = resolve(
    config.userClaudeRoot ?? join(configDir, 'user-claude'),
  );
  mkdirSync(userClaudeRoot, { recursive: true, mode: 0o755 });

  // UserStore 要先构造以拿到 owner.username（ensureOwner 触发后），再
  // 算 owner 项目根。后续 DeviceStore 依赖 owner.id 也由这一步提供。
  const userStore = new UserStore({
    statePath: join(configDir, 'users.json'),
    workspace,
    userOverrides: config.users,
  });
  const ownerUser = userStore.getOwner();
  const ownerOverrideKey = `users.${ownerUser.username}.workspace`;
  const ownerOverride = config.users?.[ownerUser.username]?.workspace;
  if (ownerOverride === undefined) {
    logger.warn(
      { defaultRoot: join(workspace, ownerUser.username) },
      `owner 未配 \`${ownerOverrideKey}\` — owner 项目根走默认 ` +
        `<workspace>/${ownerUser.username}。如需指向其他目录（例如已有的项目` +
        `仓库），在 config 设 \`${ownerOverrideKey}: "<abs path>"\`。`,
    );
  }
  const ownerProjectsRoot = userStore.projectsRootFor(ownerUser);

  let writable = false;
  try {
    ({ writable } = ensureProjectsRoot(ownerProjectsRoot));
  } catch (err) {
    if (err instanceof ProjectStoreError) {
      logger.fatal(err.message);
      process.exit(2);
    }
    throw err;
  }
  if (!writable) {
    logger.warn(
      { ownerProjectsRoot },
      'owner projects root is read-only — list/select projects work, but creating new projects will fail',
    );
  }

  const projectStore = new ProjectStore({
    projectsRoot: ownerProjectsRoot,
    statePath: join(configDir, 'projects-state.json'),
  });
  const tokenStore = new TokenStore({
    statePath: join(configDir, 'tokens.json'),
  });
  const deviceStore = new DeviceStore({
    statePath: join(configDir, 'devices.json'),
    ownerId: userStore.getOwner().id,
  });
  const cliToken = ensureCliToken(configDir);

  // one-line warn at boot if the
  // hardcoded Anthropic pricing table is >180 days unverified. Side
  // effect only — priceFor still returns the table.
  maybePricingStaleWarn(new Date(), (msg) => logger.warn(msg));

  // #46 quota: verify ccJsonlPathOf matches cc CLI's path encoding before
  // we accept the first request. Empty projects dir → skip + warn (new
  // install). Encoding drift → fatal exit so the operator notices.
  try {
    runStartupSanityCheck({
      logger: {
        info: (msg) => logger.info(msg),
        warn: (msg) => logger.warn(msg),
      },
    });
  } catch (err) {
    if (err instanceof QuotaPathError) {
      logger.fatal(err.message);
      process.exit(2);
    }
    throw err;
  }

  // hardcode <configDir>/sessions/ per. Boot
  // synchronously loads previously-persisted session metadata + last
  // screen snapshots into dead-stub map so list/Resume work from frame 0.
  const sessionRegistry = new SessionRegistry(join(configDir, 'sessions'));
  const manager = new SessionManager({
    deletedSessionTtlMs: config.deletedSessionTtlMs,
    registry: sessionRegistry,
  });
  manager.loadDeadStubs();

  // sweep expired snapshots at boot (lazy GC). loadAllSync's side effect
  // unlinks any record whose expiresAt is past — we don't capture the
  // return because the route handlers re-read fresh.
  const shareStore = new ShareStore(join(configDir, 'shares'));
  shareStore.loadAllSync();

  const internalHookToken = randomBytes(32).toString('hex');

  // ccanywhere main spawns the anthropic proxy as a sub-process so
  // deployment of `ccanywhere` LaunchAgent covers proxy too. Independent
  // OS process (blast radius保留: credentials file read happens only in
  // the proxy child, never in main). Supervisor handles crash respawn with
  // backoff + give-up after consecutive failures so a broken proxy
  // doesn't death-loop.
  const cliBinPath = process.argv[1];
  if (cliBinPath === undefined) {
    logger.fatal('cannot resolve cli entry path (process.argv[1]) for proxy cohost');
    process.exit(2);
  }
  const proxyLogPath = join(configDir, 'proxy.log');
  const proxyCohost = startProxyCohost({
    cliBinPath,
    configPath,
    logPath: proxyLogPath,
  });
  logger.info({ proxyLogPath }, 'proxy cohost spawned');

  // docker detect + shared container
  // ensureRunning + ContainerUserSync + TokenIssuer init. Returns
  // sharedContainerReady flag for resolveIsolation decision +
  // containerDeps for buildServer + shutdown hook for SIGTERM.
  const containerInit = await initContainerStack(config, configDir, userClaudeRoot);

  // Resolve isolation policy + per-user runtime
  // BEFORE building the server (fatal on bad config; ready snapshot
  // exposed via /healthz). Owner / strict-container / host-only
  // all decide here. s sharedContainerReady from
  // containerInit so unlocks when container deps are ready.
  const { status: isolation, perUserRuntime } = resolveIsolation(
    config,
    ownerUser.username,
    { sharedContainerReady: containerInit.sharedContainerReady },
  );

  const app = await buildServer({
    config,
    configDir,
    manager,
    projectStore,
    deviceStore,
    userStore,
    tokenStore,
    shareStore,
    internalHookToken,
    cliToken,
    isolation,
    perUserRuntime,
    userClaudeRoot,
    ...(containerInit.containerDeps !== undefined
      ? { containerDeps: containerInit.containerDeps }
      : {}),
  });

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    await app.close();
    // actively kill PTYs in-process. Earlier
    // attempt relied on the OS SIGHUP'ing the children after our exit,
    // but by then the JS event loop is gone and `pty.onExit` never
    // fires — last-screen snapshots were silently dropped. killAll
    // here awaits each PTY's exit (which fires handleSessionExit →
    // queues snapshot writes); detach then drains pendingWrites so
    // the metadata is durable before process.exit.
    await manager.killAll();
    await manager.detach();
    // stop shared container (idempotent).
    await containerInit.shutdown();
    // stop proxy cohost (SIGTERM →
    // grace → SIGKILL). Final step so proxy serves any in-flight
    // bearer/forward requests until container/users are torn down.
    await proxyCohost.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', (s) => void shutdown(s));
  process.on('SIGTERM', (s) => void shutdown(s));

  void isolation; // referenced by buildServer above; keep var live
  void perUserRuntime; // ditto — d into sessions.ts via buildServer

  await app.listen({ host: config.bindHost, port: config.port });
  const addr = app.server.address();
  const actualPort =
    addr !== null && typeof addr !== 'string' ? (addr as AddressInfo).port : config.port;
  logger.info(
    {
      configPath,
      bind: `${config.bindHost}:${actualPort}`,
      workspace,
      ownerProjectsRoot,
      projects: projectStore.list().length,
      devices: deviceStore.listDevices().length,
      internalHookToken,
    },
    'ccanywhere listening (paste internalHookToken into ~/.claude/settings.json hooks)',
  );
}
