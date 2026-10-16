import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { InboxView } from './Inbox';

afterEach(() => vi.unstubAllGlobals());

const note = {
  id: '01JZ0000000000000000000001',
  repo: 'acme/tools',
  reason: 'review_requested',
  event: 'pull_request',
  action: 'review_requested',
  actor: 'user:u1',
  subject: {
    type: 'pull',
    id: '7',
    number: 3,
    title: 'Fix the parser',
    url: '/r/acme/tools/pulls/7',
  },
  unread: true,
  created_at: Date.now(),
};

function stub() {
  const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (input.startsWith('/api/v1/notifications/settings'))
      return Response.json({
        settings: {
          email: method === 'PUT' ? 'digest' : 'instant',
          digest_hour: 7,
          skip_weekends: false,
          reasons: { review_requested: true, mention: true },
        },
        email_address: 'ada@example.com',
        email_available: true,
        digest_time_zone: 'Australia/Sydney',
      });
    if (method === 'PATCH')
      return Response.json({ notification: { ...note, unread: false } });
    if (method === 'POST') return Response.json({ ok: true });
    return Response.json({
      notifications: input.includes('state=done') ? [] : [note],
      names: { 'user:u1': 'ada' },
      unread_count: 1,
      next_cursor: null,
    });
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

function mount() {
  return render(
    <MemoryRouter initialEntries={['/inbox']}>
      <Routes>
        <Route path="/inbox" element={<InboxView />} />
      </Routes>
    </MemoryRouter>,
  );
}

it('lists notifications with their reason and marks one done', async () => {
  const fetcher = stub();
  mount();
  expect(await screen.findByText('Fix the parser')).toBeTruthy();
  expect(screen.getAllByText('Review requested')).toHaveLength(2); // the chip and the setting
  expect(screen.getByText('1 unread')).toBeTruthy();
  expect(screen.getByText(/ada ·/)).toBeTruthy();
  fireEvent.click(screen.getByLabelText('Done: Fix the parser'));
  await vi.waitFor(() => {
    const patch = fetcher.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(patch![0]).toBe(`/api/v1/notifications/${note.id}`);
    expect(JSON.parse(patch![1]!.body as string)).toEqual({ done: true });
  });
  fireEvent.click(screen.getByText('Mark all read'));
  await vi.waitFor(() =>
    expect(
      fetcher.mock.calls.some(
        ([url, init]) => url === '/api/v1/notifications/read' && init?.method === 'POST',
      ),
    ).toBe(true),
  );
});

it('switches email to a daily digest in Australia/Sydney time', async () => {
  const fetcher = stub();
  mount();
  const select = await screen.findByLabelText('Notification email');
  fireEvent.change(select, { target: { value: 'digest' } });
  expect(await screen.findByText('Saved.')).toBeTruthy();
  const put = fetcher.mock.calls.find(([, init]) => init?.method === 'PUT');
  expect(JSON.parse(put![1]!.body as string)).toEqual({ email: 'digest' });
  expect(screen.getByLabelText('Digest hour (Australia/Sydney)')).toBeTruthy();
  expect(screen.getByText('No digest on weekends')).toBeTruthy();
});
