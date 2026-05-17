import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TokenIssuer } from '../../proxy/tokens.js';
import { ContainerUserSync } from '../../container/user-sync.js';
import type { ExecImpl, ExecResult } from '../../container/exec.js';
import type { User } from '../../users/types.js';
import {
  buildSessionRuntimeOverlay,
  buildThemeEnv,
  type SessionContainerDeps,
} from './session-runtime.js';

function mkUser(over: Partial<User> = {}): User {
  return {
    id: 'u-1',
    username: 'alice',
    kind: 'user',
    createdAt: 0,
    lastLoginAt: null,
    quota: {
      cost: { limitUsd: null, usedUsd: 0 },
      tokens: { limit: null, used: 0 },
    },
    preferences: {},
    lastActiveSessionId: null,
    ...over,
  };
}

function mkExec(responder: (args: readonly string[]) => ExecResult): ExecImpl {
  return async (_cmd, args) => responder(args);
}

function mkDeps(over: Partial<SessionContainerDeps> = {}): SessionContainerDeps {
  return {
    containerName: 'cca-shared',
    userSync: new ContainerUserSync({
      containerName: 'cca-shared',
      execImpl: mkExec(() => ({ exitCode: 0, stdout: '1234\n', stderr: '' })),
    }),
    tokenIssuer: new TokenIssuer({ secret: randomBytes(32) }),
    proxyBaseUrl: 'http://127.0.0.1:62276',
    ...over,
  };
}

describe('buildThemeEnv', () => {
  it('dark → bg=0', () => {
    expect(buildThemeEnv('dark')).toEqual({ COLORFGBG: '15;0' });
  });
  it('light → bg=15', () => {
    expect(buildThemeEnv('light')).toEqual({ COLORFGBG: '0;15' });
  });
  it('undefined → empty', () => {
    expect(buildThemeEnv(undefined)).toEqual({});
  });
});

describe('buildSessionRuntimeOverlay — host (default)', () => {
  it('returns env: themeEnv when no perUserRuntime (legacy)', async () => {
    const r = await buildSessionRuntimeOverlay(
      mkUser(),
      undefined,
      undefined,
      { COLORFGBG: '15;0' },
    );
    expect(r).toEqual({ env: { COLORFGBG: '15;0' } });
  });

  it('returns {} when themeEnv empty and no container path', async () => {
    const r = await buildSessionRuntimeOverlay(
      mkUser(),
      undefined,
      undefined,
      {},
    );
    expect(r).toEqual({});
  });

  it('perUserRuntime says host → still host overlay (env only)', async () => {
    const map = new Map<string, 'host'>([['alice', 'host']]);
    const r = await buildSessionRuntimeOverlay(
      mkUser(),
      map,
      mkDeps(),
      { COLORFGBG: '15;0' },
    );
    expect(r.runtime).toBeUndefined();
    expect(r.container).toBeUndefined();
    expect(r.env).toEqual({ COLORFGBG: '15;0' });
  });

  it('user undefined → host overlay (env only)', async () => {
    const r = await buildSessionRuntimeOverlay(
      undefined,
      new Map([['alice', 'shared-container']]),
      mkDeps(),
      { COLORFGBG: '15;0' },
    );
    expect(r.runtime).toBeUndefined();
    expect(r.env).toEqual({ COLORFGBG: '15;0' });
  });
});

describe('buildSessionRuntimeOverlay — shared-container path', () => {
  it('returns runtime + container + env (含 ANTHROPIC + telemetry)', async () => {
    const map = new Map<string, 'shared-container'>([
      ['alice', 'shared-container'],
    ]);
    const deps = mkDeps();
    const r = await buildSessionRuntimeOverlay(
      mkUser(),
      map,
      deps,
      { COLORFGBG: '15;0' },
    );
    expect(r.runtime).toBe('shared-container');
    expect(r.container).toEqual({ name: 'cca-shared', unixUser: 'alice' });
    expect(r.env?.['COLORFGBG']).toBe('15;0');
    expect(r.env?.['ANTHROPIC_BASE_URL']).toBe('http://127.0.0.1:62276');
    expect(r.env?.['ANTHROPIC_AUTH_TOKEN']).toMatch(/^cca\./);
    expect(r.env?.['CLAUDE_CONFIG_DIR']).toBe('/home/alice/.claude');
    expect(r.env?.['DISABLE_AUTOUPDATER']).toBe('1');
    expect(r.env?.['DISABLE_TELEMETRY']).toBe('1');
  });

  it('deps undefined → host overlay even with shared-container map', async () => {
    const map = new Map<string, 'shared-container'>([
      ['alice', 'shared-container'],
    ]);
    const r = await buildSessionRuntimeOverlay(
      mkUser(),
      map,
      undefined,
      { COLORFGBG: '15;0' },
    );
    expect(r.runtime).toBeUndefined();
    expect(r.env).toEqual({ COLORFGBG: '15;0' });
  });

  it('triggers ensureUser on container path', async () => {
    const ensureCalls: string[] = [];
    let count = 0;
    const fakeSync = new ContainerUserSync({
      containerName: 'cca',
      execImpl: async (_cmd, args) => {
        if (args[2] === 'id') {
          ensureCalls.push(args[4] as string);
          return { exitCode: ++count > 0 ? 0 : 1, stdout: '1234\n', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    const deps = mkDeps({ userSync: fakeSync });
    const map = new Map([['alice', 'shared-container' as const]]);
    await buildSessionRuntimeOverlay(mkUser(), map, deps, {});
    expect(ensureCalls).toContain('alice');
  });
});
