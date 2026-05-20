import { describe, expect, it } from 'vitest';
import {
  SharedContainerError,
  SharedContainerManager,
} from './shared-manager.js';
import type { ExecImpl, ExecResult } from './exec.js';

interface ExecCall {
  cmd: string;
  args: readonly string[];
}

function mkExec(
  responder: (call: ExecCall) => ExecResult,
): { exec: ExecImpl; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const exec: ExecImpl = async (cmd, args) => {
    const call = { cmd, args };
    calls.push(call);
    return responder(call);
  };
  return { exec, calls };
}

function ok(stdout = ''): ExecResult {
  return { exitCode: 0, stdout, stderr: '' };
}
function fail(stderr: string, exitCode = 1): ExecResult {
  return { exitCode, stdout: '', stderr };
}

describe('SharedContainerManager.ensureRunning', () => {
  it('docker run -d when container absent', async () => {
    const { exec, calls } = mkExec((call) => {
      if (call.args[0] === 'inspect') return fail('No such container');
      if (call.args[0] === 'run') return ok('cid123');
      throw new Error(`unexpected: ${call.args.join(' ')}`);
    });
    const mgr = new SharedContainerManager({
      image: 'ccanywhere/user-runtime:latest',
      name: 'cca-shared',
      execImpl: exec,
    });
    await mgr.ensureRunning();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.args).toEqual([
      'run',
      '-d',
      '--name',
      'cca-shared',
      '--restart',
      'unless-stopped',
      '--cap-add',
      'NET_ADMIN',
      'ccanywhere/user-runtime:latest',
    ]);
  });

  it('noop when container already running', async () => {
    const { exec, calls } = mkExec(() => ok('running\n'));
    const mgr = new SharedContainerManager({
      image: 'i',
      name: 'n',
      execImpl: exec,
    });
    await mgr.ensureRunning();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0]).toBe('inspect');
  });

  it('docker start when container exited', async () => {
    const { exec, calls } = mkExec((call) => {
      if (call.args[0] === 'inspect') return ok('exited\n');
      if (call.args[0] === 'start') return ok('n\n');
      throw new Error(`unexpected: ${call.args.join(' ')}`);
    });
    const mgr = new SharedContainerManager({
      image: 'i',
      name: 'n',
      execImpl: exec,
    });
    await mgr.ensureRunning();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.args).toEqual(['start', 'n']);
  });

  it('throws SharedContainerError when docker run fails', async () => {
    const { exec } = mkExec((call) => {
      if (call.args[0] === 'inspect') return fail('No such container');
      if (call.args[0] === 'run') return fail('image pull failed');
      throw new Error('unexpected');
    });
    const mgr = new SharedContainerManager({
      image: 'i',
      name: 'n',
      execImpl: exec,
    });
    await expect(mgr.ensureRunning()).rejects.toThrow(SharedContainerError);
  });

  it('omits --cap-add NET_ADMIN when capAddNetAdmin:false', async () => {
    const { exec, calls } = mkExec((call) => {
      if (call.args[0] === 'inspect') return fail('No such container');
      if (call.args[0] === 'run') return ok('cid');
      throw new Error('unexpected');
    });
    const mgr = new SharedContainerManager({
      image: 'i',
      name: 'n',
      capAddNetAdmin: false,
      execImpl: exec,
    });
    await mgr.ensureRunning();
    expect(calls[1]?.args).not.toContain('NET_ADMIN');
  });

  it('appends extraRunArgs before image', async () => {
    const { exec, calls } = mkExec((call) => {
      if (call.args[0] === 'inspect') return fail('absent');
      if (call.args[0] === 'run') return ok('cid');
      throw new Error('unexpected');
    });
    const mgr = new SharedContainerManager({
      image: 'IMG',
      name: 'n',
      extraRunArgs: ['-v', '/host:/ctn:ro'],
      execImpl: exec,
    });
    await mgr.ensureRunning();
    const args = calls[1]?.args ?? [];
    const imageIdx = args.indexOf('IMG');
    const vIdx = args.indexOf('-v');
    expect(vIdx).toBeGreaterThan(0);
    expect(imageIdx).toBeGreaterThan(vIdx);
  });
});

describe('SharedContainerManager.stop', () => {
  it('runs docker rm -f', async () => {
    const { exec, calls } = mkExec(() => ok('n\n'));
    const mgr = new SharedContainerManager({
      image: 'i',
      name: 'n',
      execImpl: exec,
    });
    await mgr.stop();
    expect(calls[0]?.args).toEqual(['rm', '-f', 'n']);
  });

  it('treats "No such container" as success (idempotent)', async () => {
    const { exec } = mkExec(() => fail('Error: No such container: n'));
    const mgr = new SharedContainerManager({
      image: 'i',
      name: 'n',
      execImpl: exec,
    });
    await expect(mgr.stop()).resolves.toBeUndefined();
  });

  it('throws on other docker rm errors', async () => {
    const { exec } = mkExec(() => fail('permission denied'));
    const mgr = new SharedContainerManager({
      image: 'i',
      name: 'n',
      execImpl: exec,
    });
    await expect(mgr.stop()).rejects.toThrow(SharedContainerError);
  });
});

describe('SharedContainerManager.healthCheck', () => {
  it('running:true + healthy:true when both inspect + exec ok', async () => {
    const { exec } = mkExec((call) => {
      if (call.args[0] === 'inspect') return ok('running\n');
      if (call.args[0] === 'exec') return ok('');
      throw new Error('unexpected');
    });
    const mgr = new SharedContainerManager({
      image: 'i',
      name: 'n',
      execImpl: exec,
    });
    expect(await mgr.healthCheck()).toEqual({ running: true, healthy: true });
  });

  it('running:true + healthy:false when exec fails', async () => {
    const { exec } = mkExec((call) => {
      if (call.args[0] === 'inspect') return ok('running\n');
      if (call.args[0] === 'exec') return fail('container not responsive');
      throw new Error('unexpected');
    });
    const mgr = new SharedContainerManager({
      image: 'i',
      name: 'n',
      execImpl: exec,
    });
    expect(await mgr.healthCheck()).toEqual({ running: true, healthy: false });
  });

  it('running:false when inspect says exited', async () => {
    const { exec } = mkExec(() => ok('exited\n'));
    const mgr = new SharedContainerManager({
      image: 'i',
      name: 'n',
      execImpl: exec,
    });
    expect(await mgr.healthCheck()).toEqual({ running: false, healthy: false });
  });

  it('running:false when container absent', async () => {
    const { exec } = mkExec(() => fail('No such container'));
    const mgr = new SharedContainerManager({
      image: 'i',
      name: 'n',
      execImpl: exec,
    });
    expect(await mgr.healthCheck()).toEqual({ running: false, healthy: false });
  });
});
