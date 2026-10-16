import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { CiView, PullView } from './Collaboration';
import { parseUnified } from '../DiffView';

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

const pullDetail = (gate: Record<string, unknown>) => ({
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
  gate: { methods: ['merge', 'squash', 'rebase'], method: 'merge', ...gate },
});
const clean = {
  mergeable: true,
  target_cs: 'a'.repeat(64),
  head_cs: 'b'.repeat(64),
  merge_base: 'a'.repeat(64),
  conflicts: [],
};
function pullFetch(detail: unknown, conflicts: unknown = clean) {
  return vi.fn(async (path: string, init?: RequestInit) => {
    if (init?.method === 'POST') return Response.json({ pull: {} });
    return Response.json(
      path.includes('/diff')
        ? { files: [], texts: [] }
        : path.includes('/ci/pipelines')
          ? { runs: [] }
          : path.endsWith('/conflicts')
            ? conflicts
            : path.endsWith('/threads')
              ? { threads: [], names: {} }
              : path.endsWith('/reviewers')
                ? { review_requests: [], names: {} }
                : detail,
    );
  });
}

it('disables merging and shows the current revision requirements', async () => {
  vi.stubGlobal(
    'fetch',
    pullFetch(
      pullDetail({
        mergeable: false,
        reasons: ['One teammate must approve this revision.'],
      }),
    ),
  );
  mount(<PullView />, 'pulls/:id');
  expect(
    await screen.findByText('One teammate must approve this revision.'),
  ).toBeTruthy();
  expect(
    (
      screen.getByText('Create a merge commit', {
        selector: 'button',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});

it('merges with the picked method', async () => {
  const fetcher = pullFetch(
    pullDetail({
      mergeable: true,
      reasons: [],
      methods: ['squash', 'rebase'],
      method: 'squash',
    }),
  );
  vi.stubGlobal('fetch', fetcher);
  mount(<PullView />, 'pulls/:id');
  const picker = await screen.findByLabelText('Merge method');
  expect((picker as HTMLSelectElement).value).toBe('squash');
  fireEvent.change(picker, { target: { value: 'rebase' } });
  const button = screen.getByText('Rebase and merge', { selector: 'button' });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
  await waitFor(() =>
    expect(fetcher.mock.calls.some(([path]) => path.endsWith('/merge'))).toBe(true),
  );
  const sent = fetcher.mock.calls.find(([path]) => path.endsWith('/merge'));
  expect(JSON.parse(sent![1]!.body as string)).toMatchObject({
    method: 'rebase',
    head_cs: 'b'.repeat(64),
    revision: 1,
  });
});

it('shows conflicting paths and hunks and blocks the merge', async () => {
  vi.stubGlobal(
    'fetch',
    pullFetch(pullDetail({ mergeable: true, reasons: [] }), {
      ...clean,
      mergeable: false,
      target_cs: 'c'.repeat(64),
      conflicts: [
        {
          path: 'src/app.ts',
          kind: 'content',
          hunks: [
            {
              base: { start: 3, lines: ['const a = 1;\n'] },
              ours: { start: 3, lines: ['const a = 2;\n'] },
              theirs: { start: 3, lines: ['const a = 3;\n'] },
            },
          ],
        },
        { path: 'old.txt', kind: 'modify_delete' },
      ],
    }),
  );
  mount(<PullView />, 'pulls/:id');
  expect(await screen.findByText('Conflicts with main')).toBeTruthy();
  expect(screen.getByText('src/app.ts')).toBeTruthy();
  expect(screen.getByText('changed on one side, deleted on the other')).toBeTruthy();
  expect(screen.getByText('const a = 3;')).toBeTruthy();
  expect(
    (
      screen.getByText('Create a merge commit', {
        selector: 'button',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect((screen.getByText('Update branch') as HTMLButtonElement).disabled).toBe(true);
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

it('retries a run through its retry endpoint and shows deploy jobs waiting for approval', async () => {
  const failed = {
    id: 'r1',
    repo_id: 'repo',
    head_cs: 'd'.repeat(64),
    state: 'failed',
    publish: 0,
    error: 'A command failed',
    created_at: Date.now(),
  };
  const pipeline = {
    id: 'p1',
    pipeline: '.yuma/pipelines/deploy.yml',
    name: 'deploy',
    event: 'push',
    ref: 'main',
    head_cs: 'd'.repeat(64),
    concurrency_group: null,
    state: 'running',
    errors: null,
    requested_by: 'u1',
    created_at: Date.now(),
    finished_at: null,
    jobs: [
      {
        key: 'deploy',
        job: 'deploy',
        needs: [],
        state: 'waiting',
        run_id: null,
        error: null,
        environment: 'production',
        approval: { id: 'a1', state: 'pending' },
      },
    ],
  };
  const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
    if (init?.method === 'POST')
      return Response.json({ approval: { id: 'a2' } }, { status: 202 });
    return Response.json(
      path.includes('/ci/pipelines')
        ? { runs: [pipeline] }
        : { ...overview, enabled: true, version: 1, config: policy, runs: [failed] },
    );
  });
  vi.stubGlobal('fetch', fetcher);
  mount(<CiView />);
  expect(
    await screen.findByText('Waiting for approval to deploy to production'),
  ).toBeTruthy();
  fireEvent.click(await screen.findByText('Retry'));
  await screen.findByText(/waiting for environment approval/);
  const post = fetcher.mock.calls.find(([, init]) => init?.method === 'POST');
  expect(post![0]).toMatch(/\/ci\/runs\/r1\/retry$/);
});

it('numbers diff lines on both sides', () => {
  const lines = parseUnified('@@ -4,2 +4,3 @@\n a\n-b\n+B\n+c\n');
  expect(lines.map((l) => l.anchor && `${l.anchor.side}:${l.anchor.line}`)).toEqual([
    undefined,
    'head:4',
    'base:5',
    'head:5',
    'head:6',
    undefined,
  ]);
});

it('shows inline review threads and starts, resolves and applies them', async () => {
  const pull = {
    id: 1,
    number: 1,
    title: 'Fix build',
    body: '',
    state: 'open',
    base_cs: 'a'.repeat(64),
    head_cs: 'b'.repeat(64),
    base_ref: 'main',
    revision: 2,
  };
  const thread = {
    id: 7,
    pull_id: 1,
    path: 'src/a.ts',
    side: 'head',
    start_line: 2,
    end_line: 2,
    revision: 2,
    anchor_cs: pull.head_cs,
    original_head_cs: pull.head_cs,
    outdated: false,
    author: 'user:u2',
    resolved_by: null,
    resolved_at: null,
    created_at: Date.now(),
    snippet: 'two\n',
    comments: [
      {
        id: 70,
        thread_id: 7,
        author: 'user:u2',
        body: 'Rename\n```suggestion\nTWO\n```',
        suggestion_patch: 'TWO',
        review_id: null,
        created_at: Date.now(),
      },
    ],
  };
  const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
    if (init?.method && init.method !== 'GET') return Response.json({ thread });
    if (path.includes('/diff'))
      return Response.json({
        from: pull.base_cs,
        to: pull.head_cs,
        merge_base: pull.base_cs,
        truncated: false,
        files: [{ path: 'src/a.ts', kind: 'mod', side: 'to' }],
        texts: [
          { path: 'src/a.ts', unified: '@@ -1,3 +1,3 @@\n one\n-2\n+two\n three\n' },
        ],
      });
    if (path.includes('/ci/pipelines')) return Response.json({ runs: [] });
    if (path.endsWith('/threads'))
      return Response.json({ threads: [thread], names: { 'user:u2': 'grace' } });
    if (path.endsWith('/reviewers'))
      return Response.json({
        review_requests: [{ principal: 'user:u2', state: 'pending' }],
        names: { 'user:u2': 'grace' },
      });
    if (path.endsWith('/conflicts')) return Response.json(clean);
    return Response.json({
      pull,
      reviews: [],
      gate: { mergeable: false, reasons: [], methods: ['merge'], method: 'merge' },
    });
  });
  vi.stubGlobal('fetch', fetcher);
  mount(<PullView />, 'pulls/:id');
  // once inline under line 2, once in the thread list
  await waitFor(() =>
    expect(screen.getAllByLabelText('Thread on src/a.ts line 2')).toHaveLength(2),
  );
  expect(screen.getByText('1 unresolved')).toBeTruthy();
  expect(screen.getAllByText('grace').length).toBeGreaterThan(0);

  fireEvent.click(screen.getByLabelText('Comment on line 3'));
  fireEvent.change(screen.getByLabelText('Comment on line 3', { selector: 'textarea' }), {
    target: { value: 'Why?' },
  });
  fireEvent.click(screen.getByText('Add comment'));
  const isPost = (path: string) => (call: [string, RequestInit?]) =>
    String(call[0]).endsWith(path) && call[1]?.method === 'POST';
  await waitFor(() => expect(fetcher.mock.calls.some(isPost('/threads'))).toBe(true));
  const posted = fetcher.mock.calls.find(isPost('/threads'));
  expect(JSON.parse(posted![1]!.body as string)).toEqual({
    path: 'src/a.ts',
    side: 'head',
    line: 3,
    body: 'Why?',
    head_cs: pull.head_cs,
    revision: 2,
  });

  fireEvent.click((await screen.findAllByText('Apply suggestion'))[0]!);
  await waitFor(() =>
    expect(fetcher.mock.calls.some(isPost('/suggestions/apply'))).toBe(true),
  );
  const applied = fetcher.mock.calls.find(isPost('/suggestions/apply'));
  expect(JSON.parse(applied![1]!.body as string)).toEqual({
    comment_ids: [70],
    head_cs: pull.head_cs,
    revision: 2,
  });
  fireEvent.click((await screen.findAllByText('Resolve'))[0]!);
  await waitFor(() =>
    expect(
      fetcher.mock.calls.some(
        ([p, init]) =>
          String(p).endsWith('/threads/7/resolution') && init?.method === 'PUT',
      ),
    ).toBe(true),
  );
});
