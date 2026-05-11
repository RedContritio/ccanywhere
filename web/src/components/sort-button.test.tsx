import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SortButton } from './sort-button.js';

describe('SortButton', () => {
  it('renders children label', () => {
    render(
      <SortButton active={false} dir={null} onClick={() => {}}>
        Name
      </SortButton>,
    );
    expect(screen.getByText('Name')).toBeInTheDocument();
  });

  it('shows ↓ arrow when active asc', () => {
    render(
      <SortButton active={true} dir="asc" onClick={() => {}}>
        Time
      </SortButton>,
    );
    expect(screen.getByText('↓')).toBeInTheDocument();
  });

  it('shows ↑ arrow when active desc', () => {
    render(
      <SortButton active={true} dir="desc" onClick={() => {}}>
        Time
      </SortButton>,
    );
    expect(screen.getByText('↑')).toBeInTheDocument();
  });

  it('no arrow when dir=null', () => {
    render(
      <SortButton active={false} dir={null} onClick={() => {}}>
        Time
      </SortButton>,
    );
    expect(screen.queryByText('↓')).not.toBeInTheDocument();
    expect(screen.queryByText('↑')).not.toBeInTheDocument();
  });

  it('active uses text-brand, inactive uses text-fg-muted', () => {
    const { rerender } = render(
      <SortButton active={true} dir="asc" onClick={() => {}}>
        T
      </SortButton>,
    );
    expect(screen.getByRole('button').className).toMatch(/text-brand/);
    rerender(
      <SortButton active={false} dir={null} onClick={() => {}}>
        T
      </SortButton>,
    );
    expect(screen.getByRole('button').className).toMatch(/text-fg-muted/);
  });

  it('invokes onClick when clicked', () => {
    const onClick = vi.fn();
    render(
      <SortButton active={false} dir={null} onClick={onClick}>
        T
      </SortButton>,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalled();
  });
});
