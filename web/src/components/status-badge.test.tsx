import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusBadge } from './status-badge.js';

describe('StatusBadge', () => {
  // B27: text variant renders BOTH the mono
  // label (desktop, `md:inline`) and the Chinese label (mobile, `md:hidden`)
  // — the inner mono <span> carries the english text, the inner zh <span>
  // carries 中文. Color / aria / custom className live on the outer wrapper.
  it('renders all 4 SessionState mono labels (desktop variant)', () => {
    const { rerender } = render(<StatusBadge state="starting" />);
    expect(screen.getByText('starting')).toBeInTheDocument();
    rerender(<StatusBadge state="idle" />);
    expect(screen.getByText('idle')).toBeInTheDocument();
    rerender(<StatusBadge state="busy" />);
    expect(screen.getByText('busy')).toBeInTheDocument();
    rerender(<StatusBadge state="dead" />);
    expect(screen.getByText('dead')).toBeInTheDocument();
  });

  it('renders Chinese labels (mobile variant)', () => {
    const { rerender } = render(<StatusBadge state="starting" />);
    expect(screen.getByText('启动中')).toBeInTheDocument();
    rerender(<StatusBadge state="idle" />);
    expect(screen.getByText('空闲')).toBeInTheDocument();
    rerender(<StatusBadge state="busy" />);
    expect(screen.getByText('忙')).toBeInTheDocument();
    rerender(<StatusBadge state="dead" />);
    expect(screen.getByText('已结束')).toBeInTheDocument();
  });

  it('applies color class on the outer wrapper (per DP7 mapping)', () => {
    const { rerender } = render(<StatusBadge state="starting" />);
    expect(screen.getByText('starting').parentElement?.className).toMatch(/text-brand/);
    rerender(<StatusBadge state="idle" />);
    expect(screen.getByText('idle').parentElement?.className).toMatch(/text-fg-muted/);
    rerender(<StatusBadge state="busy" />);
    expect(screen.getByText('busy').parentElement?.className).toMatch(/text-warning/);
    rerender(<StatusBadge state="dead" />);
    expect(screen.getByText('dead').parentElement?.className).toMatch(/text-danger/);
  });

  it('mono label has font-mono; aria-label lives on the outer wrapper', () => {
    render(<StatusBadge state="busy" />);
    const monoEl = screen.getByText('busy');
    expect(monoEl.className).toMatch(/font-mono/);
    expect(monoEl.parentElement).toHaveAttribute('aria-label', 'state: busy');
  });

  it('accepts custom className appended on the outer wrapper', () => {
    render(<StatusBadge state="idle" className="custom-x" />);
    const monoEl = screen.getByText('idle');
    expect(monoEl.parentElement?.className).toMatch(/custom-x/);
    expect(monoEl.className).toMatch(/font-mono/);
  });
});
