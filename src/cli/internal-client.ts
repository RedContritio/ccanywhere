import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defaultConfigPath, loadConfig } from '../config/loader.js';

export interface InternalClientConfig {
  readonly baseUrl: string;
  readonly token: string;
}

/**
 * Loads the CLI's connection info from disk:
 * - host:port from the same config.json the server uses.
 * - cliToken from ~/.config/ccanywhere/cli-token (written by `serve`).
 *
 * Throws with a hopefully-actionable message if either is missing — the
 * subcommands (approve / devices / revoke) bail out via process.exit(2).
 */
export function loadInternalClientConfig(): InternalClientConfig {
  const config = loadConfig(defaultConfigPath());
  const tokenPath = join(homedir(), '.config', 'ccanywhere', 'cli-token');
  if (!existsSync(tokenPath)) {
    throw new Error(
      `cli-token not found at ${tokenPath} — start \`ccanywhere serve\` once first to generate it`,
    );
  }
  const token = readFileSync(tokenPath, 'utf8').trim();
  if (token.length < 16) {
    throw new Error(`cli-token at ${tokenPath} is malformed (too short)`);
  }
  return {
    baseUrl: `http://${config.bindHost}:${config.port}`,
    token,
  };
}

export interface InternalClient {
  readonly cfg: InternalClientConfig;
  readonly fetch: (path: string, init?: RequestInit) => Promise<Response>;
}

export function makeInternalClient(cfg: InternalClientConfig = loadInternalClientConfig()): InternalClient {
  return {
    cfg,
    fetch: (path, init = {}) => {
      // Only attach content-type when we actually send a body. Fastify 5
      // rejects POST/DELETE with `application/json` header but empty body
      // (FST_ERR_CTP_EMPTY_JSON_BODY) — the CLI POSTs approve / revoke
      // without a body, so leaving the header off lets fastify skip JSON
      // body parsing entirely.
      const callerHeaders = (init.headers ?? {}) as Record<string, string>;
      const headers: Record<string, string> = {
        Authorization: `Bearer ${cfg.token}`,
        ...callerHeaders,
      };
      if (init.body != null && headers['content-type'] === undefined) {
        headers['content-type'] = 'application/json';
      }
      return fetch(`${cfg.baseUrl}${path}`, { ...init, headers });
    },
  };
}
