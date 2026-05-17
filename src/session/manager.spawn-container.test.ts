import { describe, expect, it } from 'vitest';
import { buildSpawnCommand } from './spawn-command.js';
import type { SpawnOptions } from './manager-types.js';

function baseOpts(over: Partial<SpawnOptions> = {}): SpawnOptions {
  return {
    projectId: 'demo',
    cwd: '/tmp/x',
    command: 'claude',
    args: ['--session-id', 'abc'],
    scrollbackBytes: 4096,
    mode: 'create',
    userId: 'u-1',
    ...over,
  };
}

describe('buildSpawnCommand — host (legacy)', () => {
  it('runtime omitted: identity command + args, env merged from parent + opts.env', () => {
    const r = buildSpawnCommand(baseOpts({ env: { FOO: 'bar' } }));
    expect(r.command).toBe('claude');
    expect(r.args).toEqual(['--session-id', 'abc']);
    expect(r.ptyEnv['FOO']).toBe('bar');
    expect(r.ptyEnv['PATH']).toBeDefined(); // inherited from parent
  });

  it('runtime: "host" same as omitted', () => {
    const r = buildSpawnCommand(baseOpts({ runtime: 'host' }));
    expect(r.command).toBe('claude');
    expect(r.args).toEqual(['--session-id', 'abc']);
  });
});

describe('buildSpawnCommand — shared-container', () => {
  it('throws when container opts missing', () => {
    expect(() =>
      buildSpawnCommand(baseOpts({ runtime: 'shared-container' })),
    ).toThrow(/requires opts.container/);
  });

  it('wraps in docker exec -it -u <user> + image at end', () => {
    const r = buildSpawnCommand(
      baseOpts({
        runtime: 'shared-container',
        container: { name: 'cca-shared', unixUser: 'alice' },
      }),
    );
    expect(r.command).toBe('docker');
    expect(r.args[0]).toBe('exec');
    expect(r.args[1]).toBe('-it');
    expect(r.args).toContain('-u');
    expect(r.args[r.args.indexOf('-u') + 1]).toBe('alice');
    expect(r.args).toContain('cca-shared');
    // command + args at end
    const ctnIdx = r.args.indexOf('cca-shared');
    expect(r.args[ctnIdx + 1]).toBe('claude');
    expect(r.args[ctnIdx + 2]).toBe('--session-id');
    expect(r.args[ctnIdx + 3]).toBe('abc');
  });

  it('env entries become -e KEY=VAL args (not in pty env)', () => {
    const r = buildSpawnCommand(
      baseOpts({
        runtime: 'shared-container',
        container: { name: 'cca', unixUser: 'alice' },
        env: {
          ANTHROPIC_BASE_URL: 'http://127.0.0.1:62276',
          ANTHROPIC_AUTH_TOKEN: 'cca.test.token',
        },
      }),
    );
    // -e args contain both KEY=VAL pairs
    const eArgs: string[] = [];
    for (let i = 0; i < r.args.length; i++) {
      if (r.args[i] === '-e' && typeof r.args[i + 1] === 'string') {
        eArgs.push(r.args[i + 1] as string);
      }
    }
    expect(eArgs).toContain('ANTHROPIC_BASE_URL=http://127.0.0.1:62276');
    expect(eArgs).toContain('ANTHROPIC_AUTH_TOKEN=cca.test.token');
    // pty env is parent-only (no user env leaked into docker CLI proc)
    expect(r.ptyEnv['ANTHROPIC_BASE_URL']).toBeUndefined();
    expect(r.ptyEnv['ANTHROPIC_AUTH_TOKEN']).toBeUndefined();
    // PATH still inherited (so docker CLI itself can find docker binary)
    expect(r.ptyEnv['PATH']).toBeDefined();
  });

  it('no env: still produces valid docker exec args (no -e at all)', () => {
    const r = buildSpawnCommand(
      baseOpts({
        runtime: 'shared-container',
        container: { name: 'cca', unixUser: 'alice' },
      }),
    );
    expect(r.args).not.toContain('-e');
  });

  it('preserves args order after container name', () => {
    const r = buildSpawnCommand(
      baseOpts({
        runtime: 'shared-container',
        container: { name: 'cca', unixUser: 'bob' },
        command: 'claude',
        args: ['--resume', 'sess-xyz'],
      }),
    );
    const ctnIdx = r.args.indexOf('cca');
    expect(r.args.slice(ctnIdx + 1)).toEqual([
      'claude',
      '--resume',
      'sess-xyz',
    ]);
  });
});
