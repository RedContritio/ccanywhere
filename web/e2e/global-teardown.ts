import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface TeardownState {
  readonly baseUrl: string;
  readonly cliToken: string;
  readonly tokenId: string;
}

export default async function globalTeardown(): Promise<void> {
  const authDir = resolve(__dirname, '..', '.auth');
  const teardownPath = join(authDir, 'teardown.json');
  if (!existsSync(teardownPath)) return;

  const state = JSON.parse(readFileSync(teardownPath, 'utf8')) as TeardownState;

  try {
    const res = await fetch(`${state.baseUrl}/api/internal/tokens/${state.tokenId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${state.cliToken}` },
    });
    if (!res.ok && res.status !== 404) {
      // eslint-disable-next-line no-console
      console.warn(`[e2e] token revoke returned ${res.status}; leaving teardown.json for debug`);
      return;
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[e2e] token revoke failed: ${err instanceof Error ? err.message : err}`);
    return;
  }

  // Best-effort cleanup; storageState removal is optional but prevents the
  // next run from accidentally using a revoked cookie (globalSetup would
  // overwrite anyway).
  rmSync(teardownPath, { force: true });
  rmSync(join(authDir, 'storageState.json'), { force: true });
}
