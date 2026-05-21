import type { Terminal } from '@xterm/xterm';
import type { TerminalSocket } from '../ws.js';
import { useAuthStore, type UserKind } from './auth.js';

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
  /** visualViewport 实测尺寸；与 windowW/H 在键盘升起 / 浏览器 UI bar
   * 滑动时会偏离。triage 排版 / 键盘相关 bug 必备。 */
  vvW?: number;
  vvH?: number;
  vvOffsetTop?: number;
  vvOffsetLeft?: number;
  vvPageTop?: number;
  vvPageLeft?: number;
  /** 物理屏幕尺寸（含状态栏 / 导航条），辅助识别设备型号。 */
  screenW: number;
  screenH: number;
  devicePixelRatio: number;
  orientation?: string;
}

interface DiagEnv {
  /** UA string — 浏览器 / OS / 版本一锅端，triage 设备能力首要数据。 */
  userAgent: string;
  language: string;
  /** Intl 解析的时区名，例如 'Asia/Shanghai'。 */
  timezone?: string;
  /** 用户系统主题偏好（非应用层的 useUiStore；OS 级）。 */
  prefersColorScheme?: 'light' | 'dark' | 'no-preference';
  prefersReducedMotion?: boolean;
  visibilityState?: string;
  hasFocus?: boolean;
}

interface DiagPage {
  /** 不含 origin（避免日志泄露 staging hostname），仅 path + search。 */
  pathname: string;
  search: string;
  referrer: string;
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
  /** `<short-sha> @ <ISO build time>` — injected at vite build (see
   * web/vite.config.ts `define`). 'dev' when git is unavailable. */
  version?: string;
  /** Account class — `owner` = webauthn-paired device, `limited` =
   * token-authenticated user. Triage uses this to know whether a
   * feedback came from the host or a guest. */
  userKind?: UserKind;
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
  /** xterm fontSize in css-px. Pinch-zoom-mutable (4..32). Critical for
   * triage: cellWidth/cellHeight derive from this, cols × cellW is
   * what cc receives — any "排版乱 / cols off-by-one" feedback needs
   * fontSize reconstructable. */
  fontSize?: number;
  fontFamily?: string;
  scrollback?: number;
  cursorBlink?: boolean;
  /** xterm 实际渲染的 cell 尺寸（css-px）。`cellWidth × cols` 与
   * `containerWidth` 的差就是 fit-addon off-by-one bug 的判据 */
  cellWidth?: number;
  cellHeight?: number;
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
  env?: DiagEnv;
  page?: DiagPage;
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

// ─── per-section collectors ────────────────
// Each is module-private + pure (no side effect; reads only the args it
// takes). Browser-API-missing branches fail-soft → return without writing
// the affected field. Tests stub the relevant global via vi.stubGlobal
// rather than importing collectors directly.

function collectEnv(): DiagEnv {
  const env: DiagEnv = {
    userAgent: navigator.userAgent,
    language: navigator.language,
  };
  try {
    env.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    // some restricted contexts deny Intl access; skip
  }
  if (typeof window.matchMedia === 'function') {
    if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
      env.prefersColorScheme = 'dark';
    } else if (window.matchMedia('(prefers-color-scheme: light)').matches) {
      env.prefersColorScheme = 'light';
    } else {
      env.prefersColorScheme = 'no-preference';
    }
    env.prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }
  if (typeof document.visibilityState === 'string') {
    env.visibilityState = document.visibilityState;
  }
  if (typeof document.hasFocus === 'function') {
    try {
      env.hasFocus = document.hasFocus();
    } catch {
      // ignore (cross-origin frame edge)
    }
  }
  return env;
}

function collectPage(): DiagPage {
  return {
    pathname: location.pathname,
    search: location.search,
    referrer: document.referrer,
  };
}

function collectViewport(active: ActiveSlot | null): DiagViewport {
  const viewport: DiagViewport = {
    windowW: window.innerWidth,
    windowH: window.innerHeight,
    screenW: window.screen.width,
    screenH: window.screen.height,
    devicePixelRatio: window.devicePixelRatio,
  };
  if (active !== null) {
    viewport.cols = active.term.cols;
    viewport.rows = active.term.rows;
  }
  const vv = window.visualViewport;
  if (vv) {
    viewport.vvW = vv.width;
    viewport.vvH = vv.height;
    viewport.vvOffsetTop = vv.offsetTop;
    viewport.vvOffsetLeft = vv.offsetLeft;
    viewport.vvPageTop = vv.pageTop;
    viewport.vvPageLeft = vv.pageLeft;
  }
  const orient = (window.screen as Screen & { orientation?: { type?: string } })
    .orientation?.type;
  if (typeof orient === 'string') viewport.orientation = orient;
  return viewport;
}

function collectNet(): DiagNet {
  const net: DiagNet = { online: navigator.onLine };
  // navigator.connection is non-standard but widely available on Chromium.
  const conn = (navigator as Navigator & {
    connection?: { effectiveType?: string; downlink?: number };
  }).connection;
  if (conn) {
    if (typeof conn.effectiveType === 'string') net.effectiveType = conn.effectiveType;
    if (typeof conn.downlink === 'number') net.downlink = conn.downlink;
  }
  return net;
}

function collectApp(active: ActiveSlot | null, extra: DiagExtra): DiagApp | null {
  const app: DiagApp = {};
  if (active !== null) app.activeSessionId = active.sessionId;
  if (extra.sessionIds !== undefined) app.sessionIds = extra.sessionIds;
  if (extra.theme !== undefined) app.theme = extra.theme;
  if (extra.effectiveTheme !== undefined) app.effectiveTheme = extra.effectiveTheme;
  if (typeof __CC_VERSION__ === 'string' && __CC_VERSION__.length > 0) {
    app.version = __CC_VERSION__;
  }
  const userKind = useAuthStore.getState().kind;
  if (userKind !== null) app.userKind = userKind;
  return Object.keys(app).length > 0 ? app : null;
}

function collectWs(active: ActiveSlot): DiagWs {
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
  return ws;
}

function collectTerm(active: ActiveSlot): DiagTerm {
  const term: DiagTerm = { rendererKind: active.rendererKind };
  const opts = active.term.options;
  if (typeof opts.fontSize === 'number') term.fontSize = opts.fontSize;
  if (typeof opts.fontFamily === 'string') term.fontFamily = opts.fontFamily;
  if (typeof opts.scrollback === 'number') term.scrollback = opts.scrollback;
  if (typeof opts.cursorBlink === 'boolean') term.cursorBlink = opts.cursorBlink;
  // xterm's _renderService exposes the actually-rendered cell dims.
  // Reach through the private-named `_core` to read them; they're the
  // only authoritative source (FitAddon uses the same field).
  const core = (active.term as Terminal & {
    _core?: {
      _renderService?: { dimensions?: { css?: { cell?: { width?: number; height?: number } } } };
    };
  })._core;
  const cell = core?._renderService?.dimensions?.css?.cell;
  if (cell !== undefined) {
    if (typeof cell.width === 'number') term.cellWidth = cell.width;
    if (typeof cell.height === 'number') term.cellHeight = cell.height;
  }
  if (active.lastWriteTs > 0) term.lastWriteTs = active.lastWriteTs;
  try {
    term.screen = captureScreen(active.term);
  } catch {
    // captureScreen can throw if buffer is disposed mid-collect; skip
  }
  return term;
}

function collectMemory(): DiagMemory | null {
  // memory (Chrome only)
  const mem = (performance as Performance & {
    memory?: { jsHeapSizeLimit?: number; totalJSHeapSize?: number; usedJSHeapSize?: number };
  }).memory;
  if (!mem) return null;
  const memory: DiagMemory = {};
  if (typeof mem.jsHeapSizeLimit === 'number') memory.jsHeapSizeLimit = mem.jsHeapSizeLimit;
  if (typeof mem.totalJSHeapSize === 'number') memory.totalJSHeapSize = mem.totalJSHeapSize;
  if (typeof mem.usedJSHeapSize === 'number') memory.usedJSHeapSize = mem.usedJSHeapSize;
  return Object.keys(memory).length > 0 ? memory : null;
}

export function collectDiag(extra: DiagExtra = {}): Diag {
  const out: Diag = {};
  if (active !== null) out.activeSessionId = active.sessionId;
  out.env = collectEnv();
  out.page = collectPage();
  out.viewport = collectViewport(active);
  out.net = collectNet();
  const app = collectApp(active, extra);
  if (app !== null) out.app = app;
  if (active !== null) {
    out.ws = collectWs(active);
    out.term = collectTerm(active);
  }
  const memory = collectMemory();
  if (memory !== null) out.memory = memory;
  return out;
}

/** Tests only. */
export function resetActiveForTest(): void {
  active = null;
}
