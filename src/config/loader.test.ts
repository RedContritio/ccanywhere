import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './loader.js';

describe('loadConfig', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ccanywhere-cfg-'));
    path = join(dir, 'config.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(obj: unknown): void {
    writeFileSync(path, JSON.stringify(obj));
  }

  const validBase = {
    tokens: [{ label: 'laptop', token: 'a'.repeat(32) }],
    projects: [{ id: 'demo', name: 'Demo', cwd: '/tmp/demo' }],
  };

  it('loads a valid config and applies defaults', () => {
    write(validBase);
    const cfg = loadConfig(path);
    expect(cfg.port).toBe(62275);
    expect(cfg.bindHost).toBe('127.0.0.1');
    expect(cfg.claudeBin).toBe('claude');
    expect(cfg.tokens).toHaveLength(1);
    expect(cfg.projects[0]?.id).toBe('demo');
    expect(cfg.deletedSessionTtlMs).toBe(600_000);
    expect(cfg.wsHeartbeat.intervalMs).toBe(30_000);
    expect(cfg.wsHeartbeat.timeoutMs).toBe(60_000);
  });

  it('rejects deletedSessionTtlMs below minimum', () => {
    write({ ...validBase, deletedSessionTtlMs: 30_000 });
    expect(() => loadConfig(path)).toThrow(/deletedSessionTtlMs/);
  });

  it('rejects wsHeartbeat with timeoutMs <= intervalMs', () => {
    write({
      ...validBase,
      wsHeartbeat: { intervalMs: 60_000, timeoutMs: 30_000 },
    });
    expect(() => loadConfig(path)).toThrow(/timeoutMs must be strictly greater/);
  });

  it('accepts custom wsHeartbeat values', () => {
    write({
      ...validBase,
      wsHeartbeat: { intervalMs: 5_000, timeoutMs: 12_000 },
    });
    const cfg = loadConfig(path);
    expect(cfg.wsHeartbeat.intervalMs).toBe(5_000);
    expect(cfg.wsHeartbeat.timeoutMs).toBe(12_000);
  });

  it('throws ConfigError when file is missing', () => {
    expect(() => loadConfig(join(dir, 'missing.json'))).toThrow(ConfigError);
  });

  it('throws ConfigError on invalid JSON', () => {
    writeFileSync(path, '{ not json');
    expect(() => loadConfig(path)).toThrow(/not valid JSON/);
  });

  it('rejects empty tokens array', () => {
    write({ ...validBase, tokens: [] });
    expect(() => loadConfig(path)).toThrow(/at least one token/);
  });

  it('rejects empty projects array', () => {
    write({ ...validBase, projects: [] });
    expect(() => loadConfig(path)).toThrow(/at least one project/);
  });

  it('rejects short token', () => {
    write({ ...validBase, tokens: [{ label: 'x', token: 'short' }] });
    expect(() => loadConfig(path)).toThrow(ConfigError);
  });

  it('rejects non-kebab project id', () => {
    write({
      ...validBase,
      projects: [{ id: 'BadId', name: 'X', cwd: '/tmp' }],
    });
    expect(() => loadConfig(path)).toThrow(/kebab-case/);
  });

  it('rejects duplicate project ids', () => {
    write({
      ...validBase,
      projects: [
        { id: 'dup', name: 'A', cwd: '/tmp/a' },
        { id: 'dup', name: 'B', cwd: '/tmp/b' },
      ],
    });
    expect(() => loadConfig(path)).toThrow(/duplicate project id/);
  });

  it('rejects duplicate token values', () => {
    const t = 'a'.repeat(32);
    write({
      ...validBase,
      tokens: [
        { label: 'one', token: t },
        { label: 'two', token: t },
      ],
    });
    expect(() => loadConfig(path)).toThrow(/duplicate token/);
  });
});
