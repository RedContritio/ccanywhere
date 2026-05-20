import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetPrefsStoresForTest, usePrefsStore } from '../state/prefs.js';
import { ToolbarConfigSection } from './toolbar-config-section.js';

function mockJsonResponse(body: object): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function getCells(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll('[data-slot="toolbar-cell"]'),
  ) as HTMLElement[];
}

function getCatalogKeys(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll('[data-slot="toolbar-catalog-key"]'),
  ) as HTMLElement[];
}

/**
 * ToolbarConfigSection is the non-dialog rewrite of the old
 * ToolbarEditDialog, lifted into /settings under B4.
 * Same edit / save / reset logic, no open/close lifecycle.
 */
describe('ToolbarConfigSection', () => {
  beforeEach(() => {
    resetPrefsStoresForTest();
    globalThis.fetch = vi.fn().mockResolvedValue(mockJsonResponse({}));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders row/col selectors + grid', () => {
    render(<ToolbarConfigSection />);
    expect(screen.getByText('快捷栏布局')).toBeInTheDocument();
    expect(screen.getByText('行')).toBeInTheDocument();
    expect(screen.getByText('列')).toBeInTheDocument();
    expect(getCells().length).toBeGreaterThan(0);
  });

  it('clicking a cell opens key picker with grouped catalog', () => {
    render(<ToolbarConfigSection />);
    fireEvent.click(getCells()[0]!);
    expect(screen.getByText('方向 / 翻页')).toBeInTheDocument();
    expect(screen.getByText('常用控制')).toBeInTheDocument();
    expect(screen.getByText('Ctrl-X 快捷')).toBeInTheDocument();
  });

  it('picking from catalog updates the cell label', () => {
    render(<ToolbarConfigSection />);
    fireEvent.click(getCells()[0]!);
    const escKey = getCatalogKeys().find((b) => b.textContent === 'Esc');
    expect(escKey).toBeDefined();
    fireEvent.click(escKey!);
    expect(screen.queryByText('方向 / 翻页')).toBeNull();
    expect(getCells()[0]!.textContent).toBe('Esc');
  });

  it('clear cell sets it to empty placeholder', () => {
    render(<ToolbarConfigSection />);
    fireEvent.click(getCells()[0]!);
    fireEvent.click(screen.getByText('清空'));
    expect(getCells()[0]!.textContent).toBe('+');
  });

  it('save calls saveToolbar with the draft', async () => {
    const fetchFn = vi.fn().mockResolvedValue(mockJsonResponse({}));
    globalThis.fetch = fetchFn;
    render(<ToolbarConfigSection />);

    await act(async () => {
      fireEvent.click(screen.getByText('保存'));
    });

    await waitFor(() => {
      expect(fetchFn).toHaveBeenCalledWith(
        '/api/me/preferences',
        expect.objectContaining({ method: 'PUT' }),
      );
    });
  });

  it('reset to default sends null toolbar', async () => {
    const fetchFn = vi.fn().mockResolvedValue(mockJsonResponse({}));
    globalThis.fetch = fetchFn;
    render(<ToolbarConfigSection />);

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
  });

  it('save error surfaces inline', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('boom'));
    usePrefsStore.setState({
      toolbar: { rows: 1, cols: 3, cells: [null, null, null] },
      loaded: true,
      loadError: null,
    });
    render(<ToolbarConfigSection />);

    await act(async () => {
      fireEvent.click(screen.getByText('保存'));
    });

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/boom/);
    });
  });

  // Grid resize via Radix Select is awkward to drive in jsdom (Portal +
  // pointer events). The resizeLayout function and ToolbarCell rendering
  // are covered by unit tests; the integration "rows select grows grid"
  // path will be re-covered by the e2e visual spec.
  it.skip('changing rows grows/shrinks the grid', () => {
    /* covered by e2e */
  });
});
