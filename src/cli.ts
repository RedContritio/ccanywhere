#!/usr/bin/env node
import { ConfigError, defaultConfigPath, loadConfig } from './config/loader.js';
import { logger } from './log.js';

function main(): void {
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

  logger.info(
    {
      configPath,
      bind: `${config.bindHost}:${config.port}`,
      projects: config.projects.length,
      tokens: config.tokens.length,
    },
    'ccanywhere started (M1 stub — server not yet wired)',
  );
}

main();
