import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EmptyState } from './empty-state.js';
import { ErrorState } from './error-state.js';
import { LoadingState } from './loading-state.js';
import { Skeleton } from './skeleton.js';

describe('EmptyState', () => {
  it('renders title + role=status', () => {
    const { container } = render(<EmptyState title="还没有数据" />);
    expect(screen.getByText('还没有数据')).toBeInTheDocument();
    expect(container.querySelector('[role="status"]')).not.toBeNull();
  });

  it('renders optional description + action', () => {
    render(
      <EmptyState
        title="t"
        description="d"
        action={<button type="button">go</button>}
      />,
    );
    expect(screen.getByText('d')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'go' })).toBeInTheDocument();
  });
});

describe('ErrorState', () => {
  it('renders string error + role=alert + 加载失败 prefix', () => {
    const { container } = render(<ErrorState error="network down" />);
    expect(screen.getByText(/加载失败：network down/)).toBeInTheDocument();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('renders Error.message', () => {
    render(<ErrorState error={new Error('boom')} />);
    expect(screen.getByText(/加载失败：boom/)).toBeInTheDocument();
  });

  it('renders unknown via String()', () => {
    render(<ErrorState error={{ foo: 'bar' }} />);
    expect(screen.getByText(/加载失败：\[object Object\]/)).toBeInTheDocument();
  });

  it('renders optional retry action', () => {
    render(
      <ErrorState
        error="x"
        retry={<button type="button">retry</button>}
      />,
    );
    expect(screen.getByRole('button', { name: 'retry' })).toBeInTheDocument();
  });
});

describe('LoadingState', () => {
  it('default label 加载中…', () => {
    render(<LoadingState />);
    expect(screen.getByText('加载中…')).toBeInTheDocument();
  });

  it('custom label + aria-busy', () => {
    render(<LoadingState label="等候中" />);
    const el = screen.getByText('等候中');
    expect(el).toHaveAttribute('aria-busy', 'true');
  });
});

describe('Skeleton', () => {
  it('renders default count=1 text variant', () => {
    const { container } = render(<Skeleton />);
    const bars = container.querySelectorAll('[aria-hidden="true"]');
    expect(bars.length).toBe(1);
  });

  it('renders N bars per count', () => {
    const { container } = render(<Skeleton count={5} variant="list-row" />);
    expect(container.querySelectorAll('[aria-hidden="true"]').length).toBe(5);
  });

  it('uses animate-pulse', () => {
    const { container } = render(<Skeleton />);
    const bar = container.querySelector('[aria-hidden="true"]');
    expect(bar?.className).toMatch(/animate-pulse/);
  });

  it('outer wrapper has role=status + aria-busy', () => {
    const { container } = render(<Skeleton />);
    const outer = container.querySelector('[role="status"]');
    expect(outer).not.toBeNull();
    expect(outer).toHaveAttribute('aria-busy', 'true');
  });
});
