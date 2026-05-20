import { describe, expect, it } from 'vitest';
import {
  ContainerUserSync,
  ContainerUserSyncError,
} from './user-sync.js';
import type { ExecImpl, ExecResult } from './exec.js';

interface Call {
  cmd: string;
  args: readonly string[];
}

function mkExec(responder: (call: Call) => ExecResult): {
  exec: ExecImpl;
  calls: Call[];
} {
  const calls: Call[] = [];
  return {
    exec: async (cmd, args) => {
      const c = { cmd, args };
      calls.push(c);
      return responder(c);
    },
    calls,
  };
}

const ok = (stdout = ''): ExecResult => ({ exitCode: 0, stdout, stderr: '' });
const fail = (stderr: string): ExecResult => ({
  exitCode: 1,
  stdout: '',
  stderr,
});

describe('ContainerUserSync.uidOf', () => {
  it('is deterministic for same username', () => {
    expect(ContainerUserSync.uidOf('alice')).toBe(
      ContainerUserSync.uidOf('alice'),
    );
  });

  it('lands in [1000, 65000) range', () => {
    for (const u of ['alice', 'bob', 'carol', 'admin', '中文用户']) {
      const uid = ContainerUserSync.uidOf(u);
      expect(uid).toBeGreaterThanOrEqual(1000);
      expect(uid).toBeLessThan(65_000);
    }
  });

  it('produces different UIDs for different usernames (no obvious collisions)', () => {
    const uids = ['alice', 'bob', 'carol', 'dan', 'eve'].map((u) =>
      ContainerUserSync.uidOf(u),
    );
    expect(new Set(uids).size).toBe(uids.length);
  });
});

describe('ContainerUserSync.ensureUser', () => {
  it('noop when user already exists (id -u returns 0)', async () => {
    const { exec, calls } = mkExec(() => ok('1234\n'));
    const sync = new ContainerUserSync({
      containerName: 'cca-shared',
      execImpl: exec,
    });
    const r = await sync.ensureUser('alice');
    expect(r.uid).toBe(ContainerUserSync.uidOf('alice'));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual([
      'exec',
      'cca-shared',
      'id',
      '-u',
      'alice',
    ]);
  });

  it('useradd + chmod when user absent', async () => {
    const { exec, calls } = mkExec((c) => {
      const a = c.args;
      if (a[2] === 'id') return fail('id: alice: no such user');
      if (a[2] === 'useradd') return ok('');
      if (a[2] === 'chmod') return ok('');
      throw new Error(`unexpected: ${a.join(' ')}`);
    });
    const sync = new ContainerUserSync({
      containerName: 'cca-shared',
      execImpl: exec,
    });
    await sync.ensureUser('alice');
    expect(calls).toHaveLength(3);
    const useraddCall = calls[1]?.args ?? [];
    expect(useraddCall).toContain('useradd');
    expect(useraddCall).toContain(String(ContainerUserSync.uidOf('alice')));
    expect(useraddCall).toContain('-m');
    expect(useraddCall).toContain('alice');
    const chmodCall = calls[2]?.args ?? [];
    expect(chmodCall).toContain('chmod');
    expect(chmodCall).toContain('0700');
    expect(chmodCall).toContain('/home/alice');
  });

  it('creates per-user claude state dir under userClaudeContainerRoot with 0700 chown', async () => {
    const { exec, calls } = mkExec((c) => {
      const a = c.args;
      if (a[2] === 'id') return fail('absent');
      if (a[2] === 'useradd') return ok('');
      if (a[2] === 'chmod') return ok('');
      if (a[2] === 'mkdir') return ok('');
      if (a[2] === 'chown') return ok('');
      if (a[2] === 'cp') return ok('');
      if (a[2] === 'sh') return ok('');
      throw new Error(`unexpected: ${a.join(' ')}`);
    });
    const sync = new ContainerUserSync({
      containerName: 'cca-shared',
      execImpl: exec,
      userClaudeContainerRoot: '/var/lib/ccanywhere/user-claude',
    });
    await sync.ensureUser('alice');
    const expectedDir = '/var/lib/ccanywhere/user-claude/alice';
    const expectedUid = String(ContainerUserSync.uidOf('alice'));
    const mkdirCall = calls.find((c) => c.args[2] === 'mkdir');
    const chownCall = calls.find(
      (c) => c.args[2] === 'chown' && !c.args.some((a) => a.includes('CLAUDE.md') || a.includes('settings.json')),
    );
    const claudeChmodCall = calls.find(
      (c) => c.args[2] === 'chmod' && c.args.includes(expectedDir),
    );
    expect(mkdirCall?.args).toContain(expectedDir);
    expect(chownCall?.args).toContain(`${expectedUid}:${expectedUid}`);
    expect(chownCall?.args).toContain(expectedDir);
    expect(claudeChmodCall?.args).toContain('0700');
  });

  it('Managed scope: no per-user CLAUDE.md or settings.json cp, but seeds empty user-scope settings.json', async () => {
    // Policy ships via /etc/claude-code/managed-settings.json (cc reads
    // it directly). ContainerUserSync useradd + chmod + mkdir per-user
    // dir + seed `<dir>/settings.json` as empty `{}` so cc /theme and
    // user preferences persist across spawns (cc reads/writes this
    // file; we don't bake content).
    const { exec, calls } = mkExec((c) => {
      const a = c.args;
      if (a[2] === 'id') return fail('absent');
      if (['useradd', 'chmod', 'mkdir', 'chown', 'sh'].includes(a[2] ?? '')) return ok('');
      throw new Error(`unexpected: ${a.join(' ')}`);
    });
    const sync = new ContainerUserSync({
      containerName: 'cca-shared',
      execImpl: exec,
      userClaudeContainerRoot: '/var/lib/ccanywhere/user-claude',
    });
    await sync.ensureUser('alice');
    const cpCalls = calls.filter((c) => c.args[2] === 'cp');
    expect(cpCalls).toHaveLength(0);
    // seed step: sh -c '[ -f ... ] || ...settings.json'
    const seedCall = calls.find((c) => c.args[2] === 'sh');
    expect(seedCall?.args.join(' ')).toContain('settings.json');
    expect(seedCall?.args.join(' ')).toContain("echo '{}'");
  });

  it('cache: second call no docker invocation', async () => {
    const { exec, calls } = mkExec(() => ok('1234\n'));
    const sync = new ContainerUserSync({
      containerName: 'cca-shared',
      execImpl: exec,
    });
    await sync.ensureUser('alice');
    expect(calls).toHaveLength(1);
    await sync.ensureUser('alice');
    expect(calls).toHaveLength(1); // cached, no second docker exec
  });

  it('throws ContainerUserSyncError when useradd fails', async () => {
    const { exec } = mkExec((c) => {
      if (c.args[2] === 'id') return fail('absent');
      if (c.args[2] === 'useradd') return fail('useradd: UID 1234 not unique');
      return ok('');
    });
    const sync = new ContainerUserSync({
      containerName: 'n',
      execImpl: exec,
    });
    await expect(sync.ensureUser('alice')).rejects.toThrow(
      ContainerUserSyncError,
    );
  });

  it('throws when chmod fails (perm setting is mandatory for fs isolation)', async () => {
    const { exec } = mkExec((c) => {
      if (c.args[2] === 'id') return fail('absent');
      if (c.args[2] === 'useradd') return ok('');
      if (c.args[2] === 'chmod') return fail('chmod: cannot access');
      return ok('');
    });
    const sync = new ContainerUserSync({
      containerName: 'n',
      execImpl: exec,
    });
    await expect(sync.ensureUser('alice')).rejects.toThrow(
      ContainerUserSyncError,
    );
  });
});
