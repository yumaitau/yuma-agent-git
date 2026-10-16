import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api, type Repo, type Ruleset } from '../api';
import { ToastProvider } from '../toast';
import { RulesetsPanel } from './Rulesets';

afterEach(() => vi.restoreAllMocks());

const repo = { id: 'r1', slug: 'team/app' } as Repo;
const ciPolicy: Ruleset = {
  id: 'rs1',
  scope: 'repo',
  name: 'CI policy (default branch)',
  target: 'branch',
  enforcement: 'active',
  conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
  rules: [{ type: 'update' }, { type: 'pull_request', required_approvals: 1 }],
  bypass: [],
  updated_at: 1,
};
const orgRule: Ruleset = {
  ...ciPolicy,
  id: 'rs2',
  scope: 'org',
  name: 'Org tags',
  target: 'tag',
  conditions: { ref_name: { include: ['v*'], exclude: [] } },
  rules: [{ type: 'deletion' }],
};

it('lists repo and org rulesets, the evaluate-mode report, and edits rulesets', async () => {
  vi.spyOn(api, 'listRulesets').mockResolvedValue({
    rulesets: [ciPolicy],
    inherited: [orgRule],
  });
  vi.spyOn(api, 'listRulesetEvaluations').mockResolvedValue([
    {
      id: 1,
      ruleset: 'Trial',
      ref: 'main',
      via: 'git-push',
      actor_id: 'u1',
      violations: [
        { rule: 'non_fast_forward', message: 'force pushes to main are not allowed' },
      ],
      at: Date.now(),
    },
  ]);
  const update = vi.spyOn(api, 'updateRuleset').mockResolvedValue(ciPolicy);
  const create = vi.spyOn(api, 'createRuleset').mockResolvedValue(ciPolicy);
  render(
    <ToastProvider>
      <RulesetsPanel repos={[repo]} />
    </ToastProvider>,
  );
  fireEvent.change(screen.getByLabelText('Repository'), {
    target: { value: 'team/app' },
  });
  expect(await screen.findByText('pull request only; 1 approval(s)')).toBeTruthy();
  expect(screen.getByText('Org tags')).toBeTruthy();
  expect(screen.getByText('force pushes to main are not allowed')).toBeTruthy();

  fireEvent.change(screen.getByLabelText('Enforcement of CI policy (default branch)'), {
    target: { value: 'evaluate' },
  });
  await waitFor(() =>
    expect(update).toHaveBeenCalledWith(
      'team/app',
      'rs1',
      expect.objectContaining({ enforcement: 'evaluate', rules: ciPolicy.rules }),
    ),
  );

  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Small files' } });
  fireEvent.change(screen.getByLabelText('Target'), { target: { value: 'push' } });
  fireEvent.change(screen.getByLabelText('Max file size (MB)'), {
    target: { value: '50' },
  });
  fireEvent.change(
    screen.getByLabelText('Bypass (role:admin, team:slug, agent:ID, user:ID)'),
    {
      target: { value: 'role:admin, team:ops' },
    },
  );
  fireEvent.click(screen.getByRole('button', { name: 'Create ruleset' }));
  await waitFor(() =>
    expect(create).toHaveBeenCalledWith('team/app', {
      name: 'Small files',
      target: 'push',
      enforcement: 'active',
      conditions: {},
      rules: [{ type: 'max_file_size', max_bytes: 50 * 1024 * 1024 }],
      bypass: ['role:admin', 'team:ops'],
    }),
  );
});
