import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { IssuesView, NewIssueView } from './Issues';
import { IssueView } from './IssueView';
import type { Issue, IssueDetail } from '../issues';

function issue(number: number, extra: Partial<Issue> = {}): Issue {
  return {
    id: number,
    number,
    title: `Issue ${number}`,
    body: '',
    state: 'open',
    state_reason: null,
    author_id: 'u1',
    milestone_id: null,
    locked: false,
    pinned: false,
    created_at: Date.now(),
    updated_at: Date.now(),
    closed_at: null,
    labels: [],
    assignees: [],
    sub_issues: { total: 0, done: 0 },
    ...extra,
  };
}

function mount(path: string, pattern: string, element: React.ReactNode) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={pattern} element={element} />
        <Route path="/r/:owner/:name/pulls/:id" element={<p>Pull page</p>} />
        <Route path="/r/:owner/:name/issues/:number" element={<p>Issue page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}
afterEach(() => vi.unstubAllGlobals());

it('lists pinned and filtered issues with labels and sub-issue progress', async () => {
  const fetcher = vi.fn(async (path: string) =>
    Response.json(
      path.includes('/labels')
        ? { labels: [{ id: 1, name: 'bug', color: 'd74c2f', description: '' }] }
        : {
            issues: [
              issue(2, {
                labels: [{ id: 1, name: 'bug', color: 'd74c2f', description: '' }],
                sub_issues: { total: 5, done: 3 },
              }),
            ],
            pinned: [issue(1, { title: 'Read me first', pinned: true })],
            next_cursor: null,
          },
    ),
  );
  vi.stubGlobal('fetch', fetcher);
  mount('/r/acme/tools/issues', '/r/:owner/:name/issues', <IssuesView />);
  expect(await screen.findByText('Read me first')).toBeTruthy();
  expect(screen.getByText('Issue 2')).toBeTruthy();
  expect(screen.getByText(/3 of 5 done/)).toBeTruthy();
  fireEvent.change(await screen.findByLabelText('Label'), { target: { value: 'bug' } });
  await waitFor(() =>
    expect(fetcher.mock.calls.some(([p]) => p.includes('label=bug'))).toBe(true),
  );
});

const detail: IssueDetail = {
  issue: issue(7, {
    title: 'Crash on save',
    body: 'See #3 <script>window.pwned = true</script><img src=x onerror="window.pwned=true">',
    sub_issues: { total: 5, done: 3 },
  }),
  comments: [{ id: 1, author_id: 'u1', body: '**First**', created_at: 1, updated_at: 1 }],
  events: [
    {
      id: 1,
      actor: 'user:u2',
      kind: 'referenced',
      payload: { source: { kind: 'pull', repo: 'acme/tools', ref: 9 } },
      created_at: 2,
    },
  ],
  parent: null,
  sub_issues: [
    { number: 8, title: 'Child', state: 'closed' },
    { number: 9, title: 'Other child', state: 'open' },
  ],
  milestone: null,
  can_triage: false,
  names: { 'user:u1': 'ada', 'user:u2': 'grace' },
};

it('renders Markdown safely, shows progress and posts comments', async () => {
  const fetcher = vi.fn(async (_path: string, init?: RequestInit) =>
    init?.method === 'POST'
      ? Response.json({ comment: {} }, { status: 201 })
      : Response.json(detail),
  );
  vi.stubGlobal('fetch', fetcher);
  const { container } = mount(
    '/r/acme/tools/issues/7',
    '/r/:owner/:name/issues/:number',
    <IssueView />,
  );
  expect(await screen.findByText('Crash on save')).toBeTruthy();
  expect(container.querySelector('script, img, [onerror]')).toBeNull();
  expect(container.querySelector('a[href="/r/acme/tools/issues/3"]')).toBeTruthy();
  expect(container.querySelector('.markdown strong')?.textContent).toBe('First');
  expect(screen.getByText(/3 of 5 done/)).toBeTruthy();
  expect(
    screen.getByText(/referenced this from pull request acme\/tools#9/),
  ).toBeTruthy();
  expect(screen.queryByText('Lock')).toBeNull(); // no triage
  fireEvent.change(screen.getByLabelText('Comment (Markdown)'), {
    target: { value: 'Thanks' },
  });
  fireEvent.click(screen.getByText('Comment'));
  await waitFor(() =>
    expect(fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true),
  );
  const post = fetcher.mock.calls.find(([, init]) => init?.method === 'POST')!;
  expect(post[0]).toBe('/api/v1/repos/acme/tools/issues/7/comments');
  expect(JSON.parse(post[1]!.body as string)).toEqual({ body: 'Thanks' });
});

it('sends a pull request number to the pull request page', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json(
        { error: { code: 'pull_request', message: '#4 is a pull request', pull_id: 12 } },
        { status: 404 },
      ),
    ),
  );
  mount('/r/acme/tools/issues/4', '/r/:owner/:name/issues/:number', <IssueView />);
  expect(await screen.findByText('Pull page')).toBeTruthy();
});

it('fills an issue form template and submits its answers as Markdown', async () => {
  const fetcher = vi.fn(async (path: string, init?: RequestInit) =>
    init?.method === 'POST'
      ? Response.json({ issue: issue(5) }, { status: 201 })
      : Response.json({
          templates: [
            {
              path: '.github/ISSUE_TEMPLATE/bug.yml',
              name: 'Bug',
              about: 'Report a bug',
              title: '[bug] ',
              labels: ['bug'],
              assignees: [],
              body: '',
              fields: [
                {
                  type: 'textarea',
                  id: 'what',
                  label: 'What happened?',
                  description: '',
                  placeholder: '',
                  value: '',
                  options: [],
                  required: true,
                },
              ],
            },
          ],
          errors: [],
          path,
        }),
  );
  vi.stubGlobal('fetch', fetcher);
  mount('/r/acme/tools/issues/new', '/r/:owner/:name/issues/new', <NewIssueView />);
  fireEvent.click(await screen.findByText('Use template'));
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: '[bug] Crash' } });
  fireEvent.change(screen.getByLabelText('What happened?'), {
    target: { value: 'It broke' },
  });
  fireEvent.click(screen.getByText('Open issue'));
  expect(await screen.findByText('Issue page')).toBeTruthy();
  const post = fetcher.mock.calls.find(([, init]) => init?.method === 'POST')!;
  expect(JSON.parse(post[1]!.body as string)).toEqual({
    title: '[bug] Crash',
    body: '### What happened?\n\nIt broke',
    labels: ['bug'],
    assignees: [],
  });
});
