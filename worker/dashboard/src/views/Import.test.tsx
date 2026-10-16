import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { ImportView } from './Import';

afterEach(() => vi.unstubAllGlobals());

const job = {
  id: 'job1',
  github_org: 'acme-gh',
  status: 'partial',
  resume_at: null,
  error: null,
  created_at: Date.now(),
};

function stub() {
  const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
    if (init?.method === 'POST') return Response.json({ import: { ...job, id: 'job2' } });
    if (input.endsWith('/imports')) return Response.json({ imports: [job] });
    return Response.json({
      import: {
        ...job,
        totals: { issues: 3 },
        repos: [
          {
            github: 'acme-gh/app',
            repo: 'acme/app',
            status: 'done',
            phase: 'done',
            counts: { issues: 3 },
            warnings: [],
            error: null,
          },
          {
            github: 'acme-gh/big',
            repo: null,
            status: 'failed',
            phase: 'git',
            counts: {},
            warnings: [],
            error: 'reply is over 25 MiB',
          },
        ],
      },
    });
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

function mount() {
  return render(
    <MemoryRouter initialEntries={['/orgs/acme/imports']}>
      <Routes>
        <Route path="/orgs/:org/imports" element={<ImportView />} />
      </Routes>
    </MemoryRouter>,
  );
}

it('shows the per-repo report and resumes failed repos', async () => {
  const fetcher = stub();
  mount();
  expect(await screen.findByText('acme-gh/big')).toBeTruthy();
  expect(screen.getByText('reply is over 25 MiB')).toBeTruthy();
  expect(screen.getByText('issues 3')).toBeTruthy();
  fireEvent.click(screen.getByText('Resume failed repos'));
  await vi.waitFor(() =>
    expect(
      fetcher.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${url}`),
    ).toContain('POST /api/v1/orgs/acme/imports/job1/resume'),
  );
});

it('starts an import for chosen repos', async () => {
  const fetcher = stub();
  mount();
  fireEvent.change(await screen.findByLabelText('GitHub organisation'), {
    target: { value: 'acme-gh' },
  });
  fireEvent.change(screen.getByLabelText('App installation id'), {
    target: { value: '77' },
  });
  fireEvent.change(screen.getByLabelText(/Only these repos/), {
    target: { value: 'app, lib' },
  });
  fireEvent.click(screen.getByText('Start import'));
  await vi.waitFor(() => {
    const post = fetcher.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(post![0]).toBe('/api/v1/orgs/acme/imports');
    expect(JSON.parse(post![1]!.body as string)).toEqual({
      source: 'github',
      github_org: 'acme-gh',
      installation_id: 77,
      repos: ['app', 'lib'],
    });
  });
});
