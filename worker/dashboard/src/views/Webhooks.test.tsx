import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { WebhooksView } from './Webhooks';
import { expectAccessible } from '../axe';

afterEach(() => vi.unstubAllGlobals());

function mount() {
  return render(
    <MemoryRouter initialEntries={['/r/acme/tools/hooks']}>
      <Routes>
        <Route path="/r/:owner/:name/hooks" element={<WebhooksView />} />
      </Routes>
    </MemoryRouter>,
  );
}

const hooks = {
  hooks: [
    {
      id: 'hook_1',
      url: 'https://hooks.example.com/ci',
      events: ['push'],
      format: 'github',
      active: true,
      created_at: Date.now(),
    },
  ],
};
const deliveries = {
  deliveries: [
    {
      id: 'dlv_1',
      event: 'push',
      action: null,
      status: 'failed',
      attempts: 12,
      response_code: 503,
      error: 'http_503',
      created_at: Date.now(),
      next_attempt_at: null,
      redelivery_of: null,
    },
  ],
};

function stub() {
  const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method === 'POST' && input.endsWith('/hooks'))
      return Response.json(
        { hook: hooks.hooks[0], secret: 'generated-secret-value' },
        { status: 201 },
      );
    if (method !== 'GET') return Response.json({ ok: true }, { status: 202 });
    if (input.endsWith('/deliveries')) return Response.json(deliveries);
    return Response.json(hooks);
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

it('shows the delivery log and redelivers', async () => {
  const fetcher = stub();
  mount();
  expect(await screen.findByText('https://hooks.example.com/ci')).toBeTruthy();
  await expectAccessible(document.body);
  fireEvent.click(screen.getByText('Deliveries'));
  expect(await screen.findByText('failed')).toBeTruthy();
  expect(screen.getByText(/12 attempts · HTTP 503/)).toBeTruthy();
  fireEvent.click(screen.getByText('Redeliver'));
  await screen.findByText('Redelivery queued.');
  const post = fetcher.mock.calls.find(([, init]) => init?.method === 'POST');
  expect(post![0]).toBe('/api/v1/hooks/hook_1/deliveries/dlv_1/redeliver');
});

it('creates a hook and shows a generated secret once', async () => {
  const fetcher = stub();
  mount();
  await screen.findByText('https://hooks.example.com/ci');
  await expectAccessible(document.body);
  fireEvent.change(screen.getByLabelText('Payload URL'), {
    target: { value: 'https://hooks.example.com/new' },
  });
  fireEvent.click(screen.getByLabelText('issues'));
  fireEvent.click(screen.getByText('Add webhook'));
  expect(await screen.findByText('generated-secret-value')).toBeTruthy();
  const post = fetcher.mock.calls.find(([, init]) => init?.method === 'POST');
  expect(post![0]).toBe('/api/v1/repos/acme/tools/hooks');
  expect(JSON.parse(post![1]!.body as string)).toEqual({
    url: 'https://hooks.example.com/new',
    events: ['push', 'pull_request', 'issues'],
    format: 'yag',
  });
});
