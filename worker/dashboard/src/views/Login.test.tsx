import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import { ErrorNotice } from '../ui';
import { LoginView } from './Login';

afterEach(() => vi.unstubAllGlobals());

it('explains hidden repositories without claiming they exist', () => {
  render(
    <MemoryRouter>
      <ErrorNotice error={new ApiError(404, 'repo_not_found', 'no repo acme/private')} />
    </MemoryRouter>,
  );
  expect(screen.getByRole('alert').textContent).toContain('may be private, missing');
  expect(screen.getByRole('link').getAttribute('href')).toBe('/login');
  expect(screen.queryByText('Error 404')).toBeNull();
});

it('explains incomplete setup instead of sending visitors to a broken OAuth endpoint', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ github_configured: false })),
  );
  render(
    <MemoryRouter>
      <LoginView />
    </MemoryRouter>,
  );
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    expect.stringContaining('Sign-in setup is incomplete'),
  );
  expect(screen.queryByRole('link', { name: 'Sign in with GitHub' })).toBeNull();
});

it('offers GitHub sign-in when credentials are configured', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ github_configured: true })),
  );
  render(
    <MemoryRouter>
      <LoginView />
    </MemoryRouter>,
  );
  expect(
    (await screen.findByRole('link', { name: 'Sign in with GitHub' })).getAttribute(
      'href',
    ),
  ).toBe('/auth/github');
});

it('lists configured identity providers ahead of GitHub', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        github_configured: true,
        providers: [{ id: 'google', name: 'Google' }],
      }),
    ),
  );
  render(
    <MemoryRouter>
      <LoginView />
    </MemoryRouter>,
  );
  const google = await screen.findByRole('link', { name: 'Sign in with Google' });
  expect(google.getAttribute('href')).toBe('/auth/oidc/google');
  expect(screen.getByRole('link', { name: 'Sign in with GitHub' })).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});

it('does not call setup incomplete when only an OIDC provider is configured', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        github_configured: false,
        providers: [{ id: 'entra', name: 'Microsoft' }],
      }),
    ),
  );
  render(
    <MemoryRouter>
      <LoginView />
    </MemoryRouter>,
  );
  await screen.findByRole('link', { name: 'Sign in with Microsoft' });
  expect(screen.queryByText('Sign-in setup is incomplete')).toBeNull();
  expect(screen.queryByRole('link', { name: 'Sign in with GitHub' })).toBeNull();
});
