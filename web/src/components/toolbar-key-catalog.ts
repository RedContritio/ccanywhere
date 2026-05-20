import {
  ARROW_DOWN,
  ARROW_LEFT,
  ARROW_RIGHT,
  ARROW_UP,
  SHIFT_TAB,
  type ToolbarKey,
} from './toolbar-layout.js';

/**
 * Catalog of pre-defined keys the user can drop into any cell. Each entry
 * is a "template": when picked, the catalog clones it and assigns a fresh
 * `id` (cell index + suffix) so layouts can repeat the same key in
 * multiple cells without duplicate-id schema errors.
 *
 * Grouping is purely visual (sections in the picker UI). Adding entries
 * here is the only change needed to support a new built-in key — the
 * dispatcher in MobileToolbar already handles all three actions.
 */
export interface CatalogEntry {
  readonly group: 'nav' | 'mod' | 'control';
  readonly template: ToolbarKey;
}

const ESC_BYTE = '\x1b';
const TAB_BYTE = '\t';
const ENTER_BYTE = '\r';
const BACKSPACE_BYTE = '\x7f'; // matches what xterm sends
const HOME = '\x1b[H';
const END = '\x1b[F';
const PG_UP = '\x1b[5~';
const PG_DOWN = '\x1b[6~';
const DELETE_KEY = '\x1b[3~';

export const KEY_CATALOG: ReadonlyArray<CatalogEntry> = [
  // ── nav ──
  { group: 'nav', template: { id: 'up', label: '↑', action: 'plain', payload: ARROW_UP, ariaLabel: 'Up' } },
  { group: 'nav', template: { id: 'down', label: '↓', action: 'plain', payload: ARROW_DOWN, ariaLabel: 'Down' } },
  { group: 'nav', template: { id: 'left', label: '←', action: 'plain', payload: ARROW_LEFT, ariaLabel: 'Left' } },
  { group: 'nav', template: { id: 'right', label: '→', action: 'plain', payload: ARROW_RIGHT, ariaLabel: 'Right' } },
  { group: 'nav', template: { id: 'home', label: 'Home', action: 'plain', payload: HOME } },
  { group: 'nav', template: { id: 'end', label: 'End', action: 'plain', payload: END } },
  { group: 'nav', template: { id: 'pgup', label: 'PgUp', action: 'plain', payload: PG_UP } },
  { group: 'nav', template: { id: 'pgdn', label: 'PgDn', action: 'plain', payload: PG_DOWN } },
  // ── modifier-ish single keys ──
  { group: 'mod', template: { id: 'esc', label: 'Esc', action: 'plain', payload: ESC_BYTE } },
  { group: 'mod', template: { id: 'tab', label: 'Tab', action: 'plain', payload: TAB_BYTE } },
  {
    group: 'mod',
    template: { id: 'shift-tab', label: '⇧Tab', action: 'plain', payload: SHIFT_TAB, title: 'cc 切换 plan / accept 模式' },
  },
  { group: 'mod', template: { id: 'enter', label: 'Enter', action: 'plain', payload: ENTER_BYTE } },
  { group: 'mod', template: { id: 'bs', label: '⌫', action: 'plain', payload: BACKSPACE_BYTE, ariaLabel: 'Backspace' } },
  { group: 'mod', template: { id: 'del', label: 'Del', action: 'plain', payload: DELETE_KEY } },
  // ── Ctrl-prefixed shortcuts ──
  {
    group: 'control',
    template: { id: 'sticky-ctrl', label: 'Ctrl', action: 'toggle-sticky-ctrl', payload: '', title: '按一下 Ctrl，下一键发 Ctrl+key' },
  },
  ...buildCtrlLetters(),
];

function buildCtrlLetters(): CatalogEntry[] {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  return Array.from(letters, (ch) => ({
    group: 'control' as const,
    template: {
      id: `ctrl-${ch}`,
      label: `^${ch.toUpperCase()}`,
      action: 'ctrl-letter' as const,
      payload: ch,
    },
  }));
}

export interface CatalogPickerGroup {
  readonly group: CatalogEntry['group'];
  readonly title: string;
  readonly entries: ReadonlyArray<CatalogEntry>;
}

export function groupedCatalog(): ReadonlyArray<CatalogPickerGroup> {
  const groups: Record<CatalogEntry['group'], CatalogEntry[]> = {
    nav: [],
    mod: [],
    control: [],
  };
  for (const entry of KEY_CATALOG) {
    groups[entry.group].push(entry);
  }
  return [
    { group: 'nav', title: '方向 / 翻页', entries: groups.nav },
    { group: 'mod', title: '常用控制', entries: groups.mod },
    { group: 'control', title: 'Ctrl-X 快捷', entries: groups.control },
  ];
}

/**
 * Clone a catalog template into a placed cell. Caller supplies the grid
 * index so the resulting `id` is layout-unique (catalog templates share
 * stable ids — repeating "^C" in two cells would otherwise crash the
 * server schema's duplicate-id check).
 */
export function instantiateCatalogEntry(entry: CatalogEntry, cellIndex: number): ToolbarKey {
  return { ...entry.template, id: `${entry.template.id}-cell${cellIndex}` };
}
