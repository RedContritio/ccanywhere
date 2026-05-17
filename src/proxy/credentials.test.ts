import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CredentialsError,
  loadOwnerCredentials,
} from './credentials.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ccanywhere-creds-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeCredsFile(content: string, mode: number = 0o600): string {
  const p = join(dir, 'anthropic-credentials.json');
  writeFileSync(p, content, { mode });
  chmodSync(p, mode); // 兜底 umask 影响
  return p;
}

describe('loadOwnerCredentials', () => {
  it('returns missing when file does not exist', () => {
    const p = join(dir, 'nope.json');
    const r = loadOwnerCredentials(p);
    expect(r.kind).toBe('missing');
  });

  it('loads apiKey from valid 0600 file', () => {
    const p = writeCredsFile(JSON.stringify({ apiKey: 'sk-ant-xyz' }));
    const r = loadOwnerCredentials(p);
    expect(r.kind).toBe('loaded');
    if (r.kind === 'loaded') {
      expect(r.credentials.apiKey).toBe('sk-ant-xyz');
    }
  });

  it('rejects file with wider perms (e.g. 0644)', () => {
    const p = writeCredsFile(JSON.stringify({ apiKey: 'sk-ant-xyz' }), 0o644);
    expect(() => loadOwnerCredentials(p)).toThrow(CredentialsError);
    expect(() => loadOwnerCredentials(p)).toThrow(/mode 0600/);
  });

  it('rejects malformed JSON', () => {
    const p = writeCredsFile('{ this is not json');
    expect(() => loadOwnerCredentials(p)).toThrow(CredentialsError);
    expect(() => loadOwnerCredentials(p)).toThrow(/not valid JSON/);
  });

  it('rejects missing apiKey field', () => {
    const p = writeCredsFile(JSON.stringify({ other: 'val' }));
    expect(() => loadOwnerCredentials(p)).toThrow(/missing required field/);
  });

  it('rejects empty apiKey', () => {
    const p = writeCredsFile(JSON.stringify({ apiKey: '' }));
    expect(() => loadOwnerCredentials(p)).toThrow(/non-empty/);
  });

  it('rejects non-string apiKey', () => {
    const p = writeCredsFile(JSON.stringify({ apiKey: 12345 }));
    expect(() => loadOwnerCredentials(p)).toThrow(/non-empty string/);
  });
});
