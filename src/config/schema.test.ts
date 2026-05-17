import { describe, expect, it } from 'vitest';
import { ConfigSchema } from './schema.js';

function baseRaw(overrides: Record<string, unknown> = {}): unknown {
  return {
    workspace: '/tmp/x',
    webOrigin: 'http://localhost:7878',
    ...overrides,
  };
}

describe('ConfigSchema — isolationPolicy', () => {
  it('defaults to strict when not provided', () => {
    const cfg = ConfigSchema.parse(baseRaw());
    expect(cfg.isolationPolicy).toBe('strict');
  });

  it('accepts "fallback"', () => {
    const cfg = ConfigSchema.parse(baseRaw({ isolationPolicy: 'fallback' }));
    expect(cfg.isolationPolicy).toBe('fallback');
  });

  it('accepts "host-only"', () => {
    const cfg = ConfigSchema.parse(baseRaw({ isolationPolicy: 'host-only' }));
    expect(cfg.isolationPolicy).toBe('host-only');
  });

  it('rejects unknown value', () => {
    expect(() =>
      ConfigSchema.parse(baseRaw({ isolationPolicy: 'lenient' })),
    ).toThrow();
  });
});

describe('ConfigSchema — users.<name>.runtime', () => {
  it('defaults to shared-container when user listed without runtime', () => {
    const cfg = ConfigSchema.parse(
      baseRaw({ users: { alice: {} } }),
    );
    expect(cfg.users?.['alice']?.runtime).toBe('shared-container');
  });

  it('accepts explicit host', () => {
    const cfg = ConfigSchema.parse(
      baseRaw({ users: { alice: { runtime: 'host' } } }),
    );
    expect(cfg.users?.['alice']?.runtime).toBe('host');
  });

  it('accepts shared-container at parse time (serve.ts rejects later)', () => {
    const cfg = ConfigSchema.parse(
      baseRaw({ users: { alice: { runtime: 'shared-container' } } }),
    );
    expect(cfg.users?.['alice']?.runtime).toBe('shared-container');
  });

  it('rejects isolated-container at parse time (D2 reserved)', () => {
    expect(() =>
      ConfigSchema.parse(
        baseRaw({ users: { alice: { runtime: 'isolated-container' } } }),
      ),
    ).toThrow(/reserved/);
  });

  it('rejects unknown runtime value', () => {
    expect(() =>
      ConfigSchema.parse(
        baseRaw({ users: { alice: { runtime: 'sandbox' } } }),
      ),
    ).toThrow();
  });

  it('keeps workspace + runtime independent (both optional individually)', () => {
    const cfg = ConfigSchema.parse(
      baseRaw({
        users: {
          alice: { workspace: '/tmp/alice', runtime: 'host' },
          bob: {},
        },
      }),
    );
    expect(cfg.users?.['alice']?.workspace).toBe('/tmp/alice');
    expect(cfg.users?.['alice']?.runtime).toBe('host');
    expect(cfg.users?.['bob']?.workspace).toBeUndefined();
    expect(cfg.users?.['bob']?.runtime).toBe('shared-container'); // default reflects Phase 2 direction
  });
});
