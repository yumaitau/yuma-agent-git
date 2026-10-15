import type { ReactElement } from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSincePolling } from './hooks';

interface Entry {
  id: string;
  t: number;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('useSincePolling', () => {
  it('appends pages and dedupes the repeated since-cursor boundary', async () => {
    vi.useFakeTimers();
    const pages: Entry[][] = [
      [
        { id: 'a', t: 1 },
        { id: 'b', t: 2 },
      ],
      [
        { id: 'b', t: 2 },
        { id: 'c', t: 3 },
      ],
    ];
    const sinces: number[] = [];

    function Probe(): ReactElement {
      const { entries } = useSincePolling<Entry>(
        async (since) => {
          const page = pages[sinces.length] ?? [];
          sinces.push(since);
          return page;
        },
        (entry) => entry.t,
        (entry) => entry.id,
        1_000,
      );
      return <div data-testid="out">{entries.map((entry) => entry.id).join(',')}</div>;
    }

    render(<Probe />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId('out').textContent).toBe('a,b');
    expect(sinces[0]).toBe(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.getByTestId('out').textContent).toBe('a,b,c');
    expect(sinces[1]).toBe(2);
  });
});
