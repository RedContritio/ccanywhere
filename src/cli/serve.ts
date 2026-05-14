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

  const projectsRoot = resolve(config.projectsRoot);
  let writable = false;
  try {
    ({ writable } = ensureProjectsRoot(projectsRoot));
  } catch (err) {
    if (err instanceof ProjectStoreError) {
      logger.fatal(err.message);
      process.exit(2);
    }
    throw err;
  }
  if (!writable) {
    logger.warn(
      { projectsRoot },
      'projectsRoot is read-only — list/select projects work, but creating new projects will fail',
    );
  }

  const guestProjectsRoot = resolve(config.guestProjectsRoot);
  mkdirSync(guestProjectsRoot, { recursive: true, mode: 0o700 });

  const projectStore = new ProjectStore({
    projectsRoot,
    statePath: join(configDir, 'projects-state.json'),
  });
  // m-multi-user dependency note: UserStore MUST init before DeviceStore.
  // DeviceStore step-2 改造将让老 device record fallback userId=ownerUser.id；
  // 而 ownerUser 在 UserStore constructor 内 ensureOwner() 时创建。
  const userStore = new UserStore({
    statePath: join(configDir, 'users.json'),
    guestProjectsRoot,
  });
  const tokenStore = new TokenStore({
    statePath: join(configDir, 'tokens.json'),
  });
  const deviceStore = new DeviceStore({
    statePath: join(configDir, 'devices.json'),
    ownerId: userStore.getOwner().id,
  });
  const cliToken = ensureCliToken(configDir);

  // m-pricing-staleness-sentinel (B7): one-line warn at boot if the
  // hardcoded Anthropic pricing table is >180 days unverified. Side
  // effect only — priceFor() still returns the table.
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

  // m-session-persistence: hardcode <configDir>/sessions/ per D9. Boot
  // synchronously loads previously-persisted session metadata + last
  // screen snapshots into dead-stub map so list/Resume work from frame 0.
  const sessionRegistry = new SessionRegistry(join(configDir, 'sessions'));
  const manager = new SessionManager({
    deletedSessionTtlMs: config.deletedSessionTtlMs,
    registry: sessionRegistry,
  });
  manager.loadDeadStubs();

  // m-share-static-export: sweep expired snapshots at boot (per D6 lazy
  // GC). loadAllSync's side effect unlinks any record whose expiresAt
  // is past — we don't capture the return because the route handlers
  // re-read fresh.
  const shareStore = new ShareStore(join(configDir, 'shares'));
  shareStore.loadAllSync();

  const internalHookToken = randomBytes(32).toString('hex');

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
  });

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    await app.close();
    // m-session-persistence: actively kill PTYs in-process. Earlier
    // attempt relied on the OS SIGHUP'ing the children after our exit,
    // but by then the JS event loop is gone and `pty.onExit` never
    // fires — last-screen snapshots were silently dropped. killAll()
    // here awaits each PTY's exit (which fires handleSessionExit →
    // queues snapshot writes); detach() then drains pendingWrites so
    // the metadata is durable before process.exit.
    await manager.killAll();
    await manager.detach();
    process.exit(0);
  };
  process.on('SIGINT', (s) => void shutdown(s));
  process.on('SIGTERM', (s) => void shutdown(s));

  await app.listen({ host: config.bindHost, port: config.port });
  const addr = app.server.address();
  const actualPort =
    addr !== null && typeof addr !== 'string' ? (addr as AddressInfo).port : config.port;
  logger.info(
    {
      configPath,
      bind: `${config.bindHost}:${actualPort}`,
      projectsRoot,
      projects: projectStore.list().length,
      devices: deviceStore.listDevices().length,
      internalHookToken,
    },
    'ccanywhere listening (paste internalHookToken into ~/.claude/settings.json hooks)',
  );
}
