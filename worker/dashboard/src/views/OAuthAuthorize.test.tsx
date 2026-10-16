import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { OAuthAuthorizeView } from './OAuthAuthorize';

afterEach(() => vi.unstubAllGlobals());

const query =
  '?client_id=oa_1&redirect_uri=https%3A%2F%2Ftool.example.com%2Fcb&scope=repo%3Aread&state=s1&code_challenge=c&code_challenge_method=S256';

it('shows what the app asks for and approves', async () => {
  const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
    if (init?.method === 'POST')
      return Response.json({
        redirect_to: 'https://tool.example.com/cb?code=abc&state=s1',
      });
    expect(input).toBe(`/api/v1/oauth/authorize${query}`);
    return Response.json({
      app: { client_id: 'oa_1', name: 'Tool' },
      scopes: ['repo:read'],
      redirect_uri: 'https://tool.example.com/cb',
    });
  });
  vi.stubGlobal('fetch', fetcher);
  const assign = vi.fn();
  vi.stubGlobal('location', { ...window.location, assign });
  render(
    <MemoryRouter initialEntries={[`/oauth/authorize${query}`]}>
      <Routes>
        <Route path="/oauth/authorize" element={<OAuthAuthorizeView />} />
      </Routes>
    </MemoryRouter>,
  );
  expect(await screen.findByText('Authorise Tool')).toBeTruthy();
  expect(screen.getByText('Read the repositories you can read')).toBeTruthy();
  fireEvent.click(screen.getByText('Authorise'));
  await waitFor(() =>
    expect(assign).toHaveBeenCalledWith('https://tool.example.com/cb?code=abc&state=s1'),
  );
  const post = fetcher.mock.calls.find(([, init]) => init?.method === 'POST');
  expect(JSON.parse(post![1]!.body as string)).toMatchObject({
    client_id: 'oa_1',
    code_challenge_method: 'S256',
    approve: true,
  });
});
