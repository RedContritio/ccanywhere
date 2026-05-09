import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import type { TerminalSocket } from '../ws.js';
import { collectDiag, noteTermWrite, resetActiveForTest, setActiveTerm } from './diag.js';

interface MockLine {
  text: string;
}

function makeMockTerm(rows: number, cols: number, lines: string[]): Terminal {
  const buffer = {
    active: {
      viewportY: Math.max(0, lines.length - rows),
      getLine: (i: number): MockLine | undefined => {
        const line = lines[i];
        if (line === undefined) return undefined;
        return {
          // diag.ts calls translateToString(true) so we need to honor it.
          translateToString: (trim?: boolean): string =>
            trim === true ? line.replace(/\s+$/, '') : line,
        } as unknown as MockLine;
      },
    },
  };
  return {
    cols,
    rows,
    buffer,
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
  });

  afterEach(() => {
    resetActiveForTest();
    vi.unstubAllGlobals();
  });

  it('returns viewport/net even without active terminal', () => {
    const d = collectDiag();
    expect(d.viewport).toBeDefined();
    expect(typeof d.viewport!.windowW).toBe('number');
    expect(typeof d.viewport!.windowH).toBe('number');
    expect(typeof d.viewport!.devicePixelRatio).toBe('number');
    expect(d.viewport!.cols).toBeUndefined();
    expect(d.viewport!.rows).toBeUndefined();
    expect(d.net).toBeDefined();
    expect(typeof d.net!.online).toBe('boolean');
    expect(d.term).toBeUndefined();
    expect(d.ws).toBeUndefined();
    expect(d.activeSessionId).toBeUndefined();
  });

  it('includes term/ws/activeSessionId after setActiveTerm', () => {
    const term = makeMockTerm(3, 10, [
      'line one with text',
      'second   ', // trailing whitespace must be trimmed
      'tail',
    ]);
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
    expect(d.app).toEqual({
      activeSessionId: 'sess-A',
      sessionIds: ['sess-A', 'sess-B'],
      theme: 'auto',
      effectiveTheme: 'dark',
    });
    expect(d.ws).toMatchObject({
      readyState: 1,
      lastSeq: 42,
      retryIdx: 0,
      lastFrameType: 'output',
      lastFrameTs: 1_700_000_000_000,
    });
    expect(typeof d.ws!.sinceLastFrameMs).toBe('number');
    expect(d.term!.rendererKind).toBe('dom');
    expect(typeof d.term!.lastWriteTs).toBe('number');
    expect(d.term!.lastWriteTs).toBeGreaterThan(0);
    expect(d.term!.screen).toEqual([
      'line one with text',
      'second',  // trailing spaces stripped
      'tail',
    ]);
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
