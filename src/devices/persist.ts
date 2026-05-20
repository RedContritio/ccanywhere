import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Device, Session } from './types.js';

export interface PersistedState {
  readonly devices: ReadonlyArray<Device>;
  readonly sessions: ReadonlyArray<Session>;
}

/** Returns null when the state file is absent or unreadable; corrupt JSON
 * yields an empty state (best-effort recovery, callers stay running). */
export function loadPersistedState(statePath: string): PersistedState | null {
  if (!existsSync(statePath)) return null;
  let raw: string;
  try {
    raw = readFileSync(statePath, 'utf8');
  } catch {
    return null;
  }
  let parsed: Partial<PersistedState>;
  try {
    parsed = JSON.parse(raw) as Partial<PersistedState>;
  } catch {
    return { devices: [], sessions: [] };
  }
  return {
    devices: Array.isArray(parsed.devices)
      ? parsed.devices.filter((d): d is Device => typeof d?.id === 'string')
      : [],
    sessions: Array.isArray(parsed.sessions)
      ? parsed.sessions.filter((s): s is Session => typeof s?.sessionId === 'string')
      : [],
  };
}

export function savePersistedState(statePath: string, state: PersistedState): void {
  const dir = dirname(statePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
}
