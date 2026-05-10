import { createInterface, type Interface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { makeInternalClient } from './internal-client.js';

interface PendingPair {
  pendingId: string;
  label: string;
  createdAt: number;
  remoteAddr: string | null;
  userAgent: string | null;
}

async function ask(rl: Interface, question: string): Promise<string> {
  return (await rl.question(question)).trim();
}

function fmtAge(epochMs: number): string {
  const sec = Math.max(0, Math.round((Date.now() - epochMs) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  return `${Math.round(sec / 3600)}h ago`;
}

export async function runApprove(configPath?: string): Promise<void> {
  const client = makeInternalClient(configPath);
  const res = await client.fetch('/api/internal/pending');
  if (!res.ok) {
    stdout.write(`fetch /api/internal/pending failed: ${res.status} ${await res.text()}\n`);
    process.exit(1);
  }
  const { pending } = (await res.json()) as { pending: PendingPair[] };
  if (pending.length === 0) {
    stdout.write('no pending pair requests.\n');
    return;
  }

  stdout.write('pending pair requests:\n');
  for (const [i, p] of pending.entries()) {
    stdout.write(
      `  [${i + 1}] ${p.label}\n` +
        `      from ${p.remoteAddr ?? '?'} — ${p.userAgent ?? '?'}\n` +
        `      created ${fmtAge(p.createdAt)}\n`,
    );
  }
  stdout.write('\n');

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const sel = await ask(rl, 'review which (number, "all", or empty to abort): ');
    if (sel.length === 0) {
      stdout.write('aborted.\n');
      return;
    }

    const targets: PendingPair[] =
      sel === 'all'
        ? pending
        : (() => {
            const idx = Number.parseInt(sel, 10);
            if (Number.isNaN(idx) || idx < 1 || idx > pending.length) {
              stdout.write(`invalid selection: ${sel}\n`);
              process.exit(1);
            }
            return [pending[idx - 1]!];
          })();

    for (const p of targets) {
      const ans = await ask(rl, `approve "${p.label}" (from ${p.remoteAddr ?? '?'})? [y/N] `);
      if (ans.toLowerCase() !== 'y' && ans.toLowerCase() !== 'yes') {
        stdout.write(`  skipped: ${p.label}\n`);
        continue;
      }
      const r = await client.fetch(`/api/internal/pending/${p.pendingId}/approve`, {
        method: 'POST',
      });
      if (!r.ok) {
        stdout.write(`  approve failed for ${p.label}: ${r.status} ${await r.text()}\n`);
        continue;
      }
      const body = (await r.json()) as { deviceId: string; label: string };
      stdout.write(`  approved: ${body.label} → device ${body.deviceId}\n`);
    }
  } finally {
    rl.close();
  }
}
