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

  it('rejects when both apiKey and oauthToken missing', () => {
    const p = writeCredsFile(JSON.stringify({ other: 'val' }));
    expect(() => loadOwnerCredentials(p)).toThrow(/requires.*apiKey.*oauthToken/);
  });

  it('rejects empty apiKey + no oauthToken', () => {
    const p = writeCredsFile(JSON.stringify({ apiKey: '' }));
    expect(() => loadOwnerCredentials(p)).toThrow(/requires.*apiKey.*oauthToken/);
  });

  it('loads oauthToken-only (subscription path)', () => {
    const p = writeCredsFile(JSON.stringify({ oauthToken: 'sk-ant-oat-xyz' }));
    const r = loadOwnerCredentials(p);
    expect(r.kind).toBe('loaded');
    if (r.kind === 'loaded') {
      expect(r.credentials.oauthToken).toBe('sk-ant-oat-xyz');
      expect(r.credentials.apiKey).toBeUndefined();
    }
  });

  it('loads both when both present (forward 优先 oauthToken)', () => {
    const p = writeCredsFile(
      JSON.stringify({ apiKey: 'sk-ant-x', oauthToken: 'sk-ant-oat-y' }),
    );
    const r = loadOwnerCredentials(p);
    expect(r.kind).toBe('loaded');
    if (r.kind === 'loaded') {
      expect(r.credentials.apiKey).toBe('sk-ant-x');
      expect(r.credentials.oauthToken).toBe('sk-ant-oat-y');
    }
  });
});
