import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ToolbarCatalogKey } from './toolbar-catalog-key.js';
import type { CatalogEntry } from './toolbar-key-catalog.js';

const entry: CatalogEntry = {
  group: 'mod',
  template: {
    id: 'esc',
    label: 'Esc',
    action: 'plain',
    payload: '\x1b',
    title: 'send escape',
  },
};

describe('ToolbarCatalogKey', () => {
  it('renders the entry label', () => {
    render(<ToolbarCatalogKey entry={entry} onClick={() => {}} />);
    expect(screen.getByText('Esc')).toBeInTheDocument();
  });

  it('forwards title attribute from the template', () => {
    render(<ToolbarCatalogKey entry={entry} onClick={() => {}} />);
    expect(screen.getByRole('button')).toHaveAttribute('title', 'send escape');
  });

  it('invokes onClick with the entry', () => {
    const onClick = vi.fn();
    render(<ToolbarCatalogKey entry={entry} onClick={onClick} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledWith(entry);
  });

  it('uses mono font + brand hover styling', () => {
    render(<ToolbarCatalogKey entry={entry} onClick={() => {}} />);
    const btn = screen.getByRole('button');
    expect(btn.className).toMatch(/font-mono/);
    expect(btn.className).toMatch(/hover:border-brand/);
  });
});
