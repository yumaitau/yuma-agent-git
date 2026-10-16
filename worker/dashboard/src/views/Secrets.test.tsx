import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { expectAccessible } from '../axe';
import { SecretsView } from './Secrets';

afterEach(() => vi.unstubAllGlobals());

function stub() {
  const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
    if (init?.method && init.method !== 'GET') return Response.json({ ok: true });
    if (input.endsWith('/secrets'))
      return Response.json({ secrets: [{ name: 'NPM_TOKEN', updated_at: Date.now() }] });
    return Response.json({
      variables: [{ name: 'REGION', value: 'syd', updated_at: Date.now() }],
    });
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

it('lists org secret names only, saves one write-only and deletes a variable', async () => {
  const fetcher = stub();
  const { container } = render(
    <MemoryRouter initialEntries={['/orgs/yuma/secrets']}>
      <Routes>
        <Route path="/orgs/:org/secrets" element={<SecretsView />} />
      </Routes>
    </MemoryRouter>,
  );
  expect(await screen.findByText('NPM_TOKEN')).toBeTruthy();
  expect(screen.getByText('syd')).toBeTruthy();
  await expectAccessible(container);

  const value = screen.getByLabelText('Secret value') as HTMLInputElement;
  expect(value.type).toBe('password');
  fireEvent.change(screen.getByLabelText('Secret name'), { target: { value: 'DEPLOY' } });
  fireEvent.change(value, { target: { value: 'top-secret' } });
  fireEvent.click(screen.getByText('Save secret'));
  await screen.findByText('DEPLOY saved.');
  // the value goes up once and never comes back into the page
  expect(container.textContent).not.toContain('top-secret');
  await waitFor(() => expect(value.value).toBe(''));

  fireEvent.click(screen.getByLabelText('Delete REGION'));
  await screen.findByText('REGION deleted.');
  expect(
    fetcher.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${url}`),
  ).toEqual(
    expect.arrayContaining([
      'PUT /api/v1/orgs/yuma/secrets/DEPLOY',
      'DELETE /api/v1/orgs/yuma/variables/REGION',
    ]),
  );
  const put = fetcher.mock.calls.find(([, init]) => init?.method === 'PUT');
  expect(JSON.parse(put![1]!.body as string)).toEqual({ value: 'top-secret' });
});
