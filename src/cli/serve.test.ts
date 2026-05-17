import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/schema.js';
import { resolveIsolation } from './serve-isolation.js';

function mkConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 7878,
    bindHost: '127.0.0.1',
    claudeBin: 'sh',
    scrollbackBytes: 4096,
    deletedSessionTtlMs: 600_000,
    wsHeartbeat: { intervalMs: 30_000, timeoutMs: 60_000 },
    outputFps: 60,
    workspace: '/tmp/x',
    webOrigin: 'http://localhost:7878',
    cookieName: 'ccanywhere_session',
    proxy: { port: 62276, bindHost: '127.0.0.1' },
    isolationPolicy: 'strict',
    ...overrides,
  };
}

class ExitCalled extends Error {
  constructor(public readonly code: number) {
    super(`process.exit(${code})`);
  }
}

beforeEach(() => {
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitCalled(code ?? 0);
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveIsolation — happy path', () => {
  it('default strict + no users → mode:strict ready:true', () => {
    const r = resolveIsolation(mkConfig(), 'owner');
    expect(r.status).toEqual({ mode: 'strict', ready: true });
  });

  it('strict + non-owner host user → mode:strict ready:true', () => {
    const r = resolveIsolation(
      mkConfig({ users: { alice: { runtime: 'host' } } }),
      'owner',
    );
    expect(r.status).toEqual({ mode: 'strict', ready: true });
  });

  it('fallback policy returned verbatim', () => {
    const r = resolveIsolation(
      mkConfig({ isolationPolicy: 'fallback' }),
      'owner',
    );
    expect(r.status).toEqual({ mode: 'fallback', ready: true });
  });
});

describe('resolveIsolation — D3 owner runtime', () => {
  it('owner not in users field → OK (default behavior)', () => {
    const r = resolveIsolation(mkConfig({ users: {} }), 'owner');
    expect(r.status.ready).toBe(true);
  });

  it('owner with explicit host runtime → OK', () => {
    const r = resolveIsolation(
      mkConfig({
        users: { owner: { workspace: '/tmp/o', runtime: 'host' } },
      }),
      'owner',
    );
    expect(r.status.ready).toBe(true);
  });

  it('owner runtime: shared-container → fatal', () => {
    expect(() =>
      resolveIsolation(
        mkConfig({ users: { owner: { runtime: 'shared-container' } } }),
        'owner',
      ),
    ).toThrow(ExitCalled);
  });

  it('non-owner shared-container also triggers fatal in strict', () => {
    expect(() =>
      resolveIsolation(
        mkConfig({ users: { alice: { runtime: 'shared-container' } } }),
        'owner',
      ),
    ).toThrow(ExitCalled);
  });

  it('non-owner without runtime → fatal (default shared-container, D2 amendment)', () => {
    // raw Config bypassing zod parse: userCfg.runtime is undefined.
    // serve-isolation treats undefined as 'shared-container' and
    // fatals, mirroring what happens on既有 prod after schema bump.
    expect(() =>
      resolveIsolation(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mkConfig({ users: { alice: { workspace: '/tmp/a' } as any } }),
        'owner',
      ),
    ).toThrow(ExitCalled);
  });
});

describe('resolveIsolation — D4 host-only override', () => {
  it('host-only overrides non-host runtime to host (no fatal)', () => {
    const r = resolveIsolation(
      mkConfig({
        isolationPolicy: 'host-only',
        users: { alice: { runtime: 'shared-container' } },
      }),
      'owner',
    );
    expect(r.status).toEqual({ mode: 'host-only', ready: true });
  });

  it('host-only with all-host config still returns host-only mode', () => {
    const r = resolveIsolation(
      mkConfig({
        isolationPolicy: 'host-only',
        users: { alice: { runtime: 'host' } },
      }),
      'owner',
    );
    expect(r.status).toEqual({ mode: 'host-only', ready: true });
  });

  it('host-only does NOT reject owner=shared-container (owner check first)', () => {
    // 实际行为: owner runtime 校验在 policy 处理之前, host-only 也防不住
    // owner 显式配 container — D3 仍 fail-loud
    expect(() =>
      resolveIsolation(
        mkConfig({
          isolationPolicy: 'host-only',
          users: { owner: { runtime: 'shared-container' } },
        }),
        'owner',
      ),
    ).toThrow(ExitCalled);
  });
});
