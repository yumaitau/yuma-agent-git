import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { CiView, PullView } from './Collaboration';

const overview = {
  can_admin: true,
  can_write: true,
  config: null,
  version: null,
  runs: [],
  enabled: false,
  monthly_budget_usd: 5,
  reserved_usd: 0,
  max_run_usd: null,
  registry: null,
};
const policy = {
  preset: 'node',
  commands: ['npm ci', 'npm run build'],
  timeout_seconds: 300,
  required_approvals: 1,
  require_checks: true,
  protect_default: true,
  dockerfile: 'Dockerfile',
  image: null,
};
function mount(element: React.ReactNode, suffix = 'ci') {
  return render(
    <MemoryRouter initialEntries={[`/r/acme/tools/${suffix}`]}>
      <Routes>
        <Route path={`/r/:owner/:name/${suffix}`} element={element} />
      </Routes>
    </MemoryRouter>,
  );
}
afterEach(() => vi.unstubAllGlobals());

it('detects commands, allows editing and saves a disabled pipeline without starting a run', async () => {
  const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
    if (init?.method === 'PUT') return Response.json({ config: policy });
    return Response.json(
      input.endsWith('/detect')
        ? { empty: false, preset: 'node', commands: policy.commands }
        : overview,
    );
  });
  vi.stubGlobal('fetch', fetcher);
  mount(<CiView />);
  const commands = await screen.findByLabelText('Commands');
  await waitFor(() =>
    expect((commands as HTMLTextAreaElement).value).toContain('npm ci'),
  );
  fireEvent.change(commands, {
    target: { value: 'npm ci\nnpm run lint\nnpm run build' },
  });
  fireEvent.click(screen.getByText('Save pipeline'));
  await screen.findByText('CI configuration saved.');
  const saved = fetcher.mock.calls.find(([, init]) => init?.method === 'PUT');
  expect(JSON.parse(saved![1]!.body as string).commands).toEqual([
    'npm ci',
    'npm run lint',
    'npm run build',
  ]);
  expect(fetcher.mock.calls.some(([path]) => path.endsWith('/runs'))).toBe(false);
});

it('shows budget admission failures when starting checks', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? Response.json(
            {
              error: {
                code: 'ci_capacity_or_budget',
                message: 'Monthly budget exhausted',
              },
            },
            { status: 429 },
          )
        : Response.json({ ...overview, enabled: true, version: 1, config: policy }),
    ),
  );
  mount(<CiView />);
  fireEvent.click(await screen.findByText('Run checks'));
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    expect.stringContaining('Monthly budget exhausted'),
  );
});

it('disables merging and shows the current revision requirements', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) =>
      Response.json(
        path.includes('/diff')
          ? { files: [], texts: [] }
          : path.includes('/ci/pipelines')
            ? { runs: [] }
            : {
                pull: {
                  id: 1,
                  title: 'Fix build',
                  body: '',
                  state: 'open',
                  base_cs: 'a'.repeat(64),
                  head_cs: 'b'.repeat(64),
                  base_ref: 'main',
                  revision: 1,
                },
                reviews: [],
                gate: {
                  mergeable: false,
                  reasons: ['One teammate must approve this revision.'],
                },
              },
      ),
    ),
  );
  mount(<PullView />, 'pulls/:id');
  expect(
    await screen.findByText('One teammate must approve this revision.'),
  ).toBeTruthy();
  expect((screen.getByText('Merge pull request') as HTMLButtonElement).disabled).toBe(
    true,
  );
});

it('draws the pipeline job graph by stage and shows line-numbered spec errors', async () => {
  const job = (key: string, needs: string[], state: string) => ({
    key,
    job: key.split(' ')[0],
    needs,
    state,
    run_id: state === 'waiting' ? null : `run-${key}`,
    error: null,
  });
  const run = {
    pipeline: '.yuma/pipelines/ci.yml',
    event: 'push',
    ref: 'main',
    head_cs: 'c'.repeat(64),
    concurrency_group: null,
    requested_by: 'u1',
    created_at: Date.now(),
    finished_at: null,
  };
  const runs = [
    {
      ...run,
      id: 'p1',
      name: 'ci',
      state: 'running',
      errors: null,
      jobs: [
        job('lint', [], 'passed'),
        job('test (20)', [], 'passed'),
        job('test (22)', [], 'running'),
        job('build', ['lint', 'test'], 'waiting'),
      ],
    },
    {
      ...run,
      id: 'p2',
      pipeline: '.yuma/pipelines/bad.yml',
      name: 'bad',
      state: 'failed',
      errors: [{ line: 4, column: 13, message: 'jobs.a.needs.0: Unknown job "x"' }],
      jobs: [],
    },
  ];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) =>
      Response.json(path.includes('/ci/pipelines') ? { runs } : overview),
    ),
  );
  mount(<CiView />);
  const graph = await screen.findByLabelText('ci job graph');
  const stages = [...graph.querySelectorAll('ol')].map((ol) =>
    [...ol.querySelectorAll('strong')].map((s) => s.textContent),
  );
  expect(stages).toEqual([['lint', 'test (20)', 'test (22)'], ['build']]);
  expect(screen.getByText('needs lint, test')).toBeTruthy();
  expect(screen.getByText('.yuma/pipelines/bad.yml:4:13')).toBeTruthy();
  expect(screen.getByText(/Unknown job "x"/)).toBeTruthy();
});
