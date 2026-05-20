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

  // m-user-symmetric: workspace replaces projectsRoot + guestProjectsRoot.
  const validBase = {
    workspace: '/tmp/ccanywhere-workspace',
    webOrigin: 'http://localhost:62275',
  };

  it('loads a valid config and applies defaults', () => {
    write(validBase);
    const cfg = loadConfig(path);
    expect(cfg.port).toBe(62275);
    expect(cfg.bindHost).toBe('127.0.0.1');
    expect(cfg.claudeBin).toBe('claude');
    expect(cfg.workspace).toBe('/tmp/ccanywhere-workspace');
    expect(cfg.webOrigin).toBe('http://localhost:62275');
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

  it('default outputFps is 60', () => {
    write(validBase);
    const cfg = loadConfig(path);
    expect(cfg.outputFps).toBe(60);
  });

  it('accepts custom outputFps', () => {
    write({ ...validBase, outputFps: 24 });
    const cfg = loadConfig(path);
    expect(cfg.outputFps).toBe(24);
  });

  it('rejects outputFps below 1', () => {
    write({ ...validBase, outputFps: 0 });
    expect(() => loadConfig(path)).toThrow(/outputFps/);
  });

  it('rejects outputFps above 240', () => {
    write({ ...validBase, outputFps: 999 });
    expect(() => loadConfig(path)).toThrow(/outputFps/);
  });

  it('throws ConfigError when file is missing', () => {
    expect(() => loadConfig(join(dir, 'missing.json'))).toThrow(ConfigError);
  });

  it('throws ConfigError on invalid JSON', () => {
    writeFileSync(path, '{ not json');
    expect(() => loadConfig(path)).toThrow(/not valid JSON/);
  });

  it('rejects missing workspace', () => {
    write({ webOrigin: validBase.webOrigin });
    expect(() => loadConfig(path)).toThrow(/workspace/);
  });

  it('rejects empty workspace', () => {
    write({ ...validBase, workspace: '' });
    expect(() => loadConfig(path)).toThrow(/workspace/);
  });

  it('rejects missing webOrigin', () => {
    write({ workspace: validBase.workspace });
    expect(() => loadConfig(path)).toThrow(/webOrigin/);
  });

  it('rejects non-URL webOrigin', () => {
    write({ ...validBase, webOrigin: 'not-a-url' });
    expect(() => loadConfig(path)).toThrow(/webOrigin/);
  });

  describe('users.<name>.workspace override (m-user-symmetric)', () => {
    it('accepts owner override pointing at an existing project tree', () => {
      const ownerWorkspace = join(tmpdir(), 'projects');
      write({
        ...validBase,
        users: { owner: { workspace: ownerWorkspace } },
      });
      const cfg = loadConfig(path);
      expect(cfg.users?.['owner']?.workspace).toBe(ownerWorkspace);
    });

    it('rejects relative path override', () => {
      write({
        ...validBase,
        users: { alice: { workspace: 'relative/path' } },
      });
      expect(() => loadConfig(path)).toThrow(/absolute path/);
    });

    it('rejects override pointing inside another user default slot', () => {
      // <workspace>/bob is bob's default root; alice overriding into it
      // would shadow bob's lazy mkdir.
      write({
        ...validBase,
        users: {
          alice: { workspace: '/tmp/ccanywhere-workspace/bob' },
        },
      });
      expect(() => loadConfig(path)).toThrow(/shadow that user's default root/);
    });

    it('rejects two overrides nesting each other', () => {
      write({
        ...validBase,
        users: {
          alice: { workspace: '/tmp/host/a' },
          bob: { workspace: '/tmp/host/a/b' },
        },
      });
      expect(() => loadConfig(path)).toThrow(/MUST NOT nest/);
    });

    it('accepts overrides that are siblings outside workspace', () => {
      write({
        ...validBase,
        users: {
          alice: { workspace: '/tmp/host/alice' },
          bob: { workspace: '/tmp/host/bob' },
        },
      });
      const cfg = loadConfig(path);
      expect(cfg.users?.['alice']?.workspace).toBe('/tmp/host/alice');
      expect(cfg.users?.['bob']?.workspace).toBe('/tmp/host/bob');
    });

    it('tolerates self-pinning override (override = default slot for the same user)', () => {
      // Redundant but harmless; we accept rather than reject.
      write({
        ...validBase,
        users: {
          alice: { workspace: '/tmp/ccanywhere-workspace/alice' },
        },
      });
      const cfg = loadConfig(path);
      expect(cfg.users?.['alice']?.workspace).toBe('/tmp/ccanywhere-workspace/alice');
    });
  });
});
