import { Terminal, type ITerminalAddon } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';

/**
 * Server-side mirror of the cc TUI grid. Replays every PTY byte through
 * an xterm-headless instance, then exposes `snapshot()` which emits the
 * **current grid state** as minimal ANSI (via SerializeAddon).
 *
 * Why not just replay the raw scrollback? Two reasons:
 *
 * 1. The Scrollback ring buffer truncates at byte boundaries — it can
 *    cut a multi-byte ANSI escape sequence in half, leaving the client's
 *    parser in a broken state for the rest of the stream.
 *
 * 2. cc draws its TUI in alt-screen with cursor positioning (`\x1b[H`,
 *    `\x1b[2K`, etc), redrawing the same cells thousands of times. The
 *    raw byte log contains every redraw; replaying all of them on the
 *    client is wasted work and, when the PTY has been resized between
 *    redraws, places cursors in the wrong rows.
 *
 * SerializeAddon output captures only the visible grid + colors + cursor
 * position — one snapshot, no replay, correct after any number of resizes.
 */
export class ScreenState {
  private term: Terminal;
  private addon: SerializeAddon;

  constructor(cols: number, rows: number) {
    this.term = new Terminal({
      cols,
      rows,
      // Headless instances still maintain a normal-screen scrollback;
      // 5000 lines matches what xterm.js docs use as a sensible default.
      scrollback: 5_000,
      allowProposedApi: true,
    });
    this.addon = new SerializeAddon();
    // SerializeAddon's signature is typed against @xterm/xterm Terminal
    // (DOM-aware), but at runtime it works with @xterm/headless Terminal
    // — both share the buffer/serialize APIs the addon actually uses.
    // The cast is intentional and load-bearing for headless usage.
    this.term.loadAddon(this.addon as unknown as ITerminalAddon);
  }

  /** Feed one chunk of PTY output. */
  feed(data: string | Buffer): void {
    const str = typeof data === 'string' ? data : data.toString('utf8');
    this.term.write(str);
  }

  /**
   * Emit the current grid state as ANSI. Includes alt-screen entry/exit
   * markers, current cursor position, and all visible cells with attrs.
   * Safe to call repeatedly — reads serialize state, doesn't mutate.
   */
  snapshot(): string {
    return this.addon.serialize();
  }

  resize(cols: number, rows: number): void {
    if (cols < 1 || rows < 1) return;
    this.term.resize(cols, rows);
  }

  dispose(): void {
    this.addon.dispose();
    this.term.dispose();
  }
}
