import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Playwright globalSetup for ccanywhere e2e.
 *
 * Strategy:
 * 1. Resolve cliToken + ccanywhere internal host from
 *    `~/.config/ccanywhere/{config.json, cli-token}` (the same LaunchAgent
 *    instance — internal RPC is only reachable on loopback).
 * 2. Find or create a fixed-username `e2e` limited user via
 *    `/api/internal/users`. Username is reused across runs so the fs
 *    sandbox `<guestProjectsRoot>/e2e/` doesn't accumulate stale dirs;
 *    only the token rotates.
 * 3. Issue a fresh token (ttl 7d) for that user.
 * 4. Write storageState.json that playwright contexts auto-load, planting
 *    `ccanywhere_session=<token-plaintext>` on the prod webOrigin (from
 *    your ccanywhere config.webOrigin — drives the prod frpc / HTTPS path,
 *    no localhost shortcut).
 * 5. Save `{ tokenId }` to teardown.json for globalTeardown to revoke.
 *
 * Playwright BrowserContext cookies are isolated from your real browser,
 * so this never collides with your owner session.
 */

interface CcanywhereConfig {
  readonly bindHost?: string;
  readonly port?: number;
  readonly webOrigin?: string;
  readonly cookieName?: string;
  readonly configDir?: string;
}

interface UserSummary {
  readonly id: string;
  readonly username: string;
  readonly kind: 'owner' | 'limited';
}

interface IssueResp {
  readonly tokenId: string;
  readonly token: string;
  readonly expiresAt: number;
}

const E2E_USERNAME = process.env['CCANYWHERE_E2E_USERNAME'] ?? 'e2e';
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function ccanywhereConfigPath(): string {
  return (
    process.env['CCANYWHERE_TEST_CONFIG'] ??
    join(homedir(), '.config/ccanywhere/config.json')
  );
}

function loadCliToken(configPath: string, config: CcanywhereConfig): string {
  const configDir = config.configDir
    ? resolve(join(configPath, '..'), config.configDir)
    : resolve(configPath, '..');
  const tokenPath = join(configDir, 'cli-token');
  if (!existsSync(tokenPath)) {
    throw new Error(
      `cli-token not found at ${tokenPath} — run \`ccanywhere serve\` once first`,
    );
  }
  return readFileSync(tokenPath, 'utf8').trim();
}

function internalBaseUrl(config: CcanywhereConfig): string {
  return `http://${config.bindHost ?? '127.0.0.1'}:${config.port ?? 62275}`;
}

async function findUser(
  baseUrl: string,
  cliToken: string,
  username: string,
): Promise<UserSummary | null> {
  const res = await fetch(`${baseUrl}/api/internal/users`, {
    headers: { Authorization: `Bearer ${cliToken}` },
  });
  if (!res.ok) {
    throw new Error(`GET /api/internal/users failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { users: UserSummary[] };
  return body.users.find((u) => u.username === username) ?? null;
}

async function createUser(
  baseUrl: string,
  cliToken: string,
  username: string,
): Promise<{ userId: string; token: string; tokenId: string }> {
  const res = await fetch(`${baseUrl}/api/internal/users`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cliToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      username,
      ttlMs: TOKEN_TTL_MS,
      quota: { cost: { limitUsd: 100 } },
    }),
  });
  if (!res.ok) {
    throw new Error(`POST /api/internal/users failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as {
    user: { id: string };
    tokenId: string;
    token: string;
  };
  return { userId: body.user.id, token: body.token, tokenId: body.tokenId };
}

async function issueToken(
  baseUrl: string,
  cliToken: string,
  userId: string,
): Promise<IssueResp> {
  const res = await fetch(`${baseUrl}/api/internal/tokens`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cliToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ userId, ttlMs: TOKEN_TTL_MS, label: 'playwright' }),
  });
  if (!res.ok) {
    throw new Error(`POST /api/internal/tokens failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as IssueResp;
}

export default async function globalSetup(): Promise<void> {
  const configPath = ccanywhereConfigPath();
  if (!existsSync(configPath)) {
    throw new Error(`ccanywhere config not found at ${configPath}`);
  }
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as CcanywhereConfig;
  const cliToken = loadCliToken(configPath, config);
  const baseUrl = internalBaseUrl(config);

  const existing = await findUser(baseUrl, cliToken, E2E_USERNAME);
  let token: string;
  let tokenId: string;
  let expiresAt: number;
  if (existing === null) {
    const created = await createUser(baseUrl, cliToken, E2E_USERNAME);
    token = created.token;
    tokenId = created.tokenId;
    expiresAt = Date.now() + TOKEN_TTL_MS;
  } else {
    const issued = await issueToken(baseUrl, cliToken, existing.id);
    token = issued.token;
    tokenId = issued.tokenId;
    expiresAt = issued.expiresAt;
  }

  const webOrigin = config.webOrigin;
  if (webOrigin === undefined) {
    throw new Error('ccanywhere config.webOrigin must be set for e2e');
  }
  const cookieName = config.cookieName ?? 'ccanywhere_session';
  const url = new URL(webOrigin);
  const isSecure = url.protocol === 'https:';

  const authDir = resolve(__dirname, '..', '.auth');
  if (!existsSync(authDir)) mkdirSync(authDir, { recursive: true });

  writeFileSync(
    join(authDir, 'storageState.json'),
    JSON.stringify(
      {
        cookies: [
          {
            name: cookieName,
            value: token,
            domain: url.hostname,
            path: '/',
            expires: Math.floor(expiresAt / 1000),
            httpOnly: true,
            secure: isSecure,
            sameSite: 'Lax',
          },
        ],
        origins: [],
      },
      null,
      2,
    ),
  );

  writeFileSync(
    join(authDir, 'teardown.json'),
    JSON.stringify({ baseUrl, cliToken, tokenId }, null, 2),
    { mode: 0o600 },
  );

  // eslint-disable-next-line no-console
  console.log(
    `[e2e] storageState planted at ${webOrigin}; user=${E2E_USERNAME} tokenId=${tokenId}`,
  );
}
