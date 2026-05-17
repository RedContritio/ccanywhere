import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { ConfigError, defaultConfigPath, loadConfig } from '../config/loader.js';
import { resolveConfigDir } from '../config/paths.js';
import { logger } from '../log.js';
import {
  CredentialsError,
  defaultCredentialsPath,
  loadOwnerCredentials,
  type OwnerCredentials,
} from '../proxy/credentials.js';
import { RedactSelfTestError, runRedactSelfTest } from '../proxy/log-redact.js';
import { FileUsageStore } from '../proxy/quota-store.js';
import { buildProxyServer, type ForwardOptions } from '../proxy/server.js';
import { TokenIssuer } from '../proxy/tokens.js';

export async function runProxySubcommand(
  args: string[],
  configPath: string | undefined,
): Promise<void> {
  const sub = args.shift();
  if (sub === 'serve') return runProxyServe(configPath);
  process.stdout.write(`unknown proxy subcommand: ${sub ?? '(missing)'}\n`);
  process.exit(2);
}

export function ensureProxyTokenSecret(path: string): Buffer {
  if (existsSync(path)) {
    const raw = readFileSync(path);
    if (raw.length >= 32) return raw;
    logger.warn(
      { path, len: raw.length },
      'proxy-token-secret too short (<32 bytes), regenerating',
    );
  }
  const secret = randomBytes(32);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, secret, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // best-effort
  }
  return secret;
}

interface UsersFileShape {
  users: Array<{
    id: string;
    quota?: { cost?: { limitUsd?: number | null } };
  }>;
}

/**
 * Sync read of users.json on every quota check. Phase 1 chooses
 * decoupled-from-UserStore over performance: ccanywhere CLI can update
 * limits without proxy restart. File is small (KB), read latency
 * negligible vs upstream API roundtrip. BACKLOG follow-up
 * m-proxy-quota-sync: lru cache + fs.watch invalidation when traffic
 * scales (Phase 2 user containers).
 */
function makeLimitLookup(
  usersPath: string,
): (userId: string) => number | null | undefined {
  return (userId: string) => {
    if (!existsSync(usersPath)) return undefined;
    try {
      const data = JSON.parse(readFileSync(usersPath, 'utf8')) as UsersFileShape;
      const u = data.users.find((entry) => entry.id === userId);
      if (u === undefined) return undefined;
      return u.quota?.cost?.limitUsd ?? null;
    } catch {
      return undefined;
    }
  };
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

  // 4. forward deps (wire only when credentials loaded — degraded mode
  // skips). statePath / token-secret 都落到 configDir 跟主 server 状态
  // 同处但独立文件，避免误共享。
  let forward: ForwardOptions | undefined;
  if (credentials !== null) {
    const configDir = resolveConfigDir(config, configPath);
    const tokenSecret = ensureProxyTokenSecret(
      join(configDir, 'proxy-token-secret'),
    );
    const tokenIssuer = new TokenIssuer({ secret: tokenSecret });
    const limitOf = makeLimitLookup(join(configDir, 'users.json'));
    const usageStore = new FileUsageStore({
      statePath: join(configDir, 'proxy-usage.json'),
      limitOf,
    });
    forward = {
      tokenIssuer,
      usageStore,
      addUsage: (userId, costUsd) => usageStore.addUsage(userId, costUsd),
    };
  }

  // 5. build + listen
  const app = await buildProxyServer({
    credentials,
    ...(forward !== undefined ? { forward } : {}),
  });

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
