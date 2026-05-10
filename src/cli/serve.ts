import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { ConfigError, defaultConfigPath, loadConfig } from '../config/loader.js';
import { resolveConfigDir } from '../config/paths.js';
import { DeviceStore } from '../devices/store.js';
import { logger } from '../log.js';
import { ProjectStore, ProjectStoreError, ensureProjectsRoot } from '../projects/store.js';
import { buildServer } from '../server/server.js';
import { SessionManager } from '../session/manager.js';

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

  const projectStore = new ProjectStore({
    projectsRoot,
    statePath: join(configDir, 'projects-state.json'),
  });
  const deviceStore = new DeviceStore({
    statePath: join(configDir, 'devices.json'),
  });
  const cliToken = ensureCliToken(configDir);

  const manager = new SessionManager({
    deletedSessionTtlMs: config.deletedSessionTtlMs,
  });
  const internalHookToken = randomBytes(32).toString('hex');

  const app = await buildServer({
    config,
    configDir,
    manager,
    projectStore,
    deviceStore,
    internalHookToken,
    cliToken,
  });

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    await app.close();
    await manager.killAll();
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
