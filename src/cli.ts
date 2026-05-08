#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
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

  const manager = new SessionManager();
  const internalHookToken = randomBytes(32).toString('hex');

  const app = await buildServer({ config, manager, internalHookToken });

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    await app.close();
    await manager.killAll();
    process.exit(0);
  };
  process.on('SIGINT', (s) => void shutdown(s));
  process.on('SIGTERM', (s) => void shutdown(s));

  await app.listen({ host: config.bindHost, port: config.port });
  logger.info(
    {
      configPath,
      bind: `${config.bindHost}:${config.port}`,
      projects: config.projects.length,
      tokens: config.tokens.length,
    },
    'ccanywhere listening',
  );
}

void main().catch((err: unknown) => {
  logger.fatal({ err }, 'fatal startup error');
  process.exit(1);
});
