import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QuotaPanel, type QuotaSnapshot } from './quota-panel.js';

function mockFetchOnce(body: object, status = 200): void {
  globalThis.fetch = vi.fn().mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

function mockFetchSequence(bodies: object[]): void {
  const fn = vi.fn();
  for (const body of bodies) {
    fn.mockResolvedValueOnce(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }
  globalThis.fetch = fn;
}

describe('QuotaPanel', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders nothing when closed', () => {
    const { container } = render(<QuotaPanel open={false} onClose={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows loading state then renders limited user quota', async () => {
    const snap: QuotaSnapshot = {
      kind: 'limited',
      cost: { limitUsd: 10, usedUsd: 2.5 },
      tokens: { limit: 100_000, used: 25_000 },
    };
    mockFetchOnce(snap);

    render(<QuotaPanel open={true} onClose={() => {}} pollIntervalMs={60_000} />);

    expect(screen.getByText('载入中…')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText(/\$2\.50/)).toBeInTheDocument();
    });
    expect(screen.getByText(/\$10\.00/)).toBeInTheDocument();
    expect(screen.getByText(/25,000/)).toBeInTheDocument();
    expect(screen.getByText(/100,000/)).toBeInTheDocument();
  });

  it('owner kind renders no-limit placeholder, no progress bars', async () => {
    const snap: QuotaSnapshot = {
      kind: 'owner',
      cost: { limitUsd: null, usedUsd: 0 },
      tokens: { limit: null, used: 0 },
    };
    mockFetchOnce(snap);

    const { container } = render(<QuotaPanel open={true} onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText(/owner.*无配额限制/)).toBeInTheDocument();
    });
    expect(container.querySelector('.quota-bar')).toBeNull();
  });

  it('80% saturation → is-warn tone', async () => {
    const snap: QuotaSnapshot = {
      kind: 'limited',
      cost: { limitUsd: 10, usedUsd: 8 },
      tokens: { limit: 100, used: 50 },
    };
    mockFetchOnce(snap);

    const { container } = render(<QuotaPanel open={true} onClose={() => {}} />);
    await waitFor(() => {
      expect(screen.getByText(/\$8\.00/)).toBeInTheDocument();
    });
    const bars = container.querySelectorAll('.quota-bar');
    expect(bars[0]?.classList.contains('is-warn')).toBe(true);
    expect(bars[1]?.classList.contains('is-ok')).toBe(true);
  });

  it('100% saturation → is-exhausted tone', async () => {
    const snap: QuotaSnapshot = {
      kind: 'limited',
      cost: { limitUsd: 5, usedUsd: 10 },
      tokens: { limit: 100, used: 50 },
    };
    mockFetchOnce(snap);

    const { container } = render(<QuotaPanel open={true} onClose={() => {}} />);
    await waitFor(() => {
      expect(screen.getByText(/\$10\.00/)).toBeInTheDocument();
    });
    const costBar = container.querySelector('.quota-bar');
    expect(costBar?.classList.contains('is-exhausted')).toBe(true);
  });

  it('polls /api/me/quota at the configured interval while open', async () => {
    const calls: object[] = [
      { kind: 'limited', cost: { limitUsd: 10, usedUsd: 1 }, tokens: { limit: 100, used: 1 } },
      { kind: 'limited', cost: { limitUsd: 10, usedUsd: 2 }, tokens: { limit: 100, used: 2 } },
      { kind: 'limited', cost: { limitUsd: 10, usedUsd: 3 }, tokens: { limit: 100, used: 3 } },
    ];
    mockFetchSequence(calls);

    render(<QuotaPanel open={true} onClose={() => {}} pollIntervalMs={1000} />);
    await waitFor(() => {
      expect(screen.getByText(/\$1\.00/)).toBeInTheDocument();
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await waitFor(() => {
      expect(screen.getByText(/\$2\.00/)).toBeInTheDocument();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await waitFor(() => {
      expect(screen.getByText(/\$3\.00/)).toBeInTheDocument();
    });
  });

  it('stops polling after close', async () => {
    const snap: QuotaSnapshot = {
      kind: 'limited',
      cost: { limitUsd: 10, usedUsd: 1 },
      tokens: { limit: 100, used: 1 },
    };
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(snap), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    globalThis.fetch = fetchFn;

    const { rerender } = render(
      <QuotaPanel open={true} onClose={() => {}} pollIntervalMs={1000} />,
    );
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));

    rerender(<QuotaPanel open={false} onClose={() => {}} pollIntervalMs={1000} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    // After close, no further fetches even after 5 polling intervals worth
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('shows error message when fetch throws', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down'));
    render(<QuotaPanel open={true} onClose={() => {}} />);
    await waitFor(() => {
      expect(screen.getByText(/network down/)).toBeInTheDocument();
    });
  });
});
