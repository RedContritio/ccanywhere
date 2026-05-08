import { describe, expect, it } from 'vitest';
import { Scrollback } from './scrollback.js';

describe('Scrollback', () => {
  it('appends within limit and reads back', () => {
    const sb = new Scrollback(8192);
    sb.append('hello ');
    sb.append(Buffer.from('world'));
    expect(sb.snapshot()).toBe('hello world');
    expect(sb.bytes).toBe(11);
  });

  it('drops old chunks when over capacity', () => {
    const sb = new Scrollback(1024);
    for (let i = 0; i < 100; i++) sb.append('x'.repeat(64));
    expect(sb.bytes).toBeLessThanOrEqual(1024);
    expect(sb.snapshot().length).toBeLessThanOrEqual(1024);
  });

  it('truncates a single oversized chunk by tail-keeping', () => {
    const sb = new Scrollback(1024);
    sb.append('a'.repeat(5000));
    expect(sb.bytes).toBeLessThanOrEqual(1024);
    expect(sb.snapshot()).toMatch(/^a+$/);
    expect(sb.snapshot().length).toBe(1024);
  });

  it('preserves recent data after overflow (FIFO drop)', () => {
    const sb = new Scrollback(1024);
    sb.append('older'.repeat(300));
    sb.append('TAIL_MARKER');
    expect(sb.snapshot().endsWith('TAIL_MARKER')).toBe(true);
  });

  it('clear resets state', () => {
    const sb = new Scrollback(1024);
    sb.append('something');
    sb.clear();
    expect(sb.bytes).toBe(0);
    expect(sb.snapshot()).toBe('');
  });

  it('rejects too-small max', () => {
    expect(() => new Scrollback(100)).toThrow(RangeError);
  });

  it('rejects non-integer max', () => {
    expect(() => new Scrollback(2048.5)).toThrow(RangeError);
  });

  it('ignores empty appends', () => {
    const sb = new Scrollback(1024);
    sb.append('');
    sb.append(Buffer.alloc(0));
    expect(sb.bytes).toBe(0);
  });
});
