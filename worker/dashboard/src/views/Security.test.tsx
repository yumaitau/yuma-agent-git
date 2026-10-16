import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { api, type Security } from '../api';
import { ToastProvider } from '../toast';
import { SecurityView } from './Security';

afterEach(() => vi.restoreAllMocks());

const base: Security = {
  user: { id: 'u1', login: 'ada' },
  session: { auth_method: 'oidc:google', mfa_at: null, mfa_fresh: false },
  identities: [{ provider: 'oidc:google', email: 'ada@yuma.test', linked_at: 1 }],
  passkeys: [],
  totp: { enrolled: false },
  providers: [
    { id: 'google', name: 'Google' },
    { id: 'entra', name: 'Microsoft' },
  ],
};

function renderView(): void {
  render(
    <MemoryRouter>
      <ToastProvider>
        <SecurityView />
      </ToastProvider>
    </MemoryRouter>,
  );
}

it('shows how the session signed in and offers to link other providers', async () => {
  vi.spyOn(api, 'getSecurity').mockResolvedValue(base);
  renderView();
  expect(await screen.findByText('no second factor enrolled')).toBeTruthy();
  expect(screen.getAllByText('Google').length).toBeGreaterThan(0);
  expect(screen.getByText('ada@yuma.test')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Link Microsoft' }).getAttribute('href')).toBe(
    '/auth/oidc/entra?link=1',
  );
  expect(screen.queryByRole('link', { name: 'Link Google' })).toBeNull();
});

it('enrols an authenticator app: shows the key once, then confirms a code', async () => {
  const get = vi.spyOn(api, 'getSecurity').mockResolvedValue(base);
  vi.spyOn(api, 'startTotp').mockResolvedValue({
    secret: 'JBSWY3DPEHPK3PXP',
    otpauth_uri: 'otpauth://totp/Yuma:ada?secret=JBSWY3DPEHPK3PXP',
  });
  const confirm = vi.spyOn(api, 'confirmTotp').mockResolvedValue();
  renderView();
  fireEvent.click(await screen.findByText('Set up an authenticator app'));
  expect(await screen.findByText('JBSWY3DPEHPK3PXP')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Code from the app'), {
    target: { value: '123456' },
  });
  get.mockResolvedValue({ ...base, totp: { enrolled: true } });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  await waitFor(() => expect(confirm).toHaveBeenCalledWith('123456'));
  expect(await screen.findByText('enrolled')).toBeTruthy();
});

it('asks for a fresh second factor when one is enrolled but stale', async () => {
  const get = vi
    .spyOn(api, 'getSecurity')
    .mockResolvedValue({ ...base, totp: { enrolled: true } });
  const verify = vi.spyOn(api, 'verifyMfaTotp').mockResolvedValue();
  renderView();
  expect(
    await screen.findByText('second factor needed for sensitive actions'),
  ).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Authenticator code'), {
    target: { value: '654321' },
  });
  get.mockResolvedValue({
    ...base,
    totp: { enrolled: true },
    session: { auth_method: 'oidc:google', mfa_at: 2, mfa_fresh: true },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Verify code' }));
  await waitFor(() => expect(verify).toHaveBeenCalledWith('654321'));
  // the status chip and the toast both say so
  expect((await screen.findAllByText('second factor verified')).length).toBeGreaterThan(
    0,
  );
});
