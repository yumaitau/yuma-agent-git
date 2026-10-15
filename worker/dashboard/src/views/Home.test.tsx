import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../api';
import { ToastProvider } from '../toast';
import { HomeView } from './Home';
import { RepoOverviewView } from './RepoOverview';

const repo = {
  id: 'native',
  slug: 'team/native',
  default_branch: 'release/start',
  visibility: 'private' as const,
  created_at: 1,
};
afterEach(() => vi.restoreAllMocks());

it('creates a native repository and opens its code page without a GitHub connection', async () => {
  vi.spyOn(api, 'listRepos').mockResolvedValue([]);
  const create = vi.spyOn(api, 'createRepo').mockResolvedValue(repo);
  const connect = vi.spyOn(api, 'connectRepo');
  render(
    <MemoryRouter>
      <ToastProvider>
        <Routes>
          <Route path="/" element={<HomeView />} />
          <Route path="/r/team/native" element={<div>Native code page</div>} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>,
  );
  expect(screen.queryByText('Install the GitHub App')).toBeNull();
  fireEvent.click(screen.getByText('New repository'));
  fireEvent.change(screen.getByLabelText('Repository (owner/name)'), {
    target: { value: repo.slug },
  });
  fireEvent.change(screen.getByLabelText('Default branch'), {
    target: { value: repo.default_branch },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Create repository' }));
  expect(await screen.findByText('Native code page')).toBeTruthy();
  expect(create).toHaveBeenCalledWith({
    slug: repo.slug,
    default_branch: repo.default_branch,
    visibility: 'private',
  });
  expect(connect).not.toHaveBeenCalled();
});

it('initializes native history and offers the correct clone command and Yuma CI', async () => {
  vi.spyOn(api, 'getRepo').mockResolvedValue({ repo, can_admin: true });
  const refs = vi.spyOn(api, 'listRefs').mockResolvedValue([]);
  vi.spyOn(api, 'listChangesets').mockResolvedValue([]);
  const initialize = vi.spyOn(api, 'initializeRepo').mockImplementation(async () => {
    refs.mockResolvedValue([
      { name: repo.default_branch, head: 'a'.repeat(64), updated_at: 1 },
    ]);
  });
  render(
    <MemoryRouter initialEntries={['/r/team/native']}>
      <ToastProvider>
        <Routes>
          <Route path="/r/:owner/:name" element={<RepoOverviewView />} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByText('Create initial README'));
  await waitFor(() => expect(initialize).toHaveBeenCalledWith(repo.slug));
  const ci = await screen.findByText('Set up Yuma CI');
  expect(ci.getAttribute('href')).toBe('/r/team/native/ci');
  expect(screen.getByText(/yag clone/).textContent).toContain(
    "--rev 'ref:release/start'",
  );
  expect(screen.queryByText('Export to GitHub')).toBeNull();
});
