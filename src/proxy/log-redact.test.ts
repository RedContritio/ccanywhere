import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { pino } from 'pino';
import {
  RedactSelfTestError,
  buildRedactOptions,
  runRedactSelfTest,
} from './log-redact.js';

describe('runRedactSelfTest', () => {
  it('passes with current REDACT_PATHS', async () => {
    await expect(runRedactSelfTest()).resolves.toBeUndefined();
  });
});

describe('buildRedactOptions', () => {
  it('redacts known sensitive paths in pino output', async () => {
    const captured: string[] = [];
    const stream = new PassThrough();
    stream.on('data', (c: Buffer) => captured.push(c.toString('utf8')));

    const log = pino(
      { level: 'info', redact: buildRedactOptions() },
      stream,
    );
    log.info(
      {
        req: {
          headers: {
            authorization: 'Bearer top-secret-token',
            'x-api-key': 'sk-secret',
          },
        },
        credentials: { apiKey: 'sk-ant-owner' },
      },
      'test',
    );
    await new Promise((r) => setImmediate(r));

    const out = captured.join('');
    expect(out).not.toContain('top-secret-token');
    expect(out).not.toContain('sk-secret');
    expect(out).not.toContain('sk-ant-owner');
    expect(out).toContain('[REDACTED]');
  });

  it('does not redact non-sensitive fields', async () => {
    const captured: string[] = [];
    const stream = new PassThrough();
    stream.on('data', (c: Buffer) => captured.push(c.toString('utf8')));
    const log = pino(
      { level: 'info', redact: buildRedactOptions() },
      stream,
    );
    log.info({ user: 'alice', count: 42 }, 'normal');
    await new Promise((r) => setImmediate(r));

    const out = captured.join('');
    expect(out).toContain('alice');
    expect(out).toContain('42');
  });
});

describe('RedactSelfTestError', () => {
  it('is the error type runRedactSelfTest throws when token leaks', () => {
    const e = new RedactSelfTestError('leaked');
    expect(e.name).toBe('RedactSelfTestError');
    expect(e.message).toBe('leaked');
  });
});
