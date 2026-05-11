import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetPrefsStoresForTest, usePrefsStore } from '../state/prefs.js';
import { ToolbarEditDialog } from './toolbar-edit-dialog.js';

function mockJsonResponse(body: object): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('ToolbarEditDialog', () => {
  beforeEach(() => {
    resetPrefsStoresForTest();
    globalThis.fetch = vi.fn().mockResolvedValue(mockJsonResponse({}));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders nothing when open=false', () => {
    render(<ToolbarEditDialog open={false} onClose={() => {}} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('open=true renders dialog with row/col selectors + grid', () => {
    render(<ToolbarEditDialog open={true} onClose={() => {}} />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('快捷栏布局')).toBeInTheDocument();
    expect(screen.getByText('行')).toBeInTheDocument();
    expect(screen.getByText('列')).toBeInTheDocument();
  });

  it('clicking a cell opens key picker with grouped catalog', () => {
    render(<ToolbarEditDialog open={true} onClose={() => {}} />);
    // First cell (^C in default layout)
    const cells = screen.getAllByRole('button').filter((b) =>
      b.className.includes('toolbar-edit-cell'),
    );
    fireEvent.click(cells[0]!);
    // Picker should show group titles
    expect(screen.getByText('方向 / 翻页')).toBeInTheDocument();
    expect(screen.getByText('常用控制')).toBeInTheDocument();
    expect(screen.getByText('Ctrl-X 快捷')).toBeInTheDocument();
  });

  it('picking from catalog updates the cell label', () => {
    render(<ToolbarEditDialog open={true} onClose={() => {}} />);
    const cells = screen.getAllByRole('button').filter((b) =>
      b.className.includes('toolbar-edit-cell'),
    );
    fireEvent.click(cells[0]!);
    // Pick Esc from catalog
    const escButtons = screen
      .getAllByRole('button')
      .filter((b) => b.textContent === 'Esc' && b.className.includes('catalog-key'));
    fireEvent.click(escButtons[0]!);
    // Picker closed
    expect(screen.queryByText('方向 / 翻页')).toBeNull();
    // Cell now shows Esc (the first cell-button's text)
    const cellsAfter = screen.getAllByRole('button').filter((b) =>
      b.className.includes('toolbar-edit-cell'),
    );
    expect(cellsAfter[0]!.textContent).toBe('Esc');
  });

  it('clear cell sets it to empty placeholder', () => {
    render(<ToolbarEditDialog open={true} onClose={() => {}} />);
    const cells = screen.getAllByRole('button').filter((b) =>
      b.className.includes('toolbar-edit-cell'),
    );
    fireEvent.click(cells[0]!);
    fireEvent.click(screen.getByText('清空'));
    const cellsAfter = screen.getAllByRole('button').filter((b) =>
      b.className.includes('toolbar-edit-cell'),
    );
    expect(cellsAfter[0]!.textContent).toBe('+');
  });

  it('save calls saveToolbar with the draft and closes', async () => {
    const onClose = vi.fn();
    const fetchFn = vi.fn().mockResolvedValue(mockJsonResponse({}));
    globalThis.fetch = fetchFn;
    render(<ToolbarEditDialog open={true} onClose={onClose} />);

    await act(async () => {
      fireEvent.click(screen.getByText('保存'));
    });

    await waitFor(() => {
      expect(fetchFn).toHaveBeenCalledWith(
        '/api/me/preferences',
        expect.objectContaining({ method: 'PUT' }),
      );
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('reset to default sends null toolbar and closes', async () => {
    const onClose = vi.fn();
    const fetchFn = vi.fn().mockResolvedValue(mockJsonResponse({}));
    globalThis.fetch = fetchFn;
    render(<ToolbarEditDialog open={true} onClose={onClose} />);

    await act(async () => {
      fireEvent.click(screen.getByText('重置默认'));
    });

    await waitFor(() => {
      const putCall = fetchFn.mock.calls.find(
        (c: unknown[]) => (c[1] as { method?: string }).method === 'PUT',
      );
      expect(putCall).toBeDefined();
      const init = putCall![1] as { body: string };
      expect(JSON.parse(init.body)).toEqual({ toolbar: null });
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('save error stays open and surfaces error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('boom'));
    // Pre-populate store with non-default layout so save is meaningful
    usePrefsStore.setState({
      toolbar: { rows: 1, cols: 3, cells: [null, null, null] },
      loaded: true,
      loadError: null,
    });
    const onClose = vi.fn();
    render(<ToolbarEditDialog open={true} onClose={onClose} />);

    await act(async () => {
      fireEvent.click(screen.getByText('保存'));
    });

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/boom/);
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('changing rows grows/shrinks the grid', () => {
    render(<ToolbarEditDialog open={true} onClose={() => {}} />);
    const rowsSelect = screen.getByText('行').parentElement!.querySelector('select')!;
    const cellsBefore = screen.getAllByRole('button').filter((b) =>
      b.className.includes('toolbar-edit-cell'),
    ).length;

    fireEvent.change(rowsSelect, { target: { value: '3' } });

    const cellsAfter = screen.getAllByRole('button').filter((b) =>
      b.className.includes('toolbar-edit-cell'),
    ).length;
    // 6 cols × 3 rows = 18 cells (was 6 × 2 = 12)
    expect(cellsAfter).toBe(18);
    expect(cellsAfter).toBeGreaterThan(cellsBefore);
  });
});
