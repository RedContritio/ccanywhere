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
    projectsRoot: '/tmp/projects-root',
    guestProjectsRoot: '/tmp/guest-projects-root',
    webOrigin: 'http://localhost:62275',
  };

  it('loads a valid config and applies defaults', () => {
    write(validBase);
    const cfg = loadConfig(path);
    expect(cfg.port).toBe(62275);
    expect(cfg.bindHost).toBe('127.0.0.1');
    expect(cfg.claudeBin).toBe('claude');
    expect(cfg.projectsRoot).toBe('/tmp/projects-root');
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

  it('rejects missing projectsRoot', () => {
    write({ webOrigin: validBase.webOrigin });
    expect(() => loadConfig(path)).toThrow(/projectsRoot/);
  });

  it('rejects empty projectsRoot', () => {
    write({ ...validBase, projectsRoot: '' });
    expect(() => loadConfig(path)).toThrow(/projectsRoot/);
  });

  it('rejects missing webOrigin', () => {
    write({ projectsRoot: validBase.projectsRoot });
    expect(() => loadConfig(path)).toThrow(/webOrigin/);
  });

  it('rejects non-URL webOrigin', () => {
    write({ ...validBase, webOrigin: 'not-a-url' });
    expect(() => loadConfig(path)).toThrow(/webOrigin/);
  });

  it('rejects missing guestProjectsRoot', () => {
    write({ projectsRoot: validBase.projectsRoot, webOrigin: validBase.webOrigin });
    expect(() => loadConfig(path)).toThrow(/guestProjectsRoot/);
  });

  it('rejects guestProjectsRoot equal to projectsRoot', () => {
    write({ ...validBase, guestProjectsRoot: validBase.projectsRoot });
    expect(() => loadConfig(path)).toThrow(/must differ/);
  });

  it('rejects guestProjectsRoot nested under projectsRoot', () => {
    write({ ...validBase, guestProjectsRoot: '/tmp/projects-root/guests' });
    expect(() => loadConfig(path)).toThrow(/must not nest/);
  });

  it('rejects projectsRoot nested under guestProjectsRoot', () => {
    write({
      projectsRoot: '/tmp/guest-projects-root/owned',
      guestProjectsRoot: '/tmp/guest-projects-root',
      webOrigin: validBase.webOrigin,
    });
    expect(() => loadConfig(path)).toThrow(/must not nest/);
  });
});
