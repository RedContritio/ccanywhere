import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  ActiveHeaderIcons,
  DeadHeaderActions,
  SidebarGlobalActions,
} from './workspace-header-actions.js';

describe('ActiveHeaderIcons', () => {
  it('renders share + reload only (no quota / settings — moved to sidebar)', () => {
    render(<ActiveHeaderIcons onShare={() => {}} onReload={() => {}} />);
    expect(
      screen.getByRole('button', { name: '分享当前 session' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '刷新页面' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '查看配额' })).toBeNull();
    expect(screen.queryByRole('button', { name: '设置' })).toBeNull();
  });

  it('fires onShare when ↗ is clicked', () => {
    const onShare = vi.fn();
    render(<ActiveHeaderIcons onShare={onShare} onReload={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '分享当前 session' }));
    expect(onShare).toHaveBeenCalledTimes(1);
  });

  it('fires onReload when ↻ is clicked', () => {
    const onReload = vi.fn();
    render(<ActiveHeaderIcons onShare={() => {}} onReload={onReload} />);
    fireEvent.click(screen.getByRole('button', { name: '刷新页面' }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });
});

describe('SidebarGlobalActions', () => {
  it('renders 3 global config buttons (settings / quota / feedback)', () => {
    render(
      <SidebarGlobalActions
        onSettings={() => {}}
        onQuota={() => {}}
        onFeedback={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: '设置' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '查看配额' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '反馈' })).toBeInTheDocument();
  });

  it('fires each callback when its button is clicked', () => {
    const onSettings = vi.fn();
    const onQuota = vi.fn();
    const onFeedback = vi.fn();
    render(
      <SidebarGlobalActions
        onSettings={onSettings}
        onQuota={onQuota}
        onFeedback={onFeedback}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    fireEvent.click(screen.getByRole('button', { name: '查看配额' }));
    fireEvent.click(screen.getByRole('button', { name: '反馈' }));
    expect(onSettings).toHaveBeenCalledTimes(1);
    expect(onQuota).toHaveBeenCalledTimes(1);
    expect(onFeedback).toHaveBeenCalledTimes(1);
  });
});

describe('DeadHeaderActions', () => {
  it('renders Resume + delete; no share', () => {
    render(
      <DeadHeaderActions
        busy={false}
        onResume={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '删除' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '分享当前 session' }),
    ).toBeNull();
  });

  it('disables Resume + delete when busy', () => {
    render(
      <DeadHeaderActions
        busy
        onResume={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(
      screen.getByRole('button', { name: /正在重连/ }),
    ).toBeDisabled();
    expect(screen.getByRole('button', { name: '删除' })).toBeDisabled();
  });
});
