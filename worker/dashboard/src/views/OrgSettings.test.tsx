import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../api';
import { Layout } from '../Layout';
import { ToastProvider } from '../toast';
import { OrgSettingsView } from './OrgSettings';

const org = {
  id: 'o1',
  slug: 'yuma',
  display_name: 'Yuma',
  created_at: 1,
  base_role: 'none' as const,
  members_can_create_repos: false,
};
afterEach(() => vi.restoreAllMocks());

function renderAt(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <ToastProvider>
        <Routes>
          <Route path="/orgs" element={<OrgSettingsView />} />
          <Route path="/orgs/:org" element={<OrgSettingsView />} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>,
  );
}

it('creates an organisation and opens its settings', async () => {
  vi.spyOn(api, 'listOrgs').mockResolvedValue([]);
  const create = vi.spyOn(api, 'createOrg').mockResolvedValue(org);
  vi.spyOn(api, 'getOrg').mockResolvedValue({ org, role: 'owner' });
  vi.spyOn(api, 'listOrgMembers').mockResolvedValue([]);
  vi.spyOn(api, 'listTeams').mockResolvedValue([]);
  vi.spyOn(api, 'listOrgRepos').mockResolvedValue([]);
  renderAt('/orgs');
  expect(await screen.findByText('You are not in any organisation yet.')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Organisation slug'), {
    target: { value: 'yuma' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Create organisation' }));
  expect(await screen.findByText('Base permissions')).toBeTruthy();
  expect(create).toHaveBeenCalledWith({ slug: 'yuma' });
});

it('manages members, nested teams and team repo grants', async () => {
  vi.spyOn(api, 'getOrg').mockResolvedValue({ org, role: 'owner' });
  vi.spyOn(api, 'listOrgMembers').mockResolvedValue([
    { user_id: 'u1', login: 'olive', role: 'owner' },
  ]);
  vi.spyOn(api, 'listTeams').mockResolvedValue([
    { id: 't1', slug: 'eng', parent: null, created_at: 1 },
  ]);
  vi.spyOn(api, 'listOrgRepos').mockResolvedValue([
    {
      id: 'r1',
      slug: 'yuma/core',
      visibility: 'private',
      default_branch: 'main',
      created_at: 1,
    },
  ]);
  vi.spyOn(api, 'getTeam').mockResolvedValue({
    team: { id: 't1', slug: 'eng', parent: null, created_at: 1 },
    members: [],
    repos: [],
  });
  const putMember = vi.spyOn(api, 'putOrgMember').mockResolvedValue();
  const createTeam = vi.spyOn(api, 'createTeam').mockResolvedValue({
    id: 't2',
    slug: 'backend',
    parent: 'eng',
    created_at: 2,
  });
  const grant = vi.spyOn(api, 'putTeamRepo').mockResolvedValue();
  renderAt('/orgs/yuma');

  expect(await screen.findByText('olive')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('GitHub login'), { target: { value: 'max' } });
  fireEvent.change(screen.getByLabelText('Org role'), { target: { value: 'admin' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add / update member' }));
  await waitFor(() =>
    expect(putMember).toHaveBeenCalledWith('yuma', { user_login: 'max', role: 'admin' }),
  );

  fireEvent.change(screen.getByLabelText('Team slug'), { target: { value: 'backend' } });
  fireEvent.change(screen.getByLabelText('Parent team'), { target: { value: 'eng' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create team' }));
  await waitFor(() =>
    expect(createTeam).toHaveBeenCalledWith('yuma', { slug: 'backend', parent: 'eng' }),
  );

  fireEvent.click(screen.getByRole('button', { name: 'eng' }));
  fireEvent.change(await screen.findByLabelText('Grant repository'), {
    target: { value: 'yuma/core' },
  });
  fireEvent.change(screen.getByLabelText('Team role'), { target: { value: 'write' } });
  fireEvent.click(screen.getByRole('button', { name: 'Grant' }));
  await waitFor(() =>
    expect(grant).toHaveBeenCalledWith('yuma', 'eng', {
      repo: 'yuma/core',
      role: 'write',
    }),
  );
});

it('shows the org switcher once signed in and navigates to the chosen org', async () => {
  vi.spyOn(api, 'checkSession').mockResolvedValue(true);
  vi.spyOn(api, 'listOrgs').mockResolvedValue([{ ...org, role: 'member' }]);
  render(
    <MemoryRouter initialEntries={['/']}>
      <Layout>
        <Routes>
          <Route path="/" element={<div>home</div>} />
          <Route path="/orgs/:org" element={<div>org page</div>} />
        </Routes>
      </Layout>
    </MemoryRouter>,
  );
  const switcher = await screen.findByLabelText('Organisation');
  await screen.findByRole('option', { name: 'yuma' });
  fireEvent.change(switcher, { target: { value: 'yuma' } });
  expect(await screen.findByText('org page')).toBeTruthy();
});
