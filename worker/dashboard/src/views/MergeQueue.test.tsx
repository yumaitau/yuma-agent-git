import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { MergeQueueView } from './MergeQueue';
import { expectAccessible } from '../axe';

afterEach(() => vi.unstubAllGlobals());

const entry = (over: Record<string, unknown>) => ({
  id: `e${String(over.pull_id)}`,
  priority: 0,
  method: 'merge',
  reason: null,
  enqueued_at: Date.now(),
  updated_at: Date.now(),
  ...over,
});

const queue = {
  base_ref: 'main',
  enabled: true,
  mode: 'strict',
  max_batch: 5,
  entries: [
    entry({ pull_id: 7, number: 12, title: 'Fix parser', state: 'testing' }),
    entry({ pull_id: 8, number: 13, title: 'Add docs', state: 'queued', priority: 3 }),
    entry({
      pull_id: 5,
      number: 9,
      title: 'Break build',
      state: 'ejected',
      reason: 'its merge group checks failed.',
    }),
  ],
  groups: [
    {
      id: 'g1',
      mode: 'strict',
      state: 'testing',
      base_cs: 'a'.repeat(64),
      head_cs: 'b'.repeat(64),
      revert_cs: null,
      reason: null,
      pull_ids: [7],
      created_at: Date.now(),
    },
  ],
};

function mount(path: string) {
  const fetcher = vi.fn(async (_input: string, init?: RequestInit) =>
    init?.method === 'DELETE'
      ? Response.json({ entry: queue.entries[1] })
      : Response.json(queue),
  );
  vi.stubGlobal('fetch', fetcher);
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/r/:owner/:name/queue" element={<MergeQueueView />} />
      </Routes>
    </MemoryRouter>,
  );
  return fetcher;
}

it('lists queued pull requests in order, groups and recent results', async () => {
  mount('/r/acme/tools/queue');
  expect(await screen.findByText('#12 Fix parser')).toBeTruthy();
  await expectAccessible(document.body);
  expect(screen.getByText('Merge queue for main')).toBeTruthy();
  expect(screen.getByText('priority 3')).toBeTruthy();
  expect(screen.getByText('#9 Break build')).toBeTruthy();
  expect(screen.getByText(/its merge group checks failed/)).toBeTruthy();
  expect(screen.getByText(/strict mode, up to 5 pull/)).toBeTruthy();
  expect(screen.getAllByText('testing')).toHaveLength(2);
});

it('removes a pull request and reads another branch', async () => {
  const fetcher = mount('/r/acme/tools/queue?ref=release');
  fireEvent.click(await screen.findByText('Remove #13'));
  await expectAccessible(document.body);
  await vi.waitFor(() =>
    expect(
      fetcher.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${url}`),
    ).toEqual(
      expect.arrayContaining([
        'GET /api/v1/repos/acme/tools/merge-queue?ref=release',
        'DELETE /api/v1/repos/acme/tools/pulls/8/queue',
      ]),
    ),
  );
});
