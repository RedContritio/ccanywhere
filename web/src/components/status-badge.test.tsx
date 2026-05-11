import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusBadge } from './status-badge.js';

describe('StatusBadge', () => {
  it('renders all 4 SessionState labels as monospace text', () => {
    const { rerender } = render(<StatusBadge state="starting" />);
    expect(screen.getByText('starting')).toBeInTheDocument();
    rerender(<StatusBadge state="idle" />);
    expect(screen.getByText('idle')).toBeInTheDocument();
    rerender(<StatusBadge state="busy" />);
    expect(screen.getByText('busy')).toBeInTheDocument();
    rerender(<StatusBadge state="dead" />);
    expect(screen.getByText('dead')).toBeInTheDocument();
  });

  it('applies color class per state (per DP7 mapping)', () => {
    const { rerender } = render(<StatusBadge state="starting" />);
    expect(screen.getByText('starting').className).toMatch(/text-brand/);
    rerender(<StatusBadge state="idle" />);
    expect(screen.getByText('idle').className).toMatch(/text-fg-muted/);
    rerender(<StatusBadge state="busy" />);
    expect(screen.getByText('busy').className).toMatch(/text-warning/);
    rerender(<StatusBadge state="dead" />);
    expect(screen.getByText('dead').className).toMatch(/text-danger/);
  });

  it('always applies font-mono and provides aria-label', () => {
    render(<StatusBadge state="busy" />);
    const el = screen.getByText('busy');
    expect(el.className).toMatch(/font-mono/);
    expect(el).toHaveAttribute('aria-label', 'state: busy');
  });

  it('accepts custom className appended after defaults', () => {
    render(<StatusBadge state="idle" className="custom-x" />);
    const el = screen.getByText('idle');
    expect(el.className).toMatch(/custom-x/);
    expect(el.className).toMatch(/font-mono/);
  });
});
