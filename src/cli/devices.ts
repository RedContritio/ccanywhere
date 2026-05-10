import { stdout } from 'node:process';
import { makeInternalClient } from './internal-client.js';

interface DeviceSummary {
  id: string;
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
  status: 'active' | 'revoked';
}

function fmtTs(epochMs: number | null): string {
  if (epochMs === null) return 'never';
  return new Date(epochMs).toISOString();
}

export async function runDevices(configPath?: string): Promise<void> {
  const client = makeInternalClient(configPath);
  const res = await client.fetch('/api/internal/devices');
  if (!res.ok) {
    stdout.write(`fetch /api/internal/devices failed: ${res.status} ${await res.text()}\n`);
    process.exit(1);
  }
  const { devices } = (await res.json()) as { devices: DeviceSummary[] };
  if (devices.length === 0) {
    stdout.write('no devices registered.\n');
    return;
  }
  stdout.write('id                                    status   created                  last used                label\n');
  stdout.write('----                                  ------   -------                  ---------                -----\n');
  for (const d of devices) {
    stdout.write(
      `${d.id}  ${d.status.padEnd(7)}  ${fmtTs(d.createdAt)}  ${fmtTs(d.lastUsedAt).padEnd(24)} ${d.label}\n`,
    );
  }
}
