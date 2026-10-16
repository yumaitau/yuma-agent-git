import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { expectAccessible } from '../axe';
import { CiRunView } from './CiRun';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const head = 'c'.repeat(64);

/** A run that is `running` on the first read, then `passed`. */
function stub() {
  let reads = 0;
  let overviews = 0;
  const fetcher = vi.fn(async (input: string) => {
    if (input.endsWith('/ci/runs/r1/log')) {
      reads += 1;
      return new Response(reads === 1 ? 'step 1\n' : 'step 1\nstep 2\n');
    }
    if (input.endsWith('/ci/runs/r1/artifacts'))
      return Response.json({
        artifacts: [
          {
            id: 'a1',
            name: 'report.txt',
            size: 2048,
            job_key: 'build',
            expires_at: Date.now() + 14 * 86400_000,
          },
        ],
      });
    if (input.endsWith('/ci/pipelines')) return Response.json({ runs: [] });
    overviews += 1;
    return Response.json({
      runs: [
        {
          id: 'r1',
          publish: false,
          state: overviews === 1 ? 'running' : 'passed',
          head_cs: head,
          error: null,
          created_at: Date.now(),
        },
      ],
    });
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

function mount() {
  return render(
    <MemoryRouter initialEntries={['/r/acme/tools/ci/runs/r1']}>
      <Routes>
        <Route path="/r/:owner/:name/ci/runs/:id" element={<CiRunView />} />
      </Routes>
    </MemoryRouter>,
  );
}

it('follows a running log until the run finishes, then lists its artifacts', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const fetcher = stub();
  const { container } = mount();
  expect((await screen.findByLabelText('Build log')).textContent).toBe('step 1\n');
  expect(screen.getByText('running')).toBeTruthy();
  expect(screen.getByRole('status').textContent).toMatch(/Live/);
  await expectAccessible(container);

  await vi.advanceTimersByTimeAsync(2000);
  await vi.waitFor(() =>
    expect(screen.getByLabelText('Build log').textContent).toBe('step 1\nstep 2\n'),
  );
  expect(screen.getByText('passed')).toBeTruthy();
  expect(screen.getByRole('status').textContent).toMatch(/finished/);

  // a finished run is not polled again
  const logReads = (): number =>
    fetcher.mock.calls.filter(([url]) => url.endsWith('/log')).length;
  const before = logReads();
  await vi.advanceTimersByTimeAsync(6000);
  expect(logReads()).toBe(before);

  fireEvent.click(screen.getByRole('button', { name: 'Artifacts' }));
  const link = await screen.findByText('report.txt');
  expect(link.getAttribute('href')).toBe('/api/v1/repos/acme/tools/ci/artifacts/a1');
});

it('shows the API error for a run it cannot read', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json(
        { error: { code: 'run_not_found', message: 'Run not found' } },
        {
          status: 404,
        },
      ),
    ),
  );
  mount();
  expect(await screen.findByText(/Run not found/)).toBeTruthy();
});
