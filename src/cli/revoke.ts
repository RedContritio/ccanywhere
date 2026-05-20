import { stdout } from 'node:process';
import { makeInternalClient } from './internal-client.js';

export async function runRevoke(
  deviceId: string | undefined,
  configPath?: string,
): Promise<void> {
  if (typeof deviceId !== 'string' || deviceId.length === 0) {
    stdout.write('usage: ccanywhere revoke <device-id>\n');
    stdout.write('       (run `ccanywhere devices` first to find the id)\n');
    process.exit(2);
  }
  const client = makeInternalClient(configPath);
  const res = await client.fetch(`/api/internal/devices/${encodeURIComponent(deviceId)}`, {
    method: 'DELETE',
  });
  if (res.status === 204) {
    stdout.write(`revoked device ${deviceId}.\n`);
    return;
  }
  if (res.status === 404) {
    stdout.write(`device ${deviceId} not found or already revoked.\n`);
    process.exit(1);
  }
  stdout.write(`revoke failed: ${res.status} ${await res.text()}\n`);
  process.exit(1);
}
