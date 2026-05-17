import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DockerDetector } from './docker-detect.js';
import type { ExecImpl } from './exec.js';

function mkExec(
  responses: Array<{ exitCode: number; stdout?: string; stderr?: string }>,
): ExecImpl {
  let i = 0;
  return async () => {
    const r = responses[i] ?? responses[responses.length - 1];
    i++;
    return {
      exitCode: r?.exitCode ?? 0,
      stdout: r?.stdout ?? '',
      stderr: r?.stderr ?? '',
    };
  };
}

describe('DockerDetector.detect', () => {
  it('reports available when docker info exits 0', async () => {
    const d = new DockerDetector({ execImpl: mkExec([{ exitCode: 0 }]) });
    expect(await d.detect()).toEqual({ available: true });
  });

  it('reports unavailable when docker info exits non-zero', async () => {
    const d = new DockerDetector({
      execImpl: mkExec([
        {
          exitCode: 1,
          stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock',
        },
      ]),
    });
    const r = await d.detect();
    expect(r.available).toBe(false);
    expect(r.reason).toMatch(/Cannot connect/);
  });

  it('falls back to stdout for reason when stderr empty', async () => {
    const d = new DockerDetector({
      execImpl: mkExec([{ exitCode: 1, stdout: 'something on stdout' }]),
    });
    const r = await d.detect();
    expect(r.reason).toBe('something on stdout');
  });

  it('uses exit code as reason when both streams empty', async () => {
    const d = new DockerDetector({
      execImpl: mkExec([{ exitCode: 42 }]),
    });
    expect((await d.detect()).reason).toBe('exit code 42');
  });
});

describe('DockerDetector.startMonitoring', () => {
  let tickFn: (() => void) | null = null;
  let clearedHandle: unknown = null;
  const fakeInterval = (cb: () => void): number => {
    tickFn = cb;
    return 999;
  };
  const fakeClear = (h: NodeJS.Timeout | number): void => {
    clearedHandle = h;
  };

  beforeEach(() => {
    tickFn = null;
    clearedHandle = null;
  });
  afterEach(() => {
    tickFn = null;
  });

  it('fires onChange on first detect', async () => {
    const onChange = vi.fn();
    const d = new DockerDetector({
      execImpl: mkExec([{ exitCode: 0 }]),
      setIntervalImpl: fakeInterval,
      clearIntervalImpl: fakeClear,
    });
    d.startMonitoring(onChange);
    await new Promise<void>((r) => setImmediate(r));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ available: true });
    d.stopMonitoring();
  });

  it('fires onChange only on status flip', async () => {
    const onChange = vi.fn();
    const d = new DockerDetector({
      execImpl: mkExec([
        { exitCode: 0 }, // first
        { exitCode: 0 }, // same → no fire
        { exitCode: 1, stderr: 'daemon down' }, // flip → fire
        { exitCode: 1, stderr: 'daemon down' }, // same → no fire
      ]),
      setIntervalImpl: fakeInterval,
      clearIntervalImpl: fakeClear,
    });
    d.startMonitoring(onChange);
    await new Promise<void>((r) => setImmediate(r)); // initial
    if (tickFn) tickFn();
    await new Promise<void>((r) => setImmediate(r));
    if (tickFn) tickFn();
    await new Promise<void>((r) => setImmediate(r));
    if (tickFn) tickFn();
    await new Promise<void>((r) => setImmediate(r));
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenNthCalledWith(1, { available: true });
    expect(onChange.mock.calls[1]?.[0]).toMatchObject({ available: false });
    d.stopMonitoring();
  });

  it('stopMonitoring clears the interval handle', () => {
    const d = new DockerDetector({
      execImpl: mkExec([{ exitCode: 0 }]),
      setIntervalImpl: fakeInterval,
      clearIntervalImpl: fakeClear,
    });
    d.startMonitoring(() => {});
    d.stopMonitoring();
    expect(clearedHandle).toBe(999);
  });

  it('startMonitoring is idempotent (calling twice does not double-tick)', () => {
    let invocations = 0;
    const localFakeInterval = (_cb: () => void): number => {
      invocations++;
      return invocations;
    };
    const d = new DockerDetector({
      execImpl: mkExec([{ exitCode: 0 }]),
      setIntervalImpl: localFakeInterval,
      clearIntervalImpl: fakeClear,
    });
    d.startMonitoring(() => {});
    d.startMonitoring(() => {});
    expect(invocations).toBe(1);
    d.stopMonitoring();
  });
});
