import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DialogBase } from './dialog-base.js';

describe('DialogBase', () => {
  it('renders title + body when open', () => {
    render(
      <DialogBase open onOpenChange={() => {}} title="Hello">
        <p>body</p>
      </DialogBase>,
    );
    // sr-only description fallback also contains title, so 2 matches:
    // one visible DialogTitle, one sr-only DialogDescription.
    expect(screen.getAllByText('Hello').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('body')).toBeInTheDocument();
  });

  it('does not render content when open=false', () => {
    render(
      <DialogBase open={false} onOpenChange={() => {}} title="Hidden">
        <p>body</p>
      </DialogBase>,
    );
    expect(screen.queryByText('Hidden')).not.toBeInTheDocument();
    expect(screen.queryByText('body')).not.toBeInTheDocument();
  });

  it('renders description when provided', () => {
    render(
      <DialogBase
        open
        onOpenChange={() => {}}
        title="T"
        description="some desc"
      >
        <p>body</p>
      </DialogBase>,
    );
    expect(screen.getByText('some desc')).toBeInTheDocument();
  });

  it('renders sr-only description fallback (= title) when description omitted', () => {
    render(
      <DialogBase open onOpenChange={() => {}} title="My Title">
        <p>body</p>
      </DialogBase>,
    );
    // Radix requires DialogDescription for a11y; we always render one and
    // sr-only-hide it when no explicit description is given.
    const desc = document.querySelector('[data-slot="dialog-description"]');
    expect(desc).not.toBeNull();
    expect(desc?.className).toMatch(/sr-only/);
    expect(desc?.textContent).toBe('My Title');
  });

  it('renders footer slot', () => {
    render(
      <DialogBase
        open
        onOpenChange={() => {}}
        title="T"
        footer={<button type="button">Confirm</button>}
      >
        <p>body</p>
      </DialogBase>,
    );
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
  });

  it('invokes onOpenChange(false) when Esc pressed', () => {
    const onOpenChange = vi.fn();
    render(
      <DialogBase open onOpenChange={onOpenChange} title="T">
        <p>body</p>
      </DialogBase>,
    );
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  // Regression: a tall body (long project / history list on a small mobile
  // viewport) used to push the fixed, vertically-centered dialog past the
  // top + bottom edges of the screen — unreachable and unscrollable. The
  // dialog must cap its height to the viewport and scroll the body slot
  // internally instead, keeping title + footer pinned.
  it('caps height to the viewport and scrolls the body slot internally', () => {
    render(
      <DialogBase
        open
        onOpenChange={() => {}}
        title="T"
        footer={<button type="button">Confirm</button>}
      >
        <p data-testid="dlg-body">body</p>
      </DialogBase>,
    );
    const content = document.querySelector('[data-slot="dialog-content"]');
    // Height is bounded relative to the viewport so the centered dialog
    // never overflows off-screen.
    expect(content?.className).toMatch(/max-h-\[/);
    // The body wrapper — not the whole fixed dialog — absorbs the overflow.
    const bodyWrap = screen.getByTestId('dlg-body').parentElement;
    expect(bodyWrap?.className).toMatch(/overflow-y-auto/);
  });
});
