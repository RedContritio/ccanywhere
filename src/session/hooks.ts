import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface HookEndpoint {
  readonly host: string;
  readonly port: number;
  readonly internalToken: string;
}

const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'SubagentStop',
] as const;

export function buildHookSettings(sessionId: string, ep: HookEndpoint): {
  hooks: Record<string, Array<{ hooks: Array<{ type: 'command'; command: string }> }>>;
} {
  const url = (event: string): string =>
    `http://${ep.host}:${ep.port}/api/hook/${encodeURIComponent(sessionId)}/${event}`;
  const hooks: Record<string, Array<{ hooks: Array<{ type: 'command'; command: string }> }>> = {};
  for (const event of HOOK_EVENTS) {
    const cmd = `curl -fsS -m 2 -X POST -H "Authorization: Bearer ${ep.internalToken}" "${url(event)}" >/dev/null 2>&1 || true`;
    hooks[event] = [
      {
        hooks: [{ type: 'command', command: cmd }],
      },
    ];
  }
  return { hooks };
}

export function createHookConfigDir(sessionId: string, ep: HookEndpoint): string {
  const idTag = sessionId.slice(0, 8) || 'sess';
  const dir = mkdtempSync(join(tmpdir(), `ccanywhere-hook-${idTag}-`));
  const settings = buildHookSettings(sessionId, ep);
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings, null, 2));
  return dir;
}

export function cleanupHookConfigDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup; never throw on shutdown path
  }
}
