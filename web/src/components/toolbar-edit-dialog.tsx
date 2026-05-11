import { useEffect, useState } from 'react';
import { usePrefsStore } from '../state/prefs.js';
import {
  DEFAULT_TOOLBAR_LAYOUT,
  type ToolbarKey,
  type ToolbarLayout,
} from './toolbar-layout.js';
import {
  groupedCatalog,
  instantiateCatalogEntry,
  type CatalogEntry,
} from './toolbar-key-catalog.js';

interface Props {
  readonly open: boolean;
  readonly onClose: () => void;
}

const ROWS_MIN = 1;
const ROWS_MAX = 3;
const COLS_MIN = 3;
const COLS_MAX = 8;

function resizeLayout(prev: ToolbarLayout, nextRows: number, nextCols: number): ToolbarLayout {
  // Preserve cells that still fit in the new (row, col) coordinate; drop
  // overflow ones; pad new tracks with null. Row-major layout means a
  // column count change reshuffles cells — accept that, the alternative
  // (re-anchor cells by their original row/col) loses the user's intent
  // when they shrink columns then grow them again.
  const nextCells: (ToolbarKey | null)[] = [];
  for (let i = 0; i < nextRows * nextCols; i++) {
    nextCells.push(prev.cells[i] ?? null);
  }
  return { rows: nextRows, cols: nextCols, cells: nextCells };
}

/**
 * #m-user-prefs chunk C: edit dialog. Click a cell to open a key picker
 * (catalog grouped by nav / mod / control). Save → PUT prefs to server;
 * reset → PUT { toolbar: null } (server returns {} → frontend renders
 * built-in default).
 */
export function ToolbarEditDialog({ open, onClose }: Props): JSX.Element | null {
  const remoteLayout = usePrefsStore((s) => s.toolbar);
  const saveToolbar = usePrefsStore((s) => s.saveToolbar);

  const [draft, setDraft] = useState<ToolbarLayout>(remoteLayout ?? DEFAULT_TOOLBAR_LAYOUT);
  const [pickerCell, setPickerCell] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seed draft whenever the dialog opens (otherwise old edits persist
  // after close+reopen). When the remote layout updates (e.g. cross-device
  // edit landed), re-sync.
  useEffect(() => {
    if (open) {
      setDraft(remoteLayout ?? DEFAULT_TOOLBAR_LAYOUT);
      setPickerCell(null);
      setError(null);
    }
  }, [open, remoteLayout]);

  if (!open) return null;

  const setRows = (rows: number): void => setDraft((d) => resizeLayout(d, rows, d.cols));
  const setCols = (cols: number): void => setDraft((d) => resizeLayout(d, d.rows, cols));

  const setCellAt = (index: number, key: ToolbarKey | null): void => {
    setDraft((d) => {
      const nextCells = [...d.cells];
      nextCells[index] = key;
      return { ...d, cells: nextCells };
    });
  };

  const onPickFromCatalog = (entry: CatalogEntry): void => {
    if (pickerCell === null) return;
    setCellAt(pickerCell, instantiateCatalogEntry(entry, pickerCell));
    setPickerCell(null);
  };

  const onClearCell = (): void => {
    if (pickerCell === null) return;
    setCellAt(pickerCell, null);
    setPickerCell(null);
  };

  const onSave = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await saveToolbar(draft);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'save failed');
    } finally {
      setBusy(false);
    }
  };

  const onResetToDefault = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await saveToolbar(null);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'reset failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" onClick={onClose} role="presentation">
      <div
        className="dialog toolbar-edit-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="toolbar-edit-title"
      >
        <h2 id="toolbar-edit-title" className="dialog-title">
          快捷栏布局
        </h2>

        <div className="toolbar-edit-controls">
          <label className="dialog-field">
            <span>行</span>
            <select
              value={draft.rows}
              onChange={(e) => setRows(Number(e.target.value))}
              disabled={busy}
            >
              {Array.from({ length: ROWS_MAX - ROWS_MIN + 1 }, (_, i) => ROWS_MIN + i).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label className="dialog-field">
            <span>列</span>
            <select
              value={draft.cols}
              onChange={(e) => setCols(Number(e.target.value))}
              disabled={busy}
            >
              {Array.from({ length: COLS_MAX - COLS_MIN + 1 }, (_, i) => COLS_MIN + i).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div
          className="toolbar-edit-grid"
          style={
            {
              ['--mt-cols' as string]: String(draft.cols),
              ['--mt-rows' as string]: String(draft.rows),
            } as React.CSSProperties
          }
        >
          {draft.cells.map((cell, idx) => (
            <button
              key={`cell-${idx}`}
              type="button"
              className={`toolbar-edit-cell ${cell === null ? 'is-empty' : ''}`}
              onClick={() => setPickerCell(idx)}
              disabled={busy}
            >
              {cell !== null ? cell.label : '+'}
            </button>
          ))}
        </div>

        {pickerCell !== null && (
          <div className="toolbar-edit-picker">
            <div className="toolbar-edit-picker-header">
              <span>
                选 cell {Math.floor(pickerCell / draft.cols) + 1} 行
                {' '}
                {(pickerCell % draft.cols) + 1} 列 的按键
              </span>
              <button
                type="button"
                className="toolbar-edit-clear"
                onClick={onClearCell}
              >
                清空
              </button>
            </div>
            {groupedCatalog().map((group) => (
              <fieldset key={group.group} className="toolbar-edit-group">
                <legend>{group.title}</legend>
                <div className="toolbar-edit-group-keys">
                  {group.entries.map((entry) => (
                    <button
                      key={entry.template.id}
                      type="button"
                      className="toolbar-edit-catalog-key"
                      onClick={() => onPickFromCatalog(entry)}
                      title={entry.template.title}
                    >
                      {entry.template.label}
                    </button>
                  ))}
                </div>
              </fieldset>
            ))}
            <button
              type="button"
              className="toolbar-edit-picker-cancel"
              onClick={() => setPickerCell(null)}
            >
              取消选择
            </button>
          </div>
        )}

        {error !== null && (
          <p className="dialog-error" role="alert">
            {error}
          </p>
        )}

        <div className="dialog-actions">
          <button
            type="button"
            className="dialog-link"
            onClick={() => void onResetToDefault()}
            disabled={busy}
          >
            重置默认
          </button>
          <div className="dialog-actions-spacer" />
          <button
            type="button"
            className="dialog-cancel"
            onClick={onClose}
            disabled={busy}
          >
            取消
          </button>
          <button
            type="button"
            className="dialog-submit"
            onClick={() => void onSave()}
            disabled={busy}
          >
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}
