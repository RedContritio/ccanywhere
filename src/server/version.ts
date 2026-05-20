import { execSync } from 'node:child_process';

let cached: string | null = null;

export function getCommitSha(): string {
  if (cached !== null) return cached;
  const fromEnv = process.env['GIT_SHA'];
  if (typeof fromEnv === 'string' && fromEnv.length > 0) {
    cached = fromEnv.slice(0, 12);
    return cached;
  }
  try {
    const out = execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    cached = out.length > 0 ? out.slice(0, 12) : 'unknown';
  } catch {
    cached = 'unknown';
  }
  return cached;
}

export function resetCommitShaForTest(): void {
  cached = null;
}
