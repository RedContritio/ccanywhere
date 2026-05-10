import { type ITheme, type Terminal } from '@xterm/xterm';
import { noteTermWrite } from '../state/diag.js';
import { recordOp } from '../state/ops-log.js';

export type RendererKind = 'webgl' | 'canvas' | 'dom';

/**
 * Pick the xterm renderer. Default 'webgl':
 *
 * 1. DOM renderer rebuilds all cell <span> children on every row paint
 *    (~1500 DOM mutations × 30-80 ms on mobile = 700 ms touchmove stalls
 *    during fast scrollback drag). Caught in feedback 2d2f1c7d.
 * 2. Canvas addon (`@xterm/addon-canvas`) is deprecated upstream and has
 *    known atlas / sub-pixel issues at high dpr. Feedback 0d84f615
 *    confirmed: smooth performance but visually corrupted output.
 * 3. WebGL is the actively maintained path; uses GPU atlas without DOM
 *    mutations and gets correctness fixes upstream.
 *
 * Devs can override per-navigation with `?renderer=canvas|webgl|dom`.
 * NOT persisted — one-shot URL knob, not a sticky preference.
 */
export function pickRenderer(): RendererKind {
  try {
    const q = new URLSearchParams(location.search).get('renderer');
    if (q === 'canvas' || q === 'dom' || q === 'webgl') return q;
  } catch {
    // URL parse failure; fall through
  }
  return 'webgl';
}

export const THEMES: Record<'light' | 'dark', ITheme> = {
  dark: {
    background: '#0a0a0a',
    foreground: '#e6e6e6',
    cursor: '#e6e6e6',
    selectionBackground: '#3a3a3a',
  },
  light: {
    background: '#ffffff',
    foreground: '#1a1a1a',
    cursor: '#1a1a1a',
    selectionBackground: '#cfd8e3',
  },
};

// Font size bounds for pinch-zoom.
//   - 8 px: smallest where monospace glyphs (CJK box drawing) remain legible
//     without sub-pixel hinting.
//   - 32 px: caps zoom to roughly 4×; beyond this the grid shrinks so much
//     cc TUI breaks layout.
//   - 13 px default = body 14 px – 1, monospace matches surrounding UI height.
export const FONT_SIZE_MIN = 8;
export const FONT_SIZE_MAX = 32;
export const FONT_SIZE_DEFAULT = 13;
export const FONT_SIZE_LS_KEY = 'ccanywhere.fontSize';

// Quiescence threshold derivation — see
// openspec/changes/m-mobile-fit-timing/design.md "QUIESCENCE_MS 推导".
// Don't tune the constant directly; adjust the inputs.
export const LAYOUT_TRANSITION_UPPER_BOUND_MS = 250;
export const QUIESCENCE_SAFETY = 1.2;
export const QUIESCENCE_MS = Math.ceil(LAYOUT_TRANSITION_UPPER_BOUND_MS * QUIESCENCE_SAFETY); // 300

// Aligned with server-side `fallbackTimer` (1500 ms in src/ws/server.ts).
// 5 × QUIESCENCE_MS: dims SM retries on every layout pulse; if 5 windows
// pass without `stable` the layout is pathological (continuous jitter
// > 1.2 s). Server gives the client 5× as a safety margin.
export const MAX_WAIT_MS = QUIESCENCE_MS * 5;

export function loadStoredFontSize(): number {
  try {
    const v = localStorage.getItem(FONT_SIZE_LS_KEY);
    if (v === null) return FONT_SIZE_DEFAULT;
    const n = Number.parseInt(v, 10);
    if (Number.isNaN(n)) return FONT_SIZE_DEFAULT;
    return Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, n));
  } catch {
    return FONT_SIZE_DEFAULT;
  }
}

// Chunk size for chunkedWrite's RAF-paced writes. 4 KiB:
//   - Longest plausible single ANSI escape (SGR RGB / OSC) is well under
//     256 B; 4 KiB makes split-across-chunks vanishingly rare.
//   - 4 KiB into xterm parser stays well under one 60fps frame (~16 ms).
//   - 1 KiB costs more RAF round-trips; 16 KiB+ risks frame drops.
export const SNAPSHOT_CHUNK_BYTES = 4096;

export function chunkedWrite(
  term: Terminal,
  data: string,
  source: 'snapshot' | 'output',
): void {
  if (data.length === 0) return;
  const bufType = term.buffer.active.type;
  if (data.length <= SNAPSHOT_CHUNK_BYTES) {
    const t0 = performance.now();
    recordOp('term.write', { source, buf: bufType, len: data.length });
    try {
      term.write(data);
      noteTermWrite();
    } catch (err) {
      recordOp('term.write.error', {
        message: err instanceof Error ? err.message : String(err),
        len: data.length,
      });
    }
    recordOp('term.write.done', {
      source,
      len: data.length,
      ms: Math.round(performance.now() - t0),
    });
    return;
  }
  let i = 0;
  const t0 = performance.now();
  recordOp('term.write', {
    source,
    buf: bufType,
    len: data.length,
    chunked: true,
  });
  const step = (): void => {
    if (i >= data.length) return;
    const end = Math.min(i + SNAPSHOT_CHUNK_BYTES, data.length);
    const tickT0 = performance.now();
    try {
      term.write(data.slice(i, end));
      noteTermWrite();
    } catch (err) {
      recordOp('term.write.error', {
        message: err instanceof Error ? err.message : String(err),
        offset: i,
        len: data.length,
      });
      return;
    }
    recordOp('term.write.raf', {
      source,
      offset: i,
      chunkLen: end - i,
      ms: Math.round(performance.now() - tickT0),
    });
    i = end;
    if (i < data.length) requestAnimationFrame(step);
    else {
      recordOp('term.write.done', {
        source,
        len: data.length,
        ms: Math.round(performance.now() - t0),
      });
    }
  };
  step();
}
