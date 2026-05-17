import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

export class CredentialsError extends Error {
  constructor(message: string, public readonly path: string) {
    super(`${message} (credentials: ${path})`);
    this.name = 'CredentialsError';
  }
}

export interface OwnerCredentials {
  readonly apiKey: string;
}

export type LoadResult =
  | { readonly kind: 'loaded'; readonly credentials: OwnerCredentials }
  | { readonly kind: 'missing' };

export function defaultCredentialsPath(): string {
  const fromEnv = process.env['CCANYWHERE_PROXY_CREDENTIALS'];
  if (fromEnv) return resolve(fromEnv);
  const xdg = process.env['XDG_CONFIG_HOME'];
  const base = xdg ?? `${homedir()}/.config`;
  return resolve(base, 'ccanywhere', 'anthropic-credentials.json');
}

/**
 * Load owner's Anthropic API credentials from a 0600 JSON file.
 *
 * - missing → returns `{ kind: 'missing' }` so the proxy can start in
 *   "503 mode" (D5: owner can configure later without proxy crash-loop)
 * - perm wider than 0600 → CredentialsError (refuse to load a key file
 *   that any other local user could read)
 * - malformed JSON / missing apiKey → CredentialsError
 */
export function loadOwnerCredentials(path: string): LoadResult {
  let stat;
  try {
    stat = statSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'missing' };
    }
    throw new CredentialsError(
      `failed to stat credentials file: ${(err as Error).message}`,
      path,
    );
  }

  // Enforce 0600 (owner rw only). On macOS Keychain-mode this file is
  // typically unused, but if present, perms matter.
  const mode = stat.mode & 0o777;
  if (mode !== 0o600) {
    throw new CredentialsError(
      `credentials file must be mode 0600 (found 0${mode.toString(8)}); ` +
        `run: chmod 600 ${path}`,
      path,
    );
  }

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new CredentialsError(
      `failed to read credentials: ${(err as Error).message}`,
      path,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CredentialsError(
      `credentials is not valid JSON: ${(err as Error).message}`,
      path,
    );
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { apiKey?: unknown }).apiKey !== 'string' ||
    (parsed as { apiKey: string }).apiKey.length === 0
  ) {
    throw new CredentialsError(
      `credentials JSON missing required field "apiKey" (non-empty string)`,
      path,
    );
  }

  return {
    kind: 'loaded',
    credentials: { apiKey: (parsed as { apiKey: string }).apiKey },
  };
}
