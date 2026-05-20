import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ToolbarCell } from './toolbar-cell.js';
import type { ToolbarKey } from './toolbar-layout.js';

const sampleKey: ToolbarKey = {
  id: 'esc',
  label: 'Esc',
  action: 'plain',
  payload: '\x1b',
};

describe('ToolbarCell', () => {
  it('renders + placeholder for empty cell', () => {
    render(<ToolbarCell cell={null} index={0} onClick={() => {}} />);
    expect(screen.getByRole('button').textContent).toBe('+');
  });

  it('renders the key label for filled cell', () => {
    render(<ToolbarCell cell={sampleKey} index={3} onClick={() => {}} />);
    expect(screen.getByText('Esc')).toBeInTheDocument();
  });

  it('invokes onClick with the cell index', () => {
    const onClick = vi.fn();
    render(<ToolbarCell cell={null} index={5} onClick={onClick} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledWith(5);
  });

  it('applies ring class when selected', () => {
    render(
      <ToolbarCell cell={null} index={0} selected onClick={() => {}} />,
    );
    expect(screen.getByRole('button').className).toMatch(/ring-2/);
  });

  it('respects disabled', () => {
    const onClick = vi.fn();
    render(
      <ToolbarCell cell={null} index={0} disabled onClick={onClick} />,
    );
    const btn = screen.getByRole('button');
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('empty cell uses dashed border class; filled uses solid muted', () => {
    const { rerender } = render(
      <ToolbarCell cell={null} index={0} onClick={() => {}} />,
    );
    expect(screen.getByRole('button').className).toMatch(/border-dashed/);
    rerender(<ToolbarCell cell={sampleKey} index={0} onClick={() => {}} />);
    expect(screen.getByRole('button').className).toMatch(/bg-muted/);
  });
});
