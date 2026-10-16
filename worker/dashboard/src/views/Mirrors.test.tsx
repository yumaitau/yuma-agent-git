import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { MirrorsView } from './Mirrors';

afterEach(() => vi.unstubAllGlobals());

const mirrors = {
  mirrors: [
    {
      id: 'mir_1',
      direction: 'pull',
      remote_url: 'https://github.com/acme/tools.git',
      auth: 'github_app',
      has_token: false,
      interval_s: 300,
      force: false,
      enabled: true,
      syncing: false,
      last_sync_at: Date.now(),
      last_success_at: null,
      last_error: '1 ref(s) not mirrored: refs/heads/main diverged',
      last_result: [
        { ref: 'refs/heads/main', status: 'diverged', detail: 'the forge has commits' },
        { ref: 'refs/heads/dev', status: 'unchanged' },
      ],
    },
  ],
};
const migration = {
  state: 'mirror',
  pull_mirror_id: 'mir_1',
  push_mirror_id: null,
  transitions: [
    {
      to: 'dual',
      checks: [
        { name: 'rulesets', ok: false, message: 'add at least one active ruleset' },
      ],
    },
    { to: 'github', checks: [] },
  ],
};

it('shows mirror failures and diverged refs, and moves the cutover state', async () => {
  const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
    if ((init?.method ?? 'GET') !== 'GET') return Response.json({ ok: true });
    if (input.endsWith('/migration')) return Response.json(migration);
    return Response.json(mirrors);
  });
  vi.stubGlobal('fetch', fetcher);
  render(
    <MemoryRouter initialEntries={['/r/acme/tools/mirrors']}>
      <Routes>
        <Route path="/r/:owner/:name/mirrors" element={<MirrorsView />} />
      </Routes>
    </MemoryRouter>,
  );
  expect(await screen.findByText(/refs\/heads\/main diverged$/)).toBeTruthy();
  expect(screen.getByText('failing')).toBeTruthy();
  expect(screen.getByText(/add at least one active ruleset/)).toBeTruthy();
  expect(screen.queryByText(/refs\/heads\/dev/)).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Move to github' }));
  await screen.findByText('Moved to github.');
  const move = fetcher.mock.calls.find(([, init]) => init?.method === 'POST');
  expect(move?.[0]).toContain('/repos/acme/tools/migration');
  expect(JSON.parse(String(move?.[1]?.body))).toEqual({
    to: 'github',
    pull_mirror_id: 'mir_1',
  });
});
