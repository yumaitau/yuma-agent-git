import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api, type Approval, type Repo } from '../api';
import { ToastProvider } from '../toast';
import { AgentPausePanel, ApprovalsPanel } from './Guardrails';
import { expectAccessible } from '../axe';

afterEach(() => vi.restoreAllMocks());

const pause = {
  paused_by: 'u1',
  paused_by_login: 'justin',
  reason: 'incident 7',
  paused_at: Date.now(),
};

it('pauses agents and shows who paused them and why', async () => {
  const get = vi
    .spyOn(api, 'getAgentPause')
    .mockResolvedValueOnce({ paused: null, instance: null })
    .mockResolvedValue({ paused: pause, instance: null });
  const pauseAgents = vi.spyOn(api, 'pauseAgents').mockResolvedValue(pause);
  const resume = vi.spyOn(api, 'resumeAgents').mockResolvedValue();
  render(
    <ToastProvider>
      <AgentPausePanel org="acme" canManage />
    </ToastProvider>,
  );
  fireEvent.change(await screen.findByLabelText('Reason'), {
    target: { value: ' incident 7 ' },
  });
  await expectAccessible(document.body);
  fireEvent.click(screen.getByRole('button', { name: 'Pause all agents' }));
  await waitFor(() => expect(pauseAgents).toHaveBeenCalledWith('acme', 'incident 7'));
  expect(await screen.findByText(/justin .*: incident 7/)).toBeTruthy();
  expect(get).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole('button', { name: 'Resume agents' }));
  await waitFor(() => expect(resume).toHaveBeenCalledWith('acme'));
});

it('shows an instance pause to members who cannot manage the org', async () => {
  vi.spyOn(api, 'getAgentPause').mockResolvedValue({ paused: null, instance: pause });
  render(
    <ToastProvider>
      <AgentPausePanel org="acme" canManage={false} />
    </ToastProvider>,
  );
  expect(await screen.findByText('paused on this forge')).toBeTruthy();
  await expectAccessible(document.body);
  expect(screen.queryByRole('button', { name: 'Pause all agents' })).toBeNull();
});

it('lists held agent changes and approves one', async () => {
  const held: Approval = {
    id: 'ap1',
    action: 'push',
    principal: 'agent:agt_1',
    on_behalf_of_login: 'justin',
    payload_hash: 'ab'.repeat(32),
    payload: { ref: 'feature', files: ['.github/workflows/ci.yml'] },
    reasons: [
      {
        rule: 'ci-workflows',
        message: 'policy ci-workflows needs approval: changes .github/workflows/ci.yml',
      },
    ],
    requested_at: Date.now(),
    decision: 'pending',
    decided_by_login: null,
    decided_at: null,
  };
  vi.spyOn(api, 'listApprovals').mockResolvedValueOnce([held]).mockResolvedValue([]);
  const decide = vi
    .spyOn(api, 'decideApproval')
    .mockResolvedValue({ ...held, decision: 'approved' });
  render(
    <ToastProvider>
      <ApprovalsPanel repos={[{ id: 'r1', slug: 'acme/app' } as Repo]} />
    </ToastProvider>,
  );
  fireEvent.change(screen.getByLabelText('Repository'), {
    target: { value: 'acme/app' },
  });
  expect(
    await screen.findByText(
      'policy ci-workflows needs approval: changes .github/workflows/ci.yml',
    ),
  ).toBeTruthy();
  await expectAccessible(document.body);
  expect(screen.getByText('sha256 abababababab')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
  await waitFor(() => expect(decide).toHaveBeenCalledWith('acme/app', 'ap1', 'approve'));
  expect(await screen.findByText('Nothing waits for approval.')).toBeTruthy();
});
