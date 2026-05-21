import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import type { TerminalSocket } from '../ws.js';
import { resetAuthStoreForTest, useAuthStore } from './auth.js';
import { collectDiag, noteTermWrite, resetActiveForTest, setActiveTerm } from './diag.js';

interface MockLine {
  text: string;
}

function makeMockTerm(
  rows: number,
  cols: number,
  lines: string[],
  opts: {
    fontSize?: number;
    fontFamily?: string;
    scrollback?: number;
    cursorBlink?: boolean;
    cellWidth?: number;
    cellHeight?: number;
  } = {},
): Terminal {
  const buffer = {
    active: {
      viewportY: Math.max(0, lines.length - rows),
      getLine: (i: number): MockLine | undefined => {
        const line = lines[i];
        if (line === undefined) return undefined;
        return {
          translateToString: (trim?: boolean): string =>
            trim === true ? line.replace(/\s+$/, '') : line,
        } as unknown as MockLine;
      },
    },
  };
  const xtermOpts: Record<string, unknown> = {};
  if (opts.fontSize !== undefined) xtermOpts['fontSize'] = opts.fontSize;
  if (opts.fontFamily !== undefined) xtermOpts['fontFamily'] = opts.fontFamily;
  if (opts.scrollback !== undefined) xtermOpts['scrollback'] = opts.scrollback;
  if (opts.cursorBlink !== undefined) xtermOpts['cursorBlink'] = opts.cursorBlink;
  const core =
    opts.cellWidth !== undefined || opts.cellHeight !== undefined
      ? {
          _renderService: {
            dimensions: { css: { cell: { width: opts.cellWidth, height: opts.cellHeight } } },
          },
        }
      : undefined;
  return {
    cols,
    rows,
    buffer,
    options: xtermOpts,
    _core: core,
  } as unknown as Terminal;
}

function makeMockSocket(diag: {
  readyState: number;
  lastSeq: number;
  retryIdx: number;
  lastFrameTs: number;
  lastFrameType: string;
}): TerminalSocket {
  return {
    getDiag: () => diag,
  } as unknown as TerminalSocket;
}

describe('collectDiag', () => {
  beforeEach(() => {
    resetActiveForTest();
    resetAuthStoreForTest();
  });

  afterEach(() => {
    resetActiveForTest();
    resetAuthStoreForTest();
    vi.unstubAllGlobals();
  });

  it.each([['owner'] as const, ['limited'] as const])(
    'includes userKind=%s from auth store when logged in',
    (kind) => {
      useAuthStore.setState({
        deviceId: 'u-1',
        label: 'someone',
        kind,
        verifiedAt: Date.now(),
      });
      const d = collectDiag();
      expect(d.app?.userKind).toBe(kind);
    },
  );

  it('omits userKind when auth store has no kind (logged out)', () => {
    // resetAuthStoreForTest in beforeEach already cleared kind to null.
    const d = collectDiag();
    expect(d.app?.userKind).toBeUndefined();
  });

  it('returns env/page/viewport/net even without active terminal', () => {
    const d = collectDiag();
    expect(d.viewport).toBeDefined();
    expect(typeof d.viewport!.windowW).toBe('number');
    expect(typeof d.viewport!.windowH).toBe('number');
    expect(typeof d.viewport!.screenW).toBe('number');
    expect(typeof d.viewport!.screenH).toBe('number');
    expect(typeof d.viewport!.devicePixelRatio).toBe('number');
    expect(d.viewport!.cols).toBeUndefined();
    expect(d.viewport!.rows).toBeUndefined();
    expect(d.net).toBeDefined();
    expect(typeof d.net!.online).toBe('boolean');
    expect(d.env).toBeDefined();
    expect(typeof d.env!.userAgent).toBe('string');
    expect(typeof d.env!.language).toBe('string');
    expect(d.page).toBeDefined();
    expect(typeof d.page!.pathname).toBe('string');
    expect(typeof d.page!.search).toBe('string');
    expect(typeof d.page!.referrer).toBe('string');
    expect(d.term).toBeUndefined();
    expect(d.ws).toBeUndefined();
    expect(d.activeSessionId).toBeUndefined();
  });

  it('includes term/ws/activeSessionId after setActiveTerm', () => {
    const term = makeMockTerm(
      3,
      10,
      [
        'line one with text',
        'second   ', // trailing whitespace must be trimmed
        'tail',
      ],
      {
        fontSize: 8, // pinch-zoom to FONT_SIZE_MIN
        fontFamily: 'ui-monospace',
        scrollback: 5000,
        cursorBlink: true,
        cellWidth: 4.81,
        cellHeight: 9.6,
      },
    );
    const ws = makeMockSocket({
      readyState: 1,
      lastSeq: 42,
      retryIdx: 0,
      lastFrameTs: 1_700_000_000_000,
      lastFrameType: 'output',
    });
    setActiveTerm({
      term,
      ws,
      sessionId: 'sess-A',
      rendererKind: 'dom',
      lastWriteTs: 0,
    });
    noteTermWrite();

    const d = collectDiag({
      sessionIds: ['sess-A', 'sess-B'],
      theme: 'auto',
      effectiveTheme: 'dark',
    });

    expect(d.activeSessionId).toBe('sess-A');
    expect(d.viewport!.cols).toBe(10);
    expect(d.viewport!.rows).toBe(3);
    expect(d.app).toMatchObject({
      activeSessionId: 'sess-A',
      sessionIds: ['sess-A', 'sess-B'],
      theme: 'auto',
      effectiveTheme: 'dark',
    });
    // version is injected at build-time by vite.config.ts `define`;
    // shape is "<short-sha-or-dev> @ <ISO time>".
    expect(d.app!.version).toMatch(/^([0-9a-f]{7,40}|dev) @ \d{4}-\d{2}-\d{2}T/);
    expect(d.ws).toMatchObject({
      readyState: 1,
      lastSeq: 42,
      retryIdx: 0,
      lastFrameType: 'output',
      lastFrameTs: 1_700_000_000_000,
    });
    expect(typeof d.ws!.sinceLastFrameMs).toBe('number');
    expect(d.term!.rendererKind).toBe('dom');
    expect(d.term!.fontSize).toBe(8);
    expect(d.term!.fontFamily).toBe('ui-monospace');
    expect(d.term!.scrollback).toBe(5000);
    expect(d.term!.cursorBlink).toBe(true);
    expect(d.term!.cellWidth).toBeCloseTo(4.81, 2);
    expect(d.term!.cellHeight).toBeCloseTo(9.6, 2);
    expect(typeof d.term!.lastWriteTs).toBe('number');
    expect(d.term!.lastWriteTs).toBeGreaterThan(0);
    expect(d.term!.screen).toEqual([
      'line one with text',
      'second',  // trailing spaces stripped
      'tail',
    ]);
  });

  it('omits xterm option / cell fields when not provided', () => {
    setActiveTerm({
      term: makeMockTerm(1, 1, ['']), // no opts → options empty, no _core
      ws: makeMockSocket({
        readyState: 1,
        lastSeq: 0,
        retryIdx: 0,
        lastFrameTs: 0,
        lastFrameType: '',
      }),
      sessionId: 'sess-Y',
      rendererKind: 'webgl',
      lastWriteTs: 0,
    });
    const d = collectDiag();
    expect(d.term!.fontSize).toBeUndefined();
    expect(d.term!.fontFamily).toBeUndefined();
    expect(d.term!.cellWidth).toBeUndefined();
    expect(d.term!.cellHeight).toBeUndefined();
  });

  it('omits memory block when performance.memory is unavailable', () => {
    // jsdom doesn't expose performance.memory; ensure diag doesn't fabricate one.
    expect(
      (performance as Performance & { memory?: unknown }).memory,
    ).toBeUndefined();
    const d = collectDiag();
    expect(d.memory).toBeUndefined();
  });

  it('omits ws.lastFrameTs when no frame has arrived yet', () => {
    setActiveTerm({
      term: makeMockTerm(1, 1, ['']),
      ws: makeMockSocket({
        readyState: 0,
        lastSeq: 0,
        retryIdx: 0,
        lastFrameTs: 0,
        lastFrameType: '',
      }),
      sessionId: 'sess-X',
      rendererKind: 'dom',
      lastWriteTs: 0,
    });

    const d = collectDiag();
    expect(d.ws!.lastFrameTs).toBeUndefined();
    expect(d.ws!.sinceLastFrameMs).toBeUndefined();
    expect(d.ws!.lastFrameType).toBeUndefined();
  });
});
