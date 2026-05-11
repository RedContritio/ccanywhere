import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { usePrefsStore } from '../state/prefs.js';
import { DialogBase } from './dialog-base.js';
import { ToolbarCatalogKey } from './toolbar-catalog-key.js';
import { ToolbarCell } from './toolbar-cell.js';
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

function resizeLayout(
  prev: ToolbarLayout,
  nextRows: number,
  nextCols: number,
): ToolbarLayout {
  // Preserve cells that still fit; drop overflow; pad with null. Row-major
  // layout means a column count change reshuffles cells — accept that,
  // since re-anchoring by original (row, col) loses user intent when they
  // shrink columns then grow them again.
  const nextCells: (ToolbarKey | null)[] = [];
  for (let i = 0; i < nextRows * nextCols; i++) {
    nextCells.push(prev.cells[i] ?? null);
  }
  return { rows: nextRows, cols: nextCols, cells: nextCells };
}

/**
 * m-user-prefs chunk C: edit dialog. Click a cell to open a key picker
 * (catalog grouped by nav / mod / control). Save → PUT prefs to server;
 * reset → PUT { toolbar: null } (server returns {} → frontend renders
 * built-in default).
 *
 * Visual rewrite under m-design-system-unify C3. Logic and layout
 * structure remain untouched — the C4 commit will lift this content
 * into the new `/settings` page (B4) and decompose further.
 */
export function ToolbarEditDialog({
  open,
  onClose,
}: Props): JSX.Element {
  const remoteLayout = usePrefsStore((s) => s.toolbar);
  const saveToolbar = usePrefsStore((s) => s.saveToolbar);

  const [draft, setDraft] = useState<ToolbarLayout>(
    remoteLayout ?? DEFAULT_TOOLBAR_LAYOUT,
  );
  const [pickerCell, setPickerCell] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setDraft(remoteLayout ?? DEFAULT_TOOLBAR_LAYOUT);
      setPickerCell(null);
      setError(null);
    }
  }, [open, remoteLayout]);

  const setRows = (rows: number): void =>
    setDraft((d) => resizeLayout(d, rows, d.cols));
  const setCols = (cols: number): void =>
    setDraft((d) => resizeLayout(d, d.rows, cols));

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

  const rowOptions = Array.from(
    { length: ROWS_MAX - ROWS_MIN + 1 },
    (_, i) => ROWS_MIN + i,
  );
  const colOptions = Array.from(
    { length: COLS_MAX - COLS_MIN + 1 },
    (_, i) => COLS_MIN + i,
  );

  return (
    <DialogBase
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
      title="快捷栏布局"
      size="lg"
      footer={
        <>
          <Button
            type="button"
            variant="ghost"
            onClick={() => void onResetToDefault()}
            disabled={busy}
          >
            重置默认
          </Button>
          <div className="flex-1" />
          <Button
            type="button"
            variant="secondary"
            onClick={onClose}
            disabled={busy}
          >
            取消
          </Button>
          <Button
            type="button"
            onClick={() => void onSave()}
            disabled={busy}
          >
            {busy ? '保存中…' : '保存'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex items-center gap-4">
          <div className="space-y-1.5">
            <Label>行</Label>
            <Select
              value={String(draft.rows)}
              onValueChange={(v) => setRows(Number(v))}
              disabled={busy}
            >
              <SelectTrigger className="w-20">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {rowOptions.map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>列</Label>
            <Select
              value={String(draft.cols)}
              onValueChange={(v) => setCols(Number(v))}
              disabled={busy}
            >
              <SelectTrigger className="w-20">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {colOptions.map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div
          className="grid gap-1.5"
          style={{
            gridTemplateColumns: `repeat(${draft.cols}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${draft.rows}, minmax(2.5rem, 1fr))`,
          }}
        >
          {draft.cells.map((cell, idx) => (
            <ToolbarCell
              key={`cell-${idx}`}
              cell={cell}
              index={idx}
              disabled={busy}
              selected={pickerCell === idx}
              onClick={setPickerCell}
            />
          ))}
        </div>

        {pickerCell !== null && (
          <div className="space-y-3 rounded-md border border-border bg-muted/30 p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm">
                选 cell{' '}
                <span className="font-mono">
                  {Math.floor(pickerCell / draft.cols) + 1} 行{' '}
                  {(pickerCell % draft.cols) + 1} 列
                </span>{' '}
                的按键
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onClearCell}
              >
                清空
              </Button>
            </div>
            {groupedCatalog().map((group) => (
              <fieldset
                key={group.group}
                className="space-y-1.5 border-t border-border pt-2"
              >
                <legend className="px-1 text-xs text-fg-muted">
                  {group.title}
                </legend>
                <div className="flex flex-wrap gap-1">
                  {group.entries.map((entry) => (
                    <ToolbarCatalogKey
                      key={entry.template.id}
                      entry={entry}
                      onClick={onPickFromCatalog}
                    />
                  ))}
                </div>
              </fieldset>
            ))}
            <div className="flex justify-end">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setPickerCell(null)}
              >
                取消选择
              </Button>
            </div>
          </div>
        )}

        {error !== null && (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        )}
      </div>
    </DialogBase>
  );
}
