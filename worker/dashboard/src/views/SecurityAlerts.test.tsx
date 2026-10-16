import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { SecurityAlertsView } from './SecurityAlerts';

afterEach(() => vi.unstubAllGlobals());

function mount() {
  return render(
    <MemoryRouter initialEntries={['/r/acme/shop/security-alerts']}>
      <Routes>
        <Route path="/r/:owner/:name/security-alerts" element={<SecurityAlertsView />} />
      </Routes>
    </MemoryRouter>,
  );
}

const dependency = {
  id: 3,
  advisory_id: 'GHSA-35jh-r3h4-6jhm',
  ecosystem: 'npm',
  name: 'lodash',
  version: '4.17.20',
  path: 'package-lock.json',
  severity: 'high',
  fixed_version: '4.17.21',
  state: 'open',
  dismissed_reason: null,
  work_number: null,
  updated_at: Date.now(),
  advisory: { summary: 'Command injection in lodash', url: 'https://osv.dev/x' },
};
const finding = {
  id: 9,
  tool: 'Semgrep',
  rule_id: 'js.sqli',
  rule_name: 'SQL injection',
  severity: 'critical',
  message: 'Query built from input',
  path: 'src/db.ts',
  start_line: 12,
  state: 'open',
  dismissed_reason: null,
  updated_at: Date.now(),
};

function stub() {
  const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method === 'POST')
      return Response.json({ issue: { number: 4 }, created: true }, { status: 201 });
    if (method === 'PATCH') return Response.json({ alert: {} });
    if (input.includes('/dependency-alerts'))
      return Response.json({
        alerts: input.includes('state=open') ? [dependency] : [],
        attribution:
          'Advisory data from OSV (https://osv.dev), licensed under CC-BY 4.0.',
      });
    return Response.json({
      ref: 'main',
      alerts: input.includes('state=open') ? [finding] : [],
    });
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

it('lists dependency and code scanning alerts with the OSV attribution', async () => {
  stub();
  mount();
  expect(await screen.findByText('lodash')).toBeTruthy();
  expect(screen.getByText('GHSA-35jh-r3h4-6jhm')).toBeTruthy();
  expect(screen.getByText('SQL injection')).toBeTruthy();
  expect(screen.getByText('src/db.ts:12')).toBeTruthy();
  expect(screen.getByText(/CC-BY 4\.0/)).toBeTruthy();
  expect(screen.getByText('Code scanning on main')).toBeTruthy();
});

it('files update work and dismisses an alert with a reason', async () => {
  const fetcher = stub();
  mount();
  fireEvent.click(await screen.findByText('File update work'));
  expect(await screen.findByText('Update work filed.')).toBeTruthy();
  expect(fetcher).toHaveBeenCalledWith(
    expect.stringContaining('/api/v1/repos/acme/shop/dependency-alerts/3/work'),
    expect.objectContaining({ method: 'POST' }),
  );
  fireEvent.change(screen.getByLabelText('Dismiss js.sqli alert 9'), {
    target: { value: 'false_positive' },
  });
  expect(await screen.findByText('Alert dismissed.')).toBeTruthy();
  const patch = fetcher.mock.calls.find(([, init]) => init?.method === 'PATCH')!;
  expect(patch[0]).toContain('/code-scanning/alerts/9');
  expect(JSON.parse(String(patch[1]!.body))).toEqual({
    state: 'dismissed',
    reason: 'false_positive',
  });
});
