import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { api, type AgentTask, type Changeset, type Repo } from '../api';
import { expectAccessible } from '../axe';
import { ToastProvider } from '../toast';
import { AgentsView, TaskDetailView } from './Agents';
import { HistoryView, PullsView } from './Collaboration';
import { DiffExplorerView } from './DiffExplorer';
import { SettingsView } from './Settings';

/**
 * axe checks (issue #80) for the views that have no behaviour test of their
 * own; every other view runs axe inside its own test file.
 */
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const head = 'b'.repeat(64);
const repo: Repo = {
  id: 'r1',
  slug: 'acme/tools',
  visibility: 'private',
  default_branch: 'main',
  created_at: 1,
};
const changeset: Changeset = {
  id: head,
  repo_id: 'r1',
  first_parent: 'a'.repeat(64),
  parents: ['a'.repeat(64)],
  author: { name: 'Ada', email: 'ada@example.com' },
  message: 'Add the parser\n\nDetails',
  created_at: Date.now(),
  changed_files: [],
};

const task: AgentTask = {
  id: 't1',
  repo_id: 'r1',
  kind: 'fix_issue',
  prompt: 'Fix the flaky test',
  status: 'running',
  created_by: 'u1',
  created_at: Date.now(),
  updated_at: Date.now(),
};

function mount(path: string, pattern: string, element: ReactNode) {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={pattern} element={element} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  );
}

/** Same-origin API reads for views that call `fetch` directly. */
function stubFetch(routes: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const path = input.split('?')[0]!;
      const key = Object.keys(routes).find((k) => path.endsWith(k));
      return Response.json(key ? routes[key] : {});
    }),
  );
}

it('commit history', async () => {
  stubFetch({ '/changesets': { changesets: [changeset], next_cursor: 'c2' } });
  mount('/r/acme/tools/history', '/r/:owner/:name/history', <HistoryView />);
  expect(await screen.findByText('Add the parser')).toBeTruthy();
  await expectAccessible(document.body);
});

it('pull request list', async () => {
  stubFetch({
    '/pulls': {
      pulls: [
        {
          id: 1,
          title: 'Fix build',
          body: '',
          state: 'open',
          base_cs: 'a'.repeat(64),
          head_cs: head,
          base_ref: 'main',
          revision: 1,
          created_at: Date.now(),
          updated_at: Date.now(),
        },
      ],
    },
  });
  mount('/r/acme/tools/pulls', '/r/:owner/:name/pulls', <PullsView />);
  expect(await screen.findByText(/Fix build/)).toBeTruthy();
  screen.getByText('New pull request').click();
  expect(await screen.findByLabelText(/Title/)).toBeTruthy();
  await expectAccessible(document.body);
});

it('diff explorer', async () => {
  vi.spyOn(api, 'getHistory').mockResolvedValue({
    changesets: [changeset],
  } as Awaited<ReturnType<typeof api.getHistory>>);
  vi.spyOn(api, 'getDiff').mockResolvedValue({
    from: 'a'.repeat(64),
    to: head,
    merge_base: 'a'.repeat(64),
    truncated: false,
    files: [{ path: 'src/parse.ts', kind: 'mod' }],
    texts: [{ path: 'src/parse.ts', unified: '@@ -1,2 +1,2 @@\n a\n-b\n+c' }],
  });
  mount(
    `/r/acme/tools/diff?from=${'a'.repeat(64)}&to=main`,
    '/r/:owner/:name/diff',
    <DiffExplorerView />,
  );
  expect(await screen.findByText('src/parse.ts')).toBeTruthy();
  await expectAccessible(document.body);
});

it('agent task list', async () => {
  vi.spyOn(api, 'listTasks').mockResolvedValue([task]);
  vi.spyOn(api, 'listAgents').mockResolvedValue([]);
  mount('/r/acme/tools/agents', '/r/:owner/:name/agents', <AgentsView />);
  expect(await screen.findByText(/Fix the flaky test/)).toBeTruthy();
  await expectAccessible(document.body);
});

it('agent task detail', async () => {
  vi.spyOn(api, 'getTask').mockResolvedValue({
    task,
    state: { status: 'acting', steps: 1 },
  });
  vi.spyOn(api, 'getTranscript').mockResolvedValue([
    { t: Date.now(), kind: 'note', text: 'Reading the test' },
  ]);
  mount('/r/acme/tools/agents/t1', '/r/:owner/:name/agents/:taskId', <TaskDetailView />);
  expect(await screen.findByText('Reading the test')).toBeTruthy();
  await expectAccessible(document.body);
});

it('personal settings', async () => {
  vi.spyOn(api, 'listRepos').mockResolvedValue([repo]);
  vi.spyOn(api, 'listTokens').mockResolvedValue([
    {
      id: 'tok1',
      label: 'laptop',
      scopes: ['repo:read'],
      repo_id: null,
      created_at: Date.now(),
      last_used_at: null,
      expires_at: null,
    },
  ]);
  stubFetch({});
  mount('/settings', '/settings', <SettingsView />);
  expect(await screen.findByText('laptop')).toBeTruthy();
  await expectAccessible(document.body);
});
