import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ListBase } from './list-base.js';

interface Item {
  id: string;
  label: string;
  meta: string;
}

const items: Item[] = [
  { id: 'a', label: 'Alpha', meta: '2h' },
  { id: 'b', label: 'Beta', meta: '1d' },
  { id: 'c', label: 'Gamma', meta: '3d' },
];

describe('ListBase', () => {
  it('renders empty state with custom label when items is []', () => {
    render(
      <ListBase
        items={[]}
        getKey={(x: Item) => x.id}
        renderPrimary={(x) => x.label}
        emptyLabel="无项目"
        ariaLabel="projects"
      />,
    );
    expect(screen.getByText('无项目')).toBeInTheDocument();
  });

  it('renders primary text for every item', () => {
    render(
      <ListBase
        items={items}
        getKey={(x) => x.id}
        renderPrimary={(x) => x.label}
      />,
    );
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(screen.getByText('Gamma')).toBeInTheDocument();
  });

  it('renders secondary slot in monospace when provided', () => {
    render(
      <ListBase
        items={items}
        getKey={(x) => x.id}
        renderPrimary={(x) => x.label}
        renderSecondary={(x) => x.meta}
      />,
    );
    const meta = screen.getByText('2h');
    expect(meta).toBeInTheDocument();
    expect(meta.className).toMatch(/font-mono/);
  });

  it('renders as radiogroup with role=radio when onSelect provided', () => {
    render(
      <ListBase
        items={items}
        getKey={(x) => x.id}
        renderPrimary={(x) => x.label}
        selectedKey="b"
        onSelect={() => {}}
        ariaLabel="picker"
      />,
    );
    const group = screen.getByRole('radiogroup', { name: 'picker' });
    expect(group).toBeInTheDocument();
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(3);
    expect(radios[1]).toHaveAttribute('aria-checked', 'true');
    expect(radios[0]).toHaveAttribute('aria-checked', 'false');
  });

  it('calls onSelect with key when interactive row clicked', () => {
    const onSelect = vi.fn();
    render(
      <ListBase
        items={items}
        getKey={(x) => x.id}
        renderPrimary={(x) => x.label}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByText('Beta'));
    expect(onSelect).toHaveBeenCalledWith('b');
  });

  it('renders as static list (role=list / listitem) without onSelect', () => {
    render(
      <ListBase
        items={items}
        getKey={(x) => x.id}
        renderPrimary={(x) => x.label}
        ariaLabel="static"
      />,
    );
    expect(screen.getByRole('list', { name: 'static' })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  // A long list inside a dialog must scroll within itself rather than grow
  // the dialog — otherwise sibling controls (sort buttons, mode tabs) get
  // pushed off-screen on mobile. `scroll` flips overflow + min-h-0 so the
  // caller's flex layout can shrink it.
  it('scrolls internally + allows flex shrink when scroll is set', () => {
    render(
      <ListBase
        items={items}
        getKey={(x) => x.id}
        renderPrimary={(x) => x.label}
        onSelect={() => {}}
        ariaLabel="picker"
        scroll
      />,
    );
    const group = screen.getByRole('radiogroup', { name: 'picker' });
    expect(group.className).toMatch(/overflow-y-auto/);
    expect(group.className).toMatch(/min-h-0/);
  });
});
