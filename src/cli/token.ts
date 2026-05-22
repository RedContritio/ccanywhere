import { stdout } from 'node:process';
import { makeInternalClient } from './internal-client.js';
import { findUserByName } from './user.js';

interface TokenRecord {
  id: string;
  userId: string;
  label: string | null;
  createdAt: number;
  expiresAt: number;
  status: 'active' | 'revoked';
}

export interface TokenIssueOpts {
  username: string;
  ttlMs: number;
  label?: string | null;
}

export async function runTokenIssue(
  configPath: string | undefined,
  opts: TokenIssueOpts,
): Promise<void> {
  const user = await findUserByName(configPath, opts.username);
  if (!user) {
    stdout.write(`user not found: ${opts.username}\n`);
    process.exit(1);
  }
  const client = makeInternalClient(configPath);
  const res = await client.fetch('/api/internal/tokens', {
    method: 'POST',
    body: JSON.stringify({
      userId: user.id,
      ttlMs: opts.ttlMs,
      ...(opts.label !== undefined && opts.label !== null ? { label: opts.label } : {}),
    }),
  });
  if (!res.ok) {
    stdout.write(`issue token failed: ${res.status} ${await res.text()}\n`);
    process.exit(1);
  }
  const body = (await res.json()) as { token: string };
  stdout.write(`${body.token}\n`);
}

export async function runTokenList(
  configPath: string | undefined,
  username?: string,
): Promise<void> {
  let qs = '';
  if (username !== undefined) {
    const user = await findUserByName(configPath, username);
    if (!user) {
      stdout.write(`user not found: ${username}\n`);
      process.exit(1);
    }
    qs = `?userId=${encodeURIComponent(user.id)}`;
  }
  const client = makeInternalClient(configPath);
  const res = await client.fetch(`/api/internal/tokens${qs}`);
  if (!res.ok) {
    stdout.write(`list tokens failed: ${res.status} ${await res.text()}\n`);
    process.exit(1);
  }
  const { tokens } = (await res.json()) as { tokens: TokenRecord[] };
  for (const t of tokens) {
    const expires = new Date(t.expiresAt).toISOString();
    stdout.write(
      `  ${t.id.slice(0, 8)}…\tuser=${t.userId.slice(0, 8)}…\t${t.status}\texpires=${expires}\n`,
    );
  }
}

export async function runTokenRevoke(
  configPath: string | undefined,
  tokenId: string,
): Promise<void> {
  const client = makeInternalClient(configPath);
  const res = await client.fetch(`/api/internal/tokens/${tokenId}`, { method: 'DELETE' });
  if (!res.ok) {
    stdout.write(`revoke failed: ${res.status} ${await res.text()}\n`);
    process.exit(1);
  }
  stdout.write(`revoked: ${tokenId}\n`);
}
