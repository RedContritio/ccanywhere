/**
 * Wire-compatible toolbar layout types. Mirrors `src/users/types.ts`
 * `ToolbarLayout` / `ToolbarKey` exactly (server zod schema is the source
 * of truth for validation; this file is a hand-typed client copy because
 * the web build can't import server modules under the monorepo split).
 *
 * Default layout = current hardcoded layout pre-prefs (ctrl-left + nav-right
 * inverted-T). When the user has no `preferences.toolbar` set, MobileToolbar
 * renders this directly.
 */

export type ToolbarKeyAction = 'plain' | 'ctrl-letter' | 'toggle-sticky-ctrl';

export interface ToolbarKey {
  readonly id: string;
  readonly label: string;
  readonly ariaLabel?: string;
  readonly title?: string;
  readonly action: ToolbarKeyAction;
  readonly payload: string;
}

export interface ToolbarLayout {
  readonly rows: number;
  readonly cols: number;
  readonly cells: ReadonlyArray<ToolbarKey | null>;
}

// Escape sequences mirroring xterm input — kept in this module so the
// default layout and any client-side preset construction share one source.
export const ARROW_UP = '\x1b[A';
export const ARROW_DOWN = '\x1b[B';
export const ARROW_LEFT = '\x1b[D';
export const ARROW_RIGHT = '\x1b[C';
export const SHIFT_TAB = '\x1b[Z';

export const TOOLBAR_ROWS_MIN = 1;
export const TOOLBAR_ROWS_MAX = 3;
export const TOOLBAR_COLS_MIN = 3;
export const TOOLBAR_COLS_MAX = 8;

/**
 * Resize a layout in row-major order. Cells that still fit are preserved;
 * overflow drops; new tail pads with null. A column count change therefore
 * reshuffles cells — accepted because re-anchoring by (row, col) loses user
 * intent when they shrink columns then grow them again.
 */
export function resizeToolbarLayout(
  prev: ToolbarLayout,
  nextRows: number,
  nextCols: number,
): ToolbarLayout {
  const nextCells: (ToolbarKey | null)[] = [];
  for (let i = 0; i < nextRows * nextCols; i++) {
    nextCells.push(prev.cells[i] ?? null);
  }
  return { rows: nextRows, cols: nextCols, cells: nextCells };
}

export const DEFAULT_TOOLBAR_LAYOUT: ToolbarLayout = {
  rows: 2,
  cols: 6,
  cells: [
    // row 1: ctrl half (left), nav half (right)
    { id: 'ctrl-c', label: '^C', action: 'ctrl-letter', payload: 'c' },
    { id: 'ctrl-d', label: '^D', action: 'ctrl-letter', payload: 'd' },
    {
      id: 'shift-tab',
      label: '⇧Tab',
      action: 'plain',
      payload: SHIFT_TAB,
      title: 'cc 切换 plan / accept 模式',
    },
    { id: 'esc', label: 'Esc', action: 'plain', payload: '\x1b' },
    { id: 'up', label: '↑', action: 'plain', payload: ARROW_UP, ariaLabel: 'Up' },
    { id: 'tab', label: 'Tab', action: 'plain', payload: '\t' },
    // row 2
    { id: 'ctrl-l', label: '^L', action: 'ctrl-letter', payload: 'l' },
    {
      id: 'ctrl-r',
      label: '^R',
      action: 'ctrl-letter',
      payload: 'r',
      title: 'cc verbose toggle',
    },
    {
      id: 'sticky-ctrl',
      label: 'Ctrl',
      action: 'toggle-sticky-ctrl',
      payload: '',
      title: '按一下 Ctrl，下一键发 Ctrl+key',
    },
    { id: 'left', label: '←', action: 'plain', payload: ARROW_LEFT, ariaLabel: 'Left' },
    { id: 'down', label: '↓', action: 'plain', payload: ARROW_DOWN, ariaLabel: 'Down' },
    { id: 'right', label: '→', action: 'plain', payload: ARROW_RIGHT, ariaLabel: 'Right' },
  ],
};
