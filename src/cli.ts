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
  const internalHookToken = randomBytes(32).toString('hex');

  let actualPort: number | null = null;
  const app = await buildServer({
    config,
    manager,
    internalHookToken,
    hookEndpoint: () => {
      if (actualPort === null) {
        throw new Error('hook endpoint requested before server started listening');
      }
      return { host: config.bindHost, port: actualPort };
    },
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
  if (addr === null || typeof addr === 'string') {
    throw new Error(`unexpected listen address shape: ${String(addr)}`);
  }
  actualPort = (addr as AddressInfo).port;
  logger.info(
    {
      configPath,
      bind: `${config.bindHost}:${actualPort}`,
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
