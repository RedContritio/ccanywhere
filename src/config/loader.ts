import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { ConfigSchema, type Config } from './schema.js';

export class ConfigError extends Error {
  constructor(
    message: string,
    public readonly path: string,
  ) {
    super(`${message} (config: ${path})`);
    this.name = 'ConfigError';
  }
}

export function defaultConfigPath(): string {
  const fromEnv = process.env['CCANYWHERE_CONFIG'];
  if (fromEnv) return resolve(fromEnv);
  const xdg = process.env['XDG_CONFIG_HOME'];
  const base = xdg ?? `${homedir()}/.config`;
  return resolve(base, 'ccanywhere', 'config.json');
}

export function loadConfig(path: string = defaultConfigPath()): Config {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ConfigError('config file not found', path);
    }
    throw new ConfigError(`failed to read config: ${(err as Error).message}`, path);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`config is not valid JSON: ${(err as Error).message}`, path);
  }

  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new ConfigError(`config validation failed:\n${issues}`, path);
  }

  return result.data;
}
