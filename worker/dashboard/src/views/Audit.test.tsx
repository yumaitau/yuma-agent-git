import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { expectAccessible } from '../axe';
import { AuditView } from './Audit';

afterEach(() => vi.unstubAllGlobals());

function event(id: number, action: string) {
  return {
    id,
    org_id: 'o1',
    repo_id: id === 2 ? 'repo-1' : null,
    actor_kind: 'user',
    actor_id: 'u1',
    on_behalf_of: null,
    action,
    target: { ruleset: 'main' },
    ip: null,
    at: Date.UTC(2026, 9, 17),
  };
}

function mount() {
  return render(
    <MemoryRouter initialEntries={['/orgs/yuma/audit']}>
      <Routes>
        <Route path="/orgs/:org/audit" element={<AuditView />} />
      </Routes>
    </MemoryRouter>,
  );
}

it('lists audit events, pages back and filters through the API', async () => {
  const fetcher = vi.fn(async (input: string) => {
    const url = new URL(input, 'https://yag.test');
    if (url.searchParams.get('cursor') === '2')
      return Response.json({ events: [event(1, 'org.member.add')], next_cursor: null });
    if (url.searchParams.get('action'))
      return Response.json({ events: [event(3, 'ruleset.update')], next_cursor: null });
    return Response.json({
      events: [event(3, 'ruleset.update'), event(2, 'repo.create')],
      next_cursor: 2,
    });
  });
  vi.stubGlobal('fetch', fetcher);
  const { container } = mount();
  expect(await screen.findByText('repo.create')).toBeTruthy();
  expect(screen.getByText('2 events, newest first')).toBeTruthy();
  expect(screen.getByText('repo-1')).toBeTruthy();
  await expectAccessible(container);

  fireEvent.click(screen.getByText('Load older events'));
  expect(await screen.findByText('org.member.add')).toBeTruthy();
  expect(screen.queryByText('Load older events')).toBeNull();

  fireEvent.change(screen.getByLabelText('Action'), {
    target: { value: 'ruleset.update' },
  });
  fireEvent.change(screen.getByLabelText('From (UTC)'), {
    target: { value: '2026-10-01' },
  });
  fireEvent.click(screen.getByText('Filter'));
  await screen.findByText('1 event, newest first');
  expect(fetcher).toHaveBeenLastCalledWith(
    '/api/v1/orgs/yuma/audit?action=ruleset.update&from=2026-10-01',
    expect.anything(),
  );
  const csv = screen.getByText('CSV');
  expect(csv.getAttribute('href')).toBe(
    '/api/v1/orgs/yuma/audit?action=ruleset.update&from=2026-10-01&format=csv',
  );
});

it('explains when the viewer is not an audit admin', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json(
        { error: { code: 'forbidden', message: 'audit admin required' } },
        { status: 403 },
      ),
    ),
  );
  mount();
  expect(await screen.findByText(/audit admin required/)).toBeTruthy();
});
