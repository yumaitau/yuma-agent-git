import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { RunnersView } from './Runners';

afterEach(() => vi.unstubAllGlobals());

function mount(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/orgs/:org/runners" element={<RunnersView />} />
        <Route path="/r/:owner/:name/ci/runners" element={<RunnersView />} />
      </Routes>
    </MemoryRouter>,
  );
}

function stub() {
  const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
    if (input.endsWith('/registration-token'))
      return Response.json({ token: 'yagreg_once', expires_at: Date.now() + 3600_000 });
    if (init?.method && init.method !== 'GET') return Response.json({ ok: true });
    return Response.json({
      runners: [
        {
          id: 'r1',
          name: 'mac-mini',
          labels: ['macos', 'arm64'],
          capabilities: { os: 'darwin', arch: 'arm64' },
          ephemeral: false,
          trusted_only: true,
          disabled: false,
          last_seen_at: Date.now(),
        },
      ],
    });
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

it('lists org runners and mints a trusted-only registration token once', async () => {
  const fetcher = stub();
  mount('/orgs/yuma/runners');
  expect(await screen.findByText('mac-mini')).toBeTruthy();
  expect(screen.getByText('online')).toBeTruthy();
  expect(screen.getByText('trusted only')).toBeTruthy();
  fireEvent.click(screen.getByLabelText(/Trusted only/));
  fireEvent.click(screen.getByText('Create registration token'));
  expect(await screen.findByText('yagreg_once')).toBeTruthy();
  const post = fetcher.mock.calls.find(([, init]) => init?.method === 'POST');
  expect(post![0]).toBe('/api/v1/orgs/yuma/runners/registration-token');
  expect(JSON.parse(post![1]!.body as string)).toEqual({ trusted_only: true });
});

it('disables and removes a repo runner', async () => {
  const fetcher = stub();
  mount('/r/acme/tools/ci/runners');
  fireEvent.click(await screen.findByText('Disable'));
  fireEvent.click(screen.getByText('Remove mac-mini'));
  await vi.waitFor(() =>
    expect(fetcher.mock.calls.map(([url, init]) => `${init?.method} ${url}`)).toEqual(
      expect.arrayContaining([
        'PATCH /api/v1/repos/acme/tools/runners/r1',
        'DELETE /api/v1/repos/acme/tools/runners/r1',
      ]),
    ),
  );
});
