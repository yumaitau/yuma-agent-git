import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { expectAccessible } from '../axe';
import { DeployKeysPanel, SshKeysView } from './SshKeys';

afterEach(() => vi.unstubAllGlobals());

const KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINOEdx+kPFbbWwUu7b2qqFJPHC8ssmQjcAXcxlUtI0rH me';
const row = {
  id: 'k1',
  title: 'laptop',
  key_type: 'ssh-ed25519',
  fingerprint: 'SHA256:+OoWq75yT4/MH8eIQDE78S8gKM4D84Pxwb5+7AZ9LvI',
  created_at: Date.now(),
  last_used_at: null,
};

function stub() {
  const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    if (init?.method === 'POST') return Response.json({ key: row }, { status: 201 });
    if (input.includes('/deploy-keys'))
      return Response.json({
        keys: [{ ...row, title: 'ci', read_only: true, created_by: 'u1' }],
      });
    return Response.json({ keys: [row] });
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

const calls = (fetcher: ReturnType<typeof stub>) =>
  fetcher.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${url}`);

it('lists, adds and removes your SSH keys', async () => {
  const fetcher = stub();
  render(
    <MemoryRouter>
      <SshKeysView />
    </MemoryRouter>,
  );
  expect(await screen.findByText(row.fingerprint)).toBeTruthy();
  await expectAccessible(document.body);
  fireEvent.change(screen.getByPlaceholderText(/ssh-ed25519/), {
    target: { value: KEY },
  });
  fireEvent.click(screen.getByText('Add SSH key'));
  fireEvent.click(screen.getByText('Remove'));
  await vi.waitFor(() =>
    expect(calls(fetcher)).toEqual(
      expect.arrayContaining([
        'POST /api/v1/me/ssh-keys',
        'DELETE /api/v1/me/ssh-keys/k1',
      ]),
    ),
  );
  const post = fetcher.mock.calls.find(([, init]) => init?.method === 'POST');
  expect(JSON.parse(post![1]!.body as string)).toEqual({
    title: 'SSH key',
    public_key: KEY,
  });
});

it('adds deploy keys read-only unless write is ticked', async () => {
  const fetcher = stub();
  render(
    <MemoryRouter>
      <DeployKeysPanel repos={[{ id: 'r1', slug: 'acme/tools' } as never]} />
    </MemoryRouter>,
  );
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'acme/tools' } });
  expect(await screen.findByText('read-only')).toBeTruthy();
  await expectAccessible(document.body);
  fireEvent.change(screen.getByPlaceholderText(/ssh-ed25519/), {
    target: { value: KEY },
  });
  fireEvent.click(screen.getByLabelText(/Allow write access/));
  fireEvent.click(screen.getByText('Add deploy key'));
  fireEvent.click(screen.getByText('Remove ci'));
  await vi.waitFor(() =>
    expect(calls(fetcher)).toEqual(
      expect.arrayContaining([
        'GET /api/v1/repos/acme/tools/deploy-keys',
        'POST /api/v1/repos/acme/tools/deploy-keys',
        'DELETE /api/v1/repos/acme/tools/deploy-keys/k1',
      ]),
    ),
  );
  const post = fetcher.mock.calls.find(([, init]) => init?.method === 'POST');
  expect(JSON.parse(post![1]!.body as string)).toEqual({
    title: 'SSH key',
    public_key: KEY,
    read_only: false,
  });
});
