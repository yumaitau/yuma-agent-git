import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { CiAccessView } from './CiAccess';

afterEach(() => vi.unstubAllGlobals());

function mount() {
  return render(
    <MemoryRouter initialEntries={['/r/acme/tools/ci/access']}>
      <Routes>
        <Route path="/r/:owner/:name/ci/access" element={<CiAccessView />} />
      </Routes>
    </MemoryRouter>,
  );
}

function stub(responses: Record<string, unknown>) {
  const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
    if (init?.method && init.method !== 'GET') return Response.json({ ok: true });
    const path = input.split('?')[0]!;
    const key = Object.keys(responses).find((k) => path.endsWith(k));
    return key
      ? Response.json(responses[key])
      : Response.json({ error: { code: 'forbidden', message: 'no' } }, { status: 403 });
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

const environments = {
  environments: [
    {
      name: 'production',
      rules: {
        reviewers: [{ type: 'user', id: 'u1', name: 'reviewer' }],
        wait_timer_minutes: 0,
        allowed_branches: ['main'],
        humans_only: true,
      },
      updated_at: Date.now(),
    },
  ],
};
const approvals = {
  approvals: [
    {
      id: 'appr-1',
      environment: 'production',
      head_cs: 'a'.repeat(64),
      ref: 'refs/heads/main',
      actor_kind: 'human',
      requested_by: 'u2',
      state: 'pending',
      created_at: Date.now(),
      not_before: Date.now(),
    },
  ],
};

it('lists secret names without values and saves a new secret write-only', async () => {
  const fetcher = stub({
    '/environments': environments,
    '/environment-approvals': approvals,
    '/secrets': { secrets: [{ name: 'NPM_TOKEN', updated_at: Date.now() }] },
    '/variables': {
      variables: [{ name: 'REGION', value: 'syd', updated_at: Date.now() }],
    },
  });
  mount();
  expect(await screen.findByText('NPM_TOKEN')).toBeTruthy();
  expect(screen.getByText('syd')).toBeTruthy();
  expect(screen.getByText(/reviewers: reviewer/)).toBeTruthy();
  const value = screen.getByLabelText('Secret value') as HTMLInputElement;
  expect(value.type).toBe('password');
  fireEvent.change(screen.getByLabelText('Secret name'), { target: { value: 'DEPLOY' } });
  fireEvent.change(value, { target: { value: 'top-secret' } });
  fireEvent.click(screen.getByText('Save secret'));
  await screen.findByText('DEPLOY saved.');
  const put = fetcher.mock.calls.find(([, init]) => init?.method === 'PUT');
  expect(put![0]).toBe('/api/v1/repos/acme/tools/secrets/DEPLOY');
  expect(JSON.parse(put![1]!.body as string)).toEqual({ value: 'top-secret' });
  await waitFor(() => expect(value.value).toBe(''));
});

it('approves a pending run and hides secrets from non-admins', async () => {
  const fetcher = stub({
    '/environments': environments,
    '/environment-approvals': approvals,
  });
  mount();
  fireEvent.click(await screen.findByText('Approve'));
  await screen.findByText('Run approved.');
  const post = fetcher.mock.calls.find(([, init]) => init?.method === 'POST');
  expect(post![0]).toBe('/api/v1/repos/acme/tools/environment-approvals/appr-1');
  expect(JSON.parse(post![1]!.body as string)).toEqual({ decision: 'approve' });
  expect(screen.queryByText('Secrets and variables')).toBeNull();
});
