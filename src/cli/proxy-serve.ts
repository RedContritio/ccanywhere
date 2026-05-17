import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { ConfigError, defaultConfigPath, loadConfig } from '../config/loader.js';
import { logger } from '../log.js';
import {
  CredentialsError,
  defaultCredentialsPath,
  loadOwnerCredentials,
  type OwnerCredentials,
} from '../proxy/credentials.js';
import { RedactSelfTestError, runRedactSelfTest } from '../proxy/log-redact.js';
import { buildProxyServer } from '../proxy/server.js';

export async function runProxySubcommand(
  args: string[],
  configPath: string | undefined,
): Promise<void> {
  const sub = args.shift();
  if (sub === 'serve') return runProxyServe(configPath);
  process.stdout.write(`unknown proxy subcommand: ${sub ?? '(missing)'}\n`);
  process.exit(2);
}

export async function runProxyServe(configPathArg?: string): Promise<void> {
  // 1. config
  const configPath =
    configPathArg !== undefined ? resolve(configPathArg) : defaultConfigPath();
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

  // 2. redact self-test (D4). Boot-time safety net — refuse to bind any
  // listener if a known secret could leak in logs.
  try {
    await runRedactSelfTest();
    logger.info('redact self-test passed');
  } catch (err) {
    if (err instanceof RedactSelfTestError) {
      logger.fatal(err.message);
      process.exit(2);
    }
    throw err;
  }

  // 3. credentials (D5). Missing → 503 mode; bad perm / malformed → fatal.
  const credsPath = defaultCredentialsPath();
  let credentials: OwnerCredentials | null = null;
  try {
    const result = loadOwnerCredentials(credsPath);
    if (result.kind === 'missing') {
      logger.warn(
        { credsPath },
        'anthropic credentials missing — proxy starts in 503 mode; ' +
          'all forward routes will reject until credentials are configured',
      );
    } else {
      credentials = result.credentials;
      logger.info({ credsPath }, 'owner credentials loaded');
    }
  } catch (err) {
    if (err instanceof CredentialsError) {
      logger.fatal(err.message);
      process.exit(2);
    }
    throw err;
  }

  // 4. build + listen
  const app = await buildProxyServer({ credentials });

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    logger.info({ signal }, 'proxy shutting down');
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', (s) => void shutdown(s));
  process.on('SIGTERM', (s) => void shutdown(s));

  await app.listen({
    host: config.proxy.bindHost,
    port: config.proxy.port,
  });
  const addr = app.server.address();
  const actualPort =
    addr !== null && typeof addr !== 'string'
      ? (addr as AddressInfo).port
      : config.proxy.port;
  logger.info(
    {
      configPath,
      bind: `${config.proxy.bindHost}:${actualPort}`,
      mode: credentials === null ? 'degraded' : 'ready',
    },
    'ccanywhere-anthropic-proxy listening',
  );
}
