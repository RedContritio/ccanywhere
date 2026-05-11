import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runFeedbackList, runFeedbackShow } from './feedback.js';

interface FixtureFeedback {
  id: string;
  submittedAt: number;
  deviceLabel?: string;
  title: string;
  body?: string;
  ops?: Array<{ kind: string; payload?: object }>;
  diag?: object;
}

function writeFixture(dir: string, fb: FixtureFeedback): void {
  const fileName = `${fb.id}.json`;
  writeFileSync(join(dir, fileName), JSON.stringify(fb));
}

describe('runFeedbackList / runFeedbackShow', () => {
  let configDir: string;
  let configPath: string;
  let captured: string[];

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'ccanywhere-feedback-cli-'));
    mkdirSync(join(configDir, 'feedback'));
    configPath = join(configDir, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        projectsRoot: '/tmp/cc-fb-proj',
        guestProjectsRoot: '/tmp/cc-fb-guest',
        webOrigin: 'http://127.0.0.1:65432',
      }),
    );
    captured = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s: unknown) => {
      captured.push(String(s));
      return true;
    });
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('list empty feedback dir → "(no feedback)"', async () => {
    await runFeedbackList(configPath);
    expect(captured.join('')).toContain('(no feedback)');
  });

  it('list orders newest first by id prefix (timestamp)', async () => {
    writeFixture(join(configDir, 'feedback'), {
      id: '2026-05-09T10-00-00-000Z-abc111',
      submittedAt: 1778316000000,
      deviceLabel: 'alpha',
      title: 'older',
    });
    writeFixture(join(configDir, 'feedback'), {
      id: '2026-05-10T10-00-00-000Z-abc222',
      submittedAt: 1778402400000,
      deviceLabel: 'beta',
      title: 'newer',
    });

    await runFeedbackList(configPath);
    const out = captured.join('');
    const idxNew = out.indexOf('newer');
    const idxOld = out.indexOf('older');
    expect(idxNew).toBeGreaterThan(-1);
    expect(idxOld).toBeGreaterThan(-1);
    expect(idxNew).toBeLessThan(idxOld);
  });

  it('list --verbose shows renderer / font / grid / dpr', async () => {
    writeFixture(join(configDir, 'feedback'), {
      id: '2026-05-11T00-00-00-000Z-deadbe',
      submittedAt: Date.now(),
      deviceLabel: 'Xiaomi 17 Pro',
      title: 'sample',
      ops: [{ kind: 'foo' }, { kind: 'bar' }],
      diag: {
        term: { rendererKind: 'webgl', fontSize: 8 },
        viewport: { cols: 78, rows: 61, devicePixelRatio: 2.75 },
      },
    });

    await runFeedbackList(configPath, { verbose: true });
    const out = captured.join('');
    expect(out).toContain('renderer=webgl');
    expect(out).toContain('font=8');
    expect(out).toContain('grid=78x61');
    expect(out).toContain('dpr=2.75');
    expect(out).toContain('ops=2');
  });

  it('list --json emits a parseable JSON array', async () => {
    writeFixture(join(configDir, 'feedback'), {
      id: '2026-05-11T00-00-00-000Z-fff',
      submittedAt: 1778500000000,
      deviceLabel: 'phone',
      title: 'json test',
    });
    await runFeedbackList(configPath, { json: true });
    const parsed = JSON.parse(captured.join('')) as Array<{ id: string; title: string }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.title).toBe('json test');
  });

  it('show by id prefix → summary contains key fields', async () => {
    writeFixture(join(configDir, 'feedback'), {
      id: '2026-05-11T01-00-00-000Z-cafe42',
      submittedAt: 1778503600000,
      deviceLabel: 'Xiaomi 17 Pro',
      title: '排版乱',
      body: 'first prompt 之后看起来错位',
      ops: [
        { kind: 'dims.callback' },
        { kind: 'dims.callback' },
        { kind: 'fit.applied' },
        { kind: 'term.write.error' },
      ],
      diag: {
        term: { rendererKind: 'webgl', fontSize: 8, cellWidth: 4.81, cellHeight: 9.6 },
        viewport: { cols: 78, rows: 61, devicePixelRatio: 2.75 },
        env: { userAgent: 'Mozilla/5.0 (test)' },
      },
    });

    await runFeedbackShow(configPath, 'cafe42');
    const out = captured.join('');
    expect(out).toContain('排版乱');
    expect(out).toContain('first prompt');
    expect(out).toContain('renderer=webgl');
    expect(out).toContain('fontSize=8');
    expect(out).toContain('cell=4.81x9.60');
    expect(out).toContain('grid=78x61');
    expect(out).toContain('Mozilla/5.0 (test)');
    // ops histogram
    expect(out).toContain('dims.callback');
    expect(out).toContain('fit.applied');
  });

  it('show --full dumps full pretty JSON', async () => {
    writeFixture(join(configDir, 'feedback'), {
      id: '2026-05-11T02-00-00-000Z-feed99',
      submittedAt: 1778507200000,
      deviceLabel: 'X',
      title: 'full test',
      ops: [{ kind: 'k1', payload: { x: 1 } }],
    });
    await runFeedbackShow(configPath, 'feed99', { full: true });
    const out = captured.join('');
    const parsed = JSON.parse(out) as { title: string; ops: Array<{ kind: string }> };
    expect(parsed.title).toBe('full test');
    expect(parsed.ops[0]?.kind).toBe('k1');
  });

  it('show with ambiguous prefix lists candidates + exits 1', async () => {
    writeFixture(join(configDir, 'feedback'), {
      id: '2026-05-11T03-00-00-000Z-dupe11',
      submittedAt: 1778510800000,
      deviceLabel: 'a',
      title: 'first',
    });
    writeFixture(join(configDir, 'feedback'), {
      id: '2026-05-11T03-00-01-000Z-dupe22',
      submittedAt: 1778510801000,
      deviceLabel: 'b',
      title: 'second',
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit(${code ?? 0})`);
    }) as never);
    await expect(runFeedbackShow(configPath, '2026-05-11T03')).rejects.toThrow('exit(1)');
    const out = captured.join('');
    expect(out).toContain('multiple');
    expect(out).toContain('dupe11');
    expect(out).toContain('dupe22');
    exitSpy.mockRestore();
  });
});
