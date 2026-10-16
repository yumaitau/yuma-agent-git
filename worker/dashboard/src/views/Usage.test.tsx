import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { usd, UsageView } from './Usage';
import { AgentReviewPanel } from './AgentReview';
import { expectAccessible } from '../axe';

afterEach(() => vi.unstubAllGlobals());

const sums = {
  events: 2,
  input_tokens: 1000,
  output_tokens: 200,
  cached_tokens: 300,
  ci_seconds: 600,
  storage_byte_days: 0,
  usd_micros: 1_500_000,
  unpriced: 0,
};

const report = {
  from: '2026-10-01',
  to: '2026-10-16',
  group_by: 'pull',
  totals: sums,
  merged_pulls: 1,
  usd_micros_per_merged_pull: 1_500_000,
  tokens_per_merged_pull: 1500,
  rows: [{ key: '#12', label: 'Fix parser', merged: true, ...sums }],
};

function mount(path: string) {
  const fetcher = vi.fn(async (input: string) =>
    Response.json(
      input.includes('/usage/budgets')
        ? {
            budgets: [
              {
                id: 'b1',
                metric: 'tokens',
                period: 'day',
                soft_limit: 500,
                hard_limit: 1000,
                used: 1500,
              },
            ],
            alerts: [
              {
                budget_id: 'b1',
                period_start: '2026-10-16',
                level: 'hard',
                used: 1500,
                limit_value: 1000,
                at: Date.now(),
              },
            ],
          }
        : report,
    ),
  );
  vi.stubGlobal('fetch', fetcher);
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/r/:owner/:name/usage" element={<UsageView />} />
        <Route path="/orgs/:org/usage" element={<UsageView />} />
      </Routes>
    </MemoryRouter>,
  );
  return fetcher;
}

it('formats micro-dollars', () => {
  expect(usd(1_500_000)).toBe('$1.50');
  expect(usd(142)).toBe('$0.0001');
  expect(usd(null)).toBe('—');
});

it('shows cost per merged pull request, rows and a CSV export for a repo', async () => {
  const fetcher = mount('/r/acme/tools/usage');
  expect(await screen.findByText('Fix parser')).toBeTruthy();
  await expectAccessible(document.body);
  expect(screen.getAllByText('$1.50').length).toBeGreaterThan(1);
  expect(screen.getByText('(1 merged)')).toBeTruthy();
  expect(screen.getByText('merged')).toBeTruthy();
  expect(screen.getByText('Export CSV').getAttribute('href')).toBe(
    '/api/v1/repos/acme/tools/usage?group_by=pull&format=csv',
  );
  fireEvent.change(screen.getByDisplayValue('Pull request'), {
    target: { value: 'ticket' },
  });
  await vi.waitFor(() =>
    expect(
      fetcher.mock.calls.some(([p]) => String(p).endsWith('/usage?group_by=ticket')),
    ).toBe(true),
  );
});

it('shows org budgets and the hard stop', async () => {
  mount('/orgs/acme/usage');
  expect(await screen.findByText('claims stopped')).toBeTruthy();
  await expectAccessible(document.body);
  expect(screen.getByText(/hard limit reached/)).toBeTruthy();
});

it('shows the agent review rounds and risk of a pull request', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        max_rounds: 3,
        round: 3,
        escalation: { round: 3, requested: 'user:u1', at: Date.now() },
        verdicts: [
          {
            revision: 3,
            reviewer: 'agent:agt_1',
            verdict: 'fail',
            confidence: 0.9,
            summary: 'Still broken.',
            findings: [{ severity: 'high', body: 'Null check.', path: 'a.ts', line: 4 }],
            round: 3,
            created_at: Date.now(),
          },
        ],
        risk: {
          level: 'high',
          reasons: ['changes sensitive paths: a.ts'],
          lines: 3,
          files: 1,
        },
      }),
    ),
  );
  render(<AgentReviewPanel slug="acme/tools" id="7" revision={3} />);
  expect(await screen.findByText('high risk')).toBeTruthy();
  await expectAccessible(document.body);
  expect(screen.getByText(/after 3 rounds/)).toBeTruthy();
  expect(screen.getByText('high: Null check.')).toBeTruthy();
  expect(screen.getByText('fail')).toBeTruthy();
});
