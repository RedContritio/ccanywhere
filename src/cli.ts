#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { ConfigError, defaultConfigPath, loadConfig } from './config/loader.js';
import { logger } from './log.js';
import { buildServer } from './server/server.js';
import { SessionManager } from './session/manager.js';

async function main(): Promise<void> {
  const configPath = defaultConfigPath();
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

  const manager = new SessionManager({
    deletedSessionTtlMs: config.deletedSessionTtlMs,
  });
  // Internal token for the /api/hook/* receiver. cc subprocesses do NOT
  // receive this automatically (M-hook-opt-in); users opt in by pasting
  // a hook block into ~/.claude/settings.json — see buildHookSettings()
  // and docs/deployment.md.
  const internalHookToken = randomBytes(32).toString('hex');

  const app = await buildServer({
    config,
    manager,
    internalHookToken,
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
      projects: config.projects.length,
      tokens: config.tokens.length,
      internalHookToken,
    },
    'ccanywhere listening (paste internalHookToken into ~/.claude/settings.json hooks)',
  );
}

void main().catch((err: unknown) => {
  logger.fatal({ err }, 'fatal startup error');
  process.exit(1);
});
