import { stdout } from 'node:process';
import { makeInternalClient } from './internal-client.js';

interface UserRecord {
  id: string;
  username: string;
  kind: 'owner' | 'limited';
  createdAt: number;
  lastLoginAt: number | null;
  quota?: {
    cost: { limitUsd: number | null; usedUsd: number };
    tokens: { limit: number | null; used: number };
  };
}

export interface UserCreateOpts {
  username: string;
  ttlMs: number;
  costLimitUsd: number | null;
  tokensLimit: number | null;
}

export interface UserQuotaSetOpts {
  username: string;
  costLimitUsd?: number | null;
  tokensLimit?: number | null;
  reset?: boolean;
}

export async function runUserCreate(
  configPath: string | undefined,
  opts: UserCreateOpts,
): Promise<void> {
  const client = makeInternalClient(configPath);
  const res = await client.fetch('/api/internal/users', {
    method: 'POST',
    body: JSON.stringify({
      username: opts.username,
      ttlMs: opts.ttlMs,
      quota: {
        cost: { limitUsd: opts.costLimitUsd },
        tokens: { limit: opts.tokensLimit },
      },
    }),
  });
  if (!res.ok) {
    stdout.write(`create user failed: ${res.status} ${await res.text()}\n`);
    process.exit(1);
  }
  const body = (await res.json()) as {
    user: { username: string; kind: string };
    token: string;
    expiresAt: number;
  };
  stdout.write(
    `user: ${body.user.username} (${body.user.kind})\n` +
      `token: ${body.token}\n` +
      `expiresAt: ${new Date(body.expiresAt).toISOString()}\n`,
  );
}

export async function runUserList(configPath: string | undefined): Promise<void> {
  const client = makeInternalClient(configPath);
  const res = await client.fetch('/api/internal/users');
  if (!res.ok) {
    stdout.write(`list users failed: ${res.status} ${await res.text()}\n`);
    process.exit(1);
  }
  const { users } = (await res.json()) as { users: UserRecord[] };
  for (const u of users) {
    const quota =
      u.quota === undefined
        ? ''
        : `cost=${u.quota.cost.usedUsd.toFixed(2)}/${u.quota.cost.limitUsd ?? '∞'} ` +
          `tokens=${u.quota.tokens.used}/${u.quota.tokens.limit ?? '∞'}`;
    stdout.write(`  ${u.username}\t${u.kind}\t${quota}\n`);
  }
}

export async function runUserQuotaSet(
  configPath: string | undefined,
  opts: UserQuotaSetOpts,
): Promise<void> {
  const client = makeInternalClient(configPath);
  const listRes = await client.fetch('/api/internal/users');
  if (!listRes.ok) {
    stdout.write(`fetch users failed: ${listRes.status}\n`);
    process.exit(1);
  }
  const { users } = (await listRes.json()) as { users: UserRecord[] };
  const user = users.find((u) => u.username === opts.username);
  if (!user) {
    stdout.write(`user not found: ${opts.username}\n`);
    process.exit(1);
  }
  const body: Record<string, unknown> = {};
  if (opts.costLimitUsd !== undefined) body['cost'] = opts.costLimitUsd;
  if (opts.tokensLimit !== undefined) body['tokens'] = opts.tokensLimit;
  if (opts.reset !== undefined) body['reset'] = opts.reset;
  const res = await client.fetch(`/api/internal/users/${user.id}/quota`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    stdout.write(`patch quota failed: ${res.status} ${await res.text()}\n`);
    process.exit(1);
  }
  stdout.write(`updated quota for ${opts.username}\n`);
}

export async function findUserByName(
  configPath: string | undefined,
  username: string,
): Promise<UserRecord | null> {
  const client = makeInternalClient(configPath);
  const res = await client.fetch('/api/internal/users');
  if (!res.ok) return null;
  const { users } = (await res.json()) as { users: UserRecord[] };
  return users.find((u) => u.username === username) ?? null;
}
