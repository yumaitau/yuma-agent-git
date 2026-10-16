import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api, type AgentIdentity } from '../api';
import { ToastProvider } from '../toast';
import { AgentIdentities } from './Agents';
import { expectAccessible } from '../axe';

afterEach(() => vi.restoreAllMocks());

const codex: AgentIdentity = {
  id: 'agt_1',
  owner_kind: 'user',
  owner_id: 'u1',
  name: 'Codex',
  kind: 'codex',
  max_scopes: ['contents:read', 'contents:write'],
  allowed_repos: null,
  created_at: 1,
  disabled: false,
  live_tokens: 2,
};

it('lists agents and disables one with the kill switch', async () => {
  const list = vi.spyOn(api, 'listAgents').mockResolvedValue([codex]);
  const disable = vi
    .spyOn(api, 'setAgentDisabled')
    .mockResolvedValue({ ...codex, disabled: true });
  render(
    <ToastProvider>
      <AgentIdentities />
    </ToastProvider>,
  );
  expect(await screen.findByText('Codex')).toBeTruthy();
  await expectAccessible(document.body);
  expect(screen.getByText('active')).toBeTruthy();
  list.mockResolvedValue([{ ...codex, disabled: true, live_tokens: 0 }]);
  fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
  await waitFor(() => expect(disable).toHaveBeenCalledWith('agt_1', true));
  expect(await screen.findByRole('button', { name: 'Enable' })).toBeTruthy();
});

it('adds an agent identity', async () => {
  vi.spyOn(api, 'listAgents').mockResolvedValue([]);
  const create = vi.spyOn(api, 'createAgent').mockResolvedValue(codex);
  render(
    <ToastProvider>
      <AgentIdentities />
    </ToastProvider>,
  );
  expect(await screen.findByText('No agent identities yet.')).toBeTruthy();
  await expectAccessible(document.body);
  fireEvent.change(screen.getByLabelText('Agent name'), { target: { value: 'Codex' } });
  fireEvent.change(screen.getByLabelText('Agent kind'), { target: { value: 'codex' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add agent' }));
  await waitFor(() =>
    expect(create).toHaveBeenCalledWith({ name: 'Codex', kind: 'codex' }),
  );
});
