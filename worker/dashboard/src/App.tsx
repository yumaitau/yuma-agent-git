import { useEffect } from 'react';
import type { ReactElement } from 'react';
import { Route, Routes, useNavigate } from 'react-router-dom';
import { setUnauthorizedHandler } from './api';
import { CiView, HistoryView, PullsView, PullView } from './views/Collaboration';
import { IssuesView, NewIssueView } from './views/Issues';
import { IssueView } from './views/IssueView';
import { BoardView } from './views/Board';
import { CiAccessView } from './views/CiAccess';
import { RunnersView } from './views/Runners';
import { WebhooksView } from './views/Webhooks';
import { OAuthAuthorizeView } from './views/OAuthAuthorize';
import { Layout } from './Layout';
import { RequireAuth } from './RequireAuth';
import { HomeView } from './views/Home';
import { LoginView } from './views/Login';
import { RepoOverviewView } from './views/RepoOverview';
import { ChangesetView } from './views/ChangesetView';
import { TreeView } from './views/TreeView';
import { DiffExplorerView } from './views/DiffExplorer';
import { AgentsView, TaskDetailView } from './views/Agents';
import { SettingsView } from './views/Settings';
import { OrgSettingsView } from './views/OrgSettings';
import { SecurityView } from './views/Security';
import { Empty } from './ui';

function NotFound(): ReactElement {
  return (
    <Empty>
      No such page. <a href="/">Back to repositories</a>.
    </Empty>
  );
}

/**
 * Route table. Repo slugs are `owner/name`, so repo routes carry the two
 * segments separately (`/r/:owner/:name/...`). Everything except /login
 * requires a signed-in session.
 */
function AppRoutes(): ReactElement {
  const navigate = useNavigate();

  useEffect(() => {
    setUnauthorizedHandler(() => navigate('/login', { replace: true }));
    return () => setUnauthorizedHandler(null);
  }, [navigate]);

  return (
    <Layout>
      <Routes>
        <Route path="/login" element={<LoginView />} />
        <Route
          path="*"
          element={
            <RequireAuth>
              <Routes>
                <Route path="/" element={<HomeView />} />
                <Route path="/settings" element={<SettingsView />} />
                <Route path="/security" element={<SecurityView />} />
                <Route path="/orgs" element={<OrgSettingsView />} />
                <Route path="/orgs/:org" element={<OrgSettingsView />} />
                <Route path="/orgs/:org/runners" element={<RunnersView />} />
                <Route path="/r/:owner/:name/history" element={<HistoryView />} />
                <Route path="/r/:owner/:name/issues" element={<IssuesView />} />
                <Route path="/r/:owner/:name/issues/new" element={<NewIssueView />} />
                <Route path="/r/:owner/:name/issues/:number" element={<IssueView />} />
                <Route path="/r/:owner/:name/board" element={<BoardView />} />
                <Route path="/r/:owner/:name/pulls" element={<PullsView />} />
                <Route path="/r/:owner/:name/pulls/:id" element={<PullView />} />
                <Route path="/r/:owner/:name/ci" element={<CiView />} />
                <Route path="/r/:owner/:name/ci/access" element={<CiAccessView />} />
                <Route path="/r/:owner/:name/ci/runners" element={<RunnersView />} />
                <Route path="/r/:owner/:name/hooks" element={<WebhooksView />} />
                <Route path="/oauth/authorize" element={<OAuthAuthorizeView />} />
                <Route path="/r/:owner/:name" element={<RepoOverviewView />} />
                <Route path="/r/:owner/:name/cs/:id" element={<ChangesetView />} />
                <Route path="/r/:owner/:name/diff" element={<DiffExplorerView />} />
                <Route path="/r/:owner/:name/tree/:cs" element={<TreeView />} />
                <Route path="/r/:owner/:name/tree/:cs/*" element={<TreeView />} />
                <Route path="/r/:owner/:name/agents" element={<AgentsView />} />
                <Route
                  path="/r/:owner/:name/agents/:taskId"
                  element={<TaskDetailView />}
                />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </RequireAuth>
          }
        />
      </Routes>
    </Layout>
  );
}

export function App(): ReactElement {
  return <AppRoutes />;
}
