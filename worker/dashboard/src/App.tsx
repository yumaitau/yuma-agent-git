import { lazy, Suspense, useEffect } from 'react';
import type { ReactElement } from 'react';
import { Route, Routes, useNavigate } from 'react-router-dom';
import { setUnauthorizedHandler } from './api';
import { Layout } from './Layout';
import { RequireAuth } from './RequireAuth';
import { LoginView } from './views/Login';
import { Empty, Loading } from './ui';

// Views load on first visit (issue #80); sign-in stays in the entry bundle.
const CiView = lazy(() =>
  import('./views/Collaboration').then((m) => ({ default: m.CiView })),
);
const HistoryView = lazy(() =>
  import('./views/Collaboration').then((m) => ({ default: m.HistoryView })),
);
const PullsView = lazy(() =>
  import('./views/Collaboration').then((m) => ({ default: m.PullsView })),
);
const PullView = lazy(() =>
  import('./views/Collaboration').then((m) => ({ default: m.PullView })),
);
const IssuesView = lazy(() =>
  import('./views/Issues').then((m) => ({ default: m.IssuesView })),
);
const NewIssueView = lazy(() =>
  import('./views/Issues').then((m) => ({ default: m.NewIssueView })),
);
const IssueView = lazy(() =>
  import('./views/IssueView').then((m) => ({ default: m.IssueView })),
);
const BoardView = lazy(() =>
  import('./views/Board').then((m) => ({ default: m.BoardView })),
);
const CiAccessView = lazy(() =>
  import('./views/CiAccess').then((m) => ({ default: m.CiAccessView })),
);
const RunnersView = lazy(() =>
  import('./views/Runners').then((m) => ({ default: m.RunnersView })),
);
const MergeQueueView = lazy(() =>
  import('./views/MergeQueue').then((m) => ({ default: m.MergeQueueView })),
);
const ImportView = lazy(() =>
  import('./views/Import').then((m) => ({ default: m.ImportView })),
);
const WebhooksView = lazy(() =>
  import('./views/Webhooks').then((m) => ({ default: m.WebhooksView })),
);
const SecretScanningView = lazy(() =>
  import('./views/SecretScanning').then((m) => ({ default: m.SecretScanningView })),
);
const SecurityAlertsView = lazy(() =>
  import('./views/SecurityAlerts').then((m) => ({ default: m.SecurityAlertsView })),
);
const SearchView = lazy(() =>
  import('./views/Search').then((m) => ({ default: m.SearchView })),
);
const InboxView = lazy(() =>
  import('./views/Inbox').then((m) => ({ default: m.InboxView })),
);
const ReleasesView = lazy(() =>
  import('./views/Releases').then((m) => ({ default: m.ReleasesView })),
);
const MirrorsView = lazy(() =>
  import('./views/Mirrors').then((m) => ({ default: m.MirrorsView })),
);
const UsageView = lazy(() =>
  import('./views/Usage').then((m) => ({ default: m.UsageView })),
);
const OAuthAuthorizeView = lazy(() =>
  import('./views/OAuthAuthorize').then((m) => ({ default: m.OAuthAuthorizeView })),
);
const HomeView = lazy(() =>
  import('./views/Home').then((m) => ({ default: m.HomeView })),
);
const RepoOverviewView = lazy(() =>
  import('./views/RepoOverview').then((m) => ({ default: m.RepoOverviewView })),
);
const ChangesetView = lazy(() =>
  import('./views/ChangesetView').then((m) => ({ default: m.ChangesetView })),
);
const TreeView = lazy(() =>
  import('./views/TreeView').then((m) => ({ default: m.TreeView })),
);
const DiffExplorerView = lazy(() =>
  import('./views/DiffExplorer').then((m) => ({ default: m.DiffExplorerView })),
);
const AgentsView = lazy(() =>
  import('./views/Agents').then((m) => ({ default: m.AgentsView })),
);
const TaskDetailView = lazy(() =>
  import('./views/Agents').then((m) => ({ default: m.TaskDetailView })),
);
const SettingsView = lazy(() =>
  import('./views/Settings').then((m) => ({ default: m.SettingsView })),
);
const OrgSettingsView = lazy(() =>
  import('./views/OrgSettings').then((m) => ({ default: m.OrgSettingsView })),
);
const CiRunView = lazy(() =>
  import('./views/CiRun').then((m) => ({ default: m.CiRunView })),
);
const AuditView = lazy(() =>
  import('./views/Audit').then((m) => ({ default: m.AuditView })),
);
const SecretsView = lazy(() =>
  import('./views/Secrets').then((m) => ({ default: m.SecretsView })),
);
const SecurityView = lazy(() =>
  import('./views/Security').then((m) => ({ default: m.SecurityView })),
);
const SshKeysView = lazy(() =>
  import('./views/SshKeys').then((m) => ({ default: m.SshKeysView })),
);

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
              <Suspense fallback={<Loading />}>
                <Routes>
                  <Route path="/" element={<HomeView />} />
                  <Route path="/search" element={<SearchView />} />
                  <Route path="/inbox" element={<InboxView />} />
                  <Route path="/settings" element={<SettingsView />} />
                  <Route path="/security" element={<SecurityView />} />
                  <Route path="/ssh-keys" element={<SshKeysView />} />
                  <Route path="/orgs" element={<OrgSettingsView />} />
                  <Route path="/orgs/:org" element={<OrgSettingsView />} />
                  <Route path="/orgs/:org/runners" element={<RunnersView />} />
                  <Route path="/orgs/:org/imports" element={<ImportView />} />
                  <Route path="/orgs/:org/audit" element={<AuditView />} />
                  <Route path="/orgs/:org/secrets" element={<SecretsView />} />
                  <Route path="/r/:owner/:name/history" element={<HistoryView />} />
                  <Route path="/r/:owner/:name/issues" element={<IssuesView />} />
                  <Route path="/r/:owner/:name/issues/new" element={<NewIssueView />} />
                  <Route path="/r/:owner/:name/issues/:number" element={<IssueView />} />
                  <Route path="/r/:owner/:name/board" element={<BoardView />} />
                  <Route path="/r/:owner/:name/pulls" element={<PullsView />} />
                  <Route path="/r/:owner/:name/pulls/:id" element={<PullView />} />
                  <Route path="/r/:owner/:name/queue" element={<MergeQueueView />} />
                  <Route path="/r/:owner/:name/ci" element={<CiView />} />
                  <Route path="/r/:owner/:name/ci/runs/:id" element={<CiRunView />} />
                  <Route path="/r/:owner/:name/ci/access" element={<CiAccessView />} />
                  <Route path="/r/:owner/:name/ci/runners" element={<RunnersView />} />
                  <Route path="/r/:owner/:name/hooks" element={<WebhooksView />} />
                  <Route
                    path="/r/:owner/:name/secret-scanning"
                    element={<SecretScanningView />}
                  />
                  <Route
                    path="/r/:owner/:name/security-alerts"
                    element={<SecurityAlertsView />}
                  />
                  <Route path="/r/:owner/:name/releases" element={<ReleasesView />} />
                  <Route path="/r/:owner/:name/mirrors" element={<MirrorsView />} />
                  <Route path="/r/:owner/:name/usage" element={<UsageView />} />
                  <Route path="/orgs/:org/usage" element={<UsageView />} />
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
              </Suspense>
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
