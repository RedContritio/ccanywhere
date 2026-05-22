import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ccJsonlPathOf, QuotaPathError, runStartupSanityCheck, type SanityLogger } from './path.js';

describe('ccJsonlPathOf', () => {
  it('encodes a standard cwd by replacing / with - and adds leading -', () => {
    const result = ccJsonlPathOf('/Users/me/Projects/foo', 'abc-123');
    expect(result).toBe(join(homedir(), '.claude', 'projects', '-Users-me-Projects-foo', 'abc-123.jsonl'));
  });

  it('encodes a /private/... cwd correctly', () => {
    const result = ccJsonlPathOf('/private/tmp/ablation', 'sid');
    expect(result).toBe(join(homedir(), '.claude', 'projects', '-private-tmp-ablation', 'sid.jsonl'));
  });

  it('handles a cwd with spaces (cc preserves spaces verbatim)', () => {
    const result = ccJsonlPathOf('/Users/me/Code Repos/foo bar', 'sid');
    expect(result).toBe(
      join(homedir(), '.claude', 'projects', '-Users-me-Code Repos-foo bar', 'sid.jsonl'),
    );
  });

  it('handles root-only cwd /', () => {
    const result = ccJsonlPathOf('/', 'sid');
    expect(result).toBe(join(homedir(), '.claude', 'projects', '-', 'sid.jsonl'));
  });
});

describe('runStartupSanityCheck', () => {
  let projectsRoot: string;
  // vitest 4 changed Mock<T> generic; explicit signature lets logger
  // satisfy SanityLogger's callable shape while still exposing Mock API.
  let logger: SanityLogger & { info: Mock<(msg: string) => void>; warn: Mock<(msg: string) => void> };

  beforeEach(() => {
    projectsRoot = mkdtempSync(join(tmpdir(), 'ccanywhere-quota-path-'));
    logger = { info: vi.fn<(msg: string) => void>(), warn: vi.fn<(msg: string) => void>() };
  });

  afterEach(() => {
    rmSync(projectsRoot, { recursive: true, force: true });
  });

  it('projects root missing → skipped + warn (new install)', () => {
    rmSync(projectsRoot, { recursive: true, force: true });
    const result = runStartupSanityCheck({ projectsRoot, logger });
    expect(result.kind).toBe('skipped');
    if (result.kind === 'skipped') expect(result.reason).toMatch(/missing/);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('projects root empty → skipped + warn', () => {
    const result = runStartupSanityCheck({ projectsRoot, logger });
    expect(result.kind).toBe('skipped');
    if (result.kind === 'skipped') expect(result.reason).toMatch(/no jsonl/);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('fixture jsonl exists and matches → verified + info', () => {
    // Mirror real cc layout: -<encoded-cwd>/<uuid>.jsonl
    const projectDir = join(projectsRoot, '-Users-me-Projects-foo');
    mkdirSync(projectDir);
    const samplePath = join(projectDir, 'abcdef01-2345-6789-abcd-ef0123456789.jsonl');
    writeFileSync(samplePath, '');

    const result = runStartupSanityCheck({ projectsRoot, logger });
    expect(result.kind).toBe('verified');
    if (result.kind === 'verified') expect(result.samplePath).toBe(samplePath);
    expect(logger.info).toHaveBeenCalled();
  });

  it('encoding drift → throws QuotaPathError', () => {
    // Real layout on disk
    const projectDir = join(projectsRoot, '-Users-me-Projects-foo');
    mkdirSync(projectDir);
    const samplePath = join(projectDir, 'abcdef01-2345-6789-abcd-ef0123456789.jsonl');
    writeFileSync(samplePath, '');

    // Inject a pathOf that uses a DIFFERENT encoding (e.g. _ instead of -)
    const driftedPathOf = (cwd: string, sessionId: string): string =>
      join(projectsRoot, cwd.replace(/\//g, '_'), `${sessionId}.jsonl`);

    expect(() =>
      runStartupSanityCheck({ projectsRoot, pathOf: driftedPathOf, logger }),
    ).toThrow(QuotaPathError);
  });

  it('non-uuid file under project dir is ignored, sanity continues', () => {
    const projectDir = join(projectsRoot, '-Users-me-Projects-foo');
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, 'README.md'), '');
    writeFileSync(join(projectDir, 'not-a-uuid.jsonl'), '');

    // No valid uuid jsonl found → skipped, no throw
    const result = runStartupSanityCheck({ projectsRoot, logger });
    expect(result.kind).toBe('skipped');
  });

  it('non-dash-prefixed entries under projectsRoot are skipped', () => {
    const strayDir = join(projectsRoot, 'stray');
    mkdirSync(strayDir);
    writeFileSync(join(strayDir, 'abcdef01-2345-6789-abcd-ef0123456789.jsonl'), '');
    const result = runStartupSanityCheck({ projectsRoot, logger });
    expect(result.kind).toBe('skipped');
  });
});
