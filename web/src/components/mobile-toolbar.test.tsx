import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetPrefsStoresForTest, usePrefsStore } from '../state/prefs.js';
import { MobileToolbar } from './mobile-toolbar.js';
import { DEFAULT_TOOLBAR_LAYOUT, type ToolbarLayout } from './toolbar-layout.js';

function mockJsonResponse(body: object): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('MobileToolbar', () => {
  beforeEach(() => {
    resetPrefsStoresForTest();
    // Default: server returns no toolbar, so we render the built-in default.
    globalThis.fetch = vi.fn().mockResolvedValue(mockJsonResponse({}));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the default layout when prefs store has no toolbar', async () => {
    render(<MobileToolbar onKey={() => {}} />);
    // Default contains an Esc cell + ↑ + Ctrl among others.
    expect(screen.getByText('Esc')).toBeInTheDocument();
    expect(screen.getByLabelText('Up')).toBeInTheDocument();
    expect(screen.getByText('Ctrl')).toBeInTheDocument();
    expect(screen.getAllByRole('button').length).toBe(
      DEFAULT_TOOLBAR_LAYOUT.cells.filter((c) => c !== null).length,
    );
  });

  it('plain action forwards payload to onKey', () => {
    const onKey = vi.fn();
    render(<MobileToolbar onKey={onKey} />);
    fireEvent.click(screen.getByText('Esc'));
    expect(onKey).toHaveBeenCalledWith('\x1b');
  });

  it('ctrl-letter action translates a..z to its control byte', () => {
    const onKey = vi.fn();
    render(<MobileToolbar onKey={onKey} />);
    fireEvent.click(screen.getByText('^C'));
    // 'c' & 0x1f = 0x03
    expect(onKey).toHaveBeenCalledWith('\x03');
  });

  it('toggle-sticky-ctrl flips aria-pressed without sending bytes', () => {
    const onKey = vi.fn();
    render(<MobileToolbar onKey={onKey} />);
    const ctrl = screen.getByText('Ctrl');
    expect(ctrl).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(ctrl);
    expect(ctrl).toHaveAttribute('aria-pressed', 'true');
    // Plain key after sticky-ctrl still emits its raw payload (sticky Ctrl
    // is a UI affordance; the backend never receives a separate Ctrl byte).
    expect(onKey).not.toHaveBeenCalled();
  });

  it('renders a custom layout from the prefs store with empty cells', async () => {
    const layout: ToolbarLayout = {
      rows: 1,
      cols: 4,
      cells: [
        { id: 'esc', label: 'Esc', action: 'plain', payload: '\x1b' },
        null,
        { id: 'down', label: '↓', action: 'plain', payload: '\x1b[B' },
        null,
      ],
    };
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(mockJsonResponse({ toolbar: layout }));

    await act(async () => {
      await usePrefsStore.getState().load();
    });
    render(<MobileToolbar onKey={() => {}} />);

    await waitFor(() => {
      expect(screen.getAllByRole('button').length).toBe(2);
    });
    expect(screen.getByText('Esc')).toBeInTheDocument();
    expect(screen.getByText('↓')).toBeInTheDocument();
  });

  it('mount triggers prefs.load() exactly once', async () => {
    const fetchFn = vi.fn().mockResolvedValue(mockJsonResponse({}));
    globalThis.fetch = fetchFn;
    render(<MobileToolbar onKey={() => {}} />);
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/me/preferences',
      expect.objectContaining({ credentials: 'include' }),
    );
  });
});
