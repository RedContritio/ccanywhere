import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadJsonRecord } from './load-json-record.js';

const Schema = z.object({
  a: z.string(),
  b: z.number(),
});

describe('loadJsonRecord', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cc-ljr-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('missing file → undefined (no throw)', () => {
    const result = loadJsonRecord(join(dir, 'nonexistent.json'), Schema);
    expect(result).toBeUndefined();
  });

  it('invalid json → undefined', () => {
    const path = join(dir, 'bad.json');
    writeFileSync(path, 'not-json-{', 'utf8');
    const result = loadJsonRecord(path, Schema);
    expect(result).toBeUndefined();
  });

  it('schema mismatch → undefined', () => {
    const path = join(dir, 'wrong-shape.json');
    writeFileSync(path, JSON.stringify({ a: 1, b: 'two' }), 'utf8');
    const result = loadJsonRecord(path, Schema);
    expect(result).toBeUndefined();
  });

  it('schema mismatch on extra field → still valid (zod strips extras by default)', () => {
    const path = join(dir, 'extra-field.json');
    writeFileSync(path, JSON.stringify({ a: 'x', b: 1, c: 'extra' }), 'utf8');
    const result = loadJsonRecord(path, Schema);
    expect(result).toEqual({ a: 'x', b: 1 });
  });

  it('valid record → typed T', () => {
    const path = join(dir, 'good.json');
    writeFileSync(path, JSON.stringify({ a: 'hello', b: 42 }), 'utf8');
    const result = loadJsonRecord(path, Schema);
    expect(result).toEqual({ a: 'hello', b: 42 });
  });
});
