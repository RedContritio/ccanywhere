import type { Terminal } from '@xterm/xterm';
import type { TerminalSocket } from '../ws.js';

/**
 * Module-scoped diagnostic collector. The terminal component registers its
 * `Terminal` + `TerminalSocket` here on mount; feedback dialog and
 * ErrorBoundary read from this slot at submit time so they can attach a
 * structured snapshot of "what was on screen + how is the connection +
 * what does the env look like" without being plumbed via React props.
 *
 * Keep this intentionally write-only-on-mount / read-only-on-submit; no
 * subscription needed.
 */

interface ActiveSlot {
  readonly term: Terminal;
  readonly ws: TerminalSocket;
  readonly sessionId: string;
  readonly rendererKind: string;
  /**
   * Mutable. terminal.tsx bumps this on every successful write so diag
   * can compute "ms since last write" — useful for "stuck or just idle?"
   * triage.
   */
  lastWriteTs: number;
}

let active: ActiveSlot | null = null;

export function setActiveTerm(slot: ActiveSlot | null): void {
  active = slot;
}

export function noteTermWrite(): void {
  if (active !== null) active.lastWriteTs = Date.now();
}

const SCREEN_SCROLLBACK_ROWS = 20;
const SCREEN_LINE_LIMIT = 200; // hard cap so an oversized scroll doesn't bloat the JSON

function captureScreen(term: Terminal): string[] {
  const buf = term.buffer.active;
  const start = Math.max(0, buf.viewportY - SCREEN_SCROLLBACK_ROWS);
  const end = Math.min(start + SCREEN_LINE_LIMIT, buf.viewportY + term.rows);
  const out: string[] = [];
  for (let i = start; i < end; i++) {
    const line = buf.getLine(i);
    out.push(line ? line.translateToString(true) : '');
  }
  return out;
}

interface DiagViewport {
  cols?: number;
  rows?: number;
  windowW: number;
  windowH: number;
  devicePixelRatio: number;
  orientation?: string;
}
interface DiagNet {
  online: boolean;
  effectiveType?: string;
  downlink?: number;
}
interface DiagApp {
  activeSessionId?: string;
  sessionIds?: string[];
  theme?: string;
  effectiveTheme?: string;
}
interface DiagWs {
  readyState?: number;
  lastSeq?: number;
  retryIdx?: number;
  lastFrameTs?: number;
  lastFrameType?: string;
  sinceLastFrameMs?: number;
}
interface DiagTerm {
  rendererKind?: string;
  lastWriteTs?: number;
  screen?: string[];
}
interface DiagMemory {
  jsHeapSizeLimit?: number;
  totalJSHeapSize?: number;
  usedJSHeapSize?: number;
}
export interface Diag {
  activeSessionId?: string;
  viewport?: DiagViewport;
  net?: DiagNet;
  app?: DiagApp;
  ws?: DiagWs;
  term?: DiagTerm;
  memory?: DiagMemory;
}

export interface DiagExtra {
  readonly sessionIds?: string[];
  readonly theme?: string;
  readonly effectiveTheme?: string;
}

export function collectDiag(extra: DiagExtra = {}): Diag {
  const out: Diag = {};

  if (active !== null) {
    out.activeSessionId = active.sessionId;
  }

  // viewport
  const viewport: DiagViewport = {
    windowW: window.innerWidth,
    windowH: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
  };
  if (active !== null) {
    viewport.cols = active.term.cols;
    viewport.rows = active.term.rows;
  }
  const orient = (window.screen as Screen & { orientation?: { type?: string } })
    .orientation?.type;
  if (typeof orient === 'string') viewport.orientation = orient;
  out.viewport = viewport;

  // net
  const net: DiagNet = { online: navigator.onLine };
  // navigator.connection is non-standard but widely available on Chromium.
  const conn = (navigator as Navigator & {
    connection?: { effectiveType?: string; downlink?: number };
  }).connection;
  if (conn) {
    if (typeof conn.effectiveType === 'string') net.effectiveType = conn.effectiveType;
    if (typeof conn.downlink === 'number') net.downlink = conn.downlink;
  }
  out.net = net;

  // app
  const app: DiagApp = {};
  if (active !== null) app.activeSessionId = active.sessionId;
  if (extra.sessionIds !== undefined) app.sessionIds = extra.sessionIds;
  if (extra.theme !== undefined) app.theme = extra.theme;
  if (extra.effectiveTheme !== undefined) app.effectiveTheme = extra.effectiveTheme;
  if (Object.keys(app).length > 0) out.app = app;

  // ws
  if (active !== null) {
    const wsd = active.ws.getDiag();
    const ws: DiagWs = {
      readyState: wsd.readyState,
      lastSeq: wsd.lastSeq,
      retryIdx: wsd.retryIdx,
    };
    if (wsd.lastFrameTs > 0) {
      ws.lastFrameTs = wsd.lastFrameTs;
      ws.sinceLastFrameMs = Date.now() - wsd.lastFrameTs;
    }
    if (wsd.lastFrameType.length > 0) ws.lastFrameType = wsd.lastFrameType;
    out.ws = ws;
  }

  // term
  if (active !== null) {
    const term: DiagTerm = { rendererKind: active.rendererKind };
    if (active.lastWriteTs > 0) term.lastWriteTs = active.lastWriteTs;
    try {
      term.screen = captureScreen(active.term);
    } catch {
      // captureScreen can throw if buffer is disposed mid-collect; skip
    }
    out.term = term;
  }

  // memory (Chrome only)
  const mem = (performance as Performance & {
    memory?: { jsHeapSizeLimit?: number; totalJSHeapSize?: number; usedJSHeapSize?: number };
  }).memory;
  if (mem) {
    const memory: DiagMemory = {};
    if (typeof mem.jsHeapSizeLimit === 'number') memory.jsHeapSizeLimit = mem.jsHeapSizeLimit;
    if (typeof mem.totalJSHeapSize === 'number') memory.totalJSHeapSize = mem.totalJSHeapSize;
    if (typeof mem.usedJSHeapSize === 'number') memory.usedJSHeapSize = mem.usedJSHeapSize;
    if (Object.keys(memory).length > 0) out.memory = memory;
  }

  return out;
}

/** Tests only. */
export function resetActiveForTest(): void {
  active = null;
}
