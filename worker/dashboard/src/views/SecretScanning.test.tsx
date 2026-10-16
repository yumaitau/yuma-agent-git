import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { SecretScanningView } from './SecretScanning';

afterEach(() => vi.unstubAllGlobals());

function mount() {
  return render(
    <MemoryRouter initialEntries={['/r/acme/tools/secret-scanning']}>
      <Routes>
        <Route path="/r/:owner/:name/secret-scanning" element={<SecretScanningView />} />
      </Routes>
    </MemoryRouter>,
  );
}

const alert = {
  id: 7,
  detector: 'aws_access_key_id',
  detector_name: 'AWS access key ID',
  path: 'deploy.env',
  line: 2,
  changeset_id: 'cs_0123456789abcdef',
  source: 'push',
  state: 'open',
  resolution: null,
  bypass_reason: 'will_fix',
  bypass_comment: 'rotating today',
  created_at: Date.now(),
};

function stub() {
  const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method === 'POST')
      return Response.json({ scan: { state: 'queued' } }, { status: 202 });
    if (method === 'PATCH')
      return Response.json({ alert: { ...alert, state: 'resolved' } });
    return Response.json({
      alerts: input.includes('state=open') ? [alert] : [],
      scan: {
        state: 'done',
        changesets: 12,
        files: 30,
        alerts: 1,
        error: null,
        updated_at: Date.now(),
      },
    });
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

it('lists alerts with their location and bypass, and resolves one', async () => {
  const fetcher = stub();
  mount();
  expect(await screen.findByText('AWS access key ID')).toBeTruthy();
  expect(screen.getByText('deploy.env:2')).toBeTruthy();
  expect(screen.getByText(/bypassed as will fix: rotating today/)).toBeTruthy();
  expect(screen.getByText(/12 changesets, 30 files/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Resolve alert 7'), {
    target: { value: 'revoked' },
  });
  await screen.findByText('Alert resolved.');
  const patch = fetcher.mock.calls.find(([, init]) => init?.method === 'PATCH');
  expect(patch![0]).toBe('/api/v1/repos/acme/tools/secret-scanning/alerts/7');
  expect(JSON.parse(patch![1]!.body as string)).toEqual({
    state: 'resolved',
    resolution: 'revoked',
  });
});

it('starts a history scan and switches to resolved alerts', async () => {
  const fetcher = stub();
  mount();
  await screen.findByText('AWS access key ID');
  fireEvent.click(screen.getByText('Scan history'));
  await screen.findByText('History scan queued.');
  expect(fetcher.mock.calls.find(([, init]) => init?.method === 'POST')![0]).toBe(
    '/api/v1/repos/acme/tools/secret-scanning/scans',
  );
  fireEvent.click(screen.getByText('Resolved'));
  expect(await screen.findByText('No resolved alerts.')).toBeTruthy();
});
