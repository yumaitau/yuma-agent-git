import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  api,
  asApiError,
  GITHUB_INSTALL_URL,
  type ApiError,
  type ImportJob,
  type Repo,
} from '../api';
import { usePolling } from '../hooks';
import { useToast } from '../toast';
import {
  Chip,
  Empty,
  ErrorNotice,
  Field,
  Loading,
  StatusChip,
  formatRelative,
} from '../ui';

/** Live import-job progress card (polls the job endpoint every 2s). */
function ImportJobCard({ slug, jobId }: { slug: string; jobId: string }): ReactElement {
  const { data, error } = usePolling<ImportJob>(
    () => api.getImportJob(slug, jobId),
    2000,
    true,
  );
  if (error) return <ErrorNotice error={error} />;
  if (!data) return <Loading label="Loading job…" />;
  const total = data.commits_total ?? 0;
  const done = data.commits_done ?? 0;
  const pct =
    total > 0 ? Math.round((done / total) * 100) : data.status === 'done' ? 100 : 5;
  return (
    <div className="panel tight">
      <div className="row between">
        <span className="mono small">
          job {jobId} — {data.mode}
        </span>
        <StatusChip status={data.status} />
      </div>
      <div className="progress" style={{ margin: '8px 0' }}>
        <div style={{ width: `${pct}%` }} />
      </div>
      <div className="small muted">
        {total > 0 ? `${done} / ${total} commits` : `${done} commits`}
        {data.checkpoint ? ` · checkpoint ${data.checkpoint}` : ''}
      </div>
      {data.error && <div className="notice error small">{data.error}</div>}
    </div>
  );
}

interface WizardState {
  installationId: string;
  githubRepoId: string;
  source: string;
  mode: 'snapshot' | 'full_history';
  ref: string;
}

/**
 * "Connect GitHub repo" flow: install the App (link) → connect
 * (installation_id + github_repo_id) → import (mode picker) → live progress.
 */
function ConnectWizard({
  repos,
  onDone,
}: {
  repos: Repo[];
  onDone: () => void;
}): ReactElement {
  const toast = useToast();
  const [step, setStep] = useState<'connect' | 'import'>('connect');
  const [slug, setSlug] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<WizardState>({
    installationId: '',
    githubRepoId: '',
    source: '',
    mode: 'snapshot',
    ref: '',
  });
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const connect = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const installationId = Number(form.installationId);
      const githubRepoId = Number(form.githubRepoId);
      if (!Number.isInteger(installationId) || !Number.isInteger(githubRepoId)) {
        throw new Error('installation id and GitHub repo id must be numbers');
      }
      await api.connectRepo(slug, {
        installation_id: installationId,
        github_repo_id: githubRepoId,
      });
      toast.show(`connected ${slug} to GitHub`);
      if (form.source.trim() === '') {
        // default the source to the yag slug — the common owner/name case
        setForm((f) => ({ ...f, source: `github:${slug}` }));
      }
      setStep('import');
    } catch (err) {
      setError(asApiError(err));
    } finally {
      setBusy(false);
    }
  }, [form, slug, toast]);

  const startImport = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const started = await api.startImport(slug, {
        source: form.source.trim(),
        mode: form.mode,
        ref: form.ref.trim() === '' ? undefined : form.ref.trim(),
      });
      setJobId(started.job_id);
      onDone();
    } catch (err) {
      setError(asApiError(err));
    } finally {
      setBusy(false);
    }
  }, [form, slug, onDone]);

  return (
    <div className="panel">
      <h2>Import from GitHub</h2>
      <p className="muted">Optional migration into an existing Yuma repository.</p>
      <ol className="small muted" style={{ margin: '0 0 12px', paddingLeft: 20 }}>
        <li>
          <a href={GITHUB_INSTALL_URL}>Install the GitHub App</a> on your account/org,
          then come back here.
        </li>
        <li>Connect the installation to a repo below.</li>
        <li>Import history (snapshot or full).</li>
      </ol>

      {error && <ErrorNotice error={error} />}

      <div className="row" style={{ alignItems: 'flex-end' }}>
        <Field label="yag repo (owner/name)">
          <input
            type="text"
            list="wizard-repos"
            placeholder="acme/tools"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
          />
          <datalist id="wizard-repos">
            {repos.map((r) => (
              <option key={r.id} value={r.slug} />
            ))}
          </datalist>
        </Field>
        {step === 'connect' ? (
          <>
            <Field label="Installation id">
              <input
                type="text"
                value={form.installationId}
                onChange={(e) =>
                  setForm((f) => ({ ...f, installationId: e.target.value }))
                }
              />
            </Field>
            <Field label="GitHub repo id">
              <input
                type="text"
                value={form.githubRepoId}
                onChange={(e) => setForm((f) => ({ ...f, githubRepoId: e.target.value }))}
              />
            </Field>
            <button
              className="primary"
              disabled={busy || slug.trim() === ''}
              onClick={() => void connect()}
            >
              Connect
            </button>
          </>
        ) : (
          <>
            <Field label="Source">
              <input
                type="text"
                placeholder="github:owner/name"
                value={form.source}
                onChange={(e) => setForm((f) => ({ ...f, source: e.target.value }))}
              />
            </Field>
            <Field label="Mode">
              <select
                value={form.mode}
                onChange={(e) =>
                  setForm((f) => ({ ...f, mode: e.target.value as WizardState['mode'] }))
                }
              >
                <option value="snapshot">snapshot (latest tree only)</option>
                <option value="full_history">full history</option>
              </select>
            </Field>
            <Field label="Ref (optional)">
              <input
                type="text"
                placeholder="main"
                value={form.ref}
                onChange={(e) => setForm((f) => ({ ...f, ref: e.target.value }))}
              />
            </Field>
            <button
              className="primary"
              disabled={busy || slug.trim() === '' || form.source.trim() === ''}
              onClick={() => void startImport()}
            >
              Import
            </button>
          </>
        )}
      </div>
      {jobId && <ImportJobCard slug={slug} jobId={jobId} />}
    </div>
  );
}

/** New-repo form (POST /api/v1/repos). */
function NewRepoForm({ onCreated }: { onCreated: () => void }): ReactElement {
  const navigate = useNavigate();
  const toast = useToast();
  const [slug, setSlug] = useState('');
  const [visibility, setVisibility] = useState<'private' | 'public'>('private');
  const [branch, setBranch] = useState('main');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const create = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const repo = await api.createRepo({
        slug: slug.trim(),
        visibility,
        default_branch: branch.trim() === '' ? undefined : branch.trim(),
      });
      toast.show(`created ${repo.slug}`);
      setSlug('');
      onCreated();
      navigate(`/r/${repo.slug}`);
    } catch (err) {
      setError(asApiError(err));
    } finally {
      setBusy(false);
    }
  }, [slug, visibility, branch, toast, onCreated, navigate]);

  return (
    <div className="panel">
      <h2>Create repository</h2>
      <p className="muted">Your code, history, reviews and CI are hosted on Yuma.</p>
      {error && <ErrorNotice error={error} />}
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <Field label="Repository (owner/name)">
          <input
            type="text"
            placeholder="acme/tools"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
          />
        </Field>
        <Field label="Visibility">
          <select
            value={visibility}
            onChange={(e) => setVisibility(e.target.value as 'private' | 'public')}
          >
            <option value="private">private</option>
            <option value="public">public</option>
          </select>
        </Field>
        <Field label="Default branch">
          <input
            type="text"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            placeholder="main or release/name"
          />
        </Field>
        <button
          className="primary"
          disabled={
            busy ||
            !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(slug.trim()) ||
            !/^(main|release\/[a-z0-9._-]+)$/.test(branch.trim())
          }
          onClick={() => void create()}
        >
          {busy ? 'Creating…' : 'Create repository'}
        </button>
      </div>
    </div>
  );
}

export function HomeView(): ReactElement {
  const [searchParams, setSearchParams] = useSearchParams();
  const [filter, setFilter] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [showConnect, setShowConnect] = useState(searchParams.get('connect') === '1');
  const {
    data: repos,
    error,
    loading,
    refresh,
  } = usePolling<Repo[]>(api.listRepos, 30_000);

  useEffect(() => {
    if (searchParams.get('focus') === '1') {
      document.getElementById('repo-filter')?.focus();
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const visible = (repos ?? []).filter((r) =>
    r.slug.toLowerCase().includes(filter.trim().toLowerCase()),
  );

  return (
    <div>
      <div className="row between">
        <h1 style={{ margin: 0 }}>Repositories</h1>
        <div className="row">
          <input
            id="repo-filter"
            type="text"
            placeholder="Filter repos…  ( / )"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <button className="primary" onClick={() => setShowNew((v) => !v)}>
            New repository
          </button>
        </div>
      </div>
      <p className="muted">Host your code, review changes and run CI on Yuma.</p>

      {error && <ErrorNotice error={error} />}
      {showNew && <NewRepoForm onCreated={refresh} />}

      {loading && !repos ? (
        <Loading label="Loading repositories…" />
      ) : visible.length === 0 ? (
        <Empty>
          {repos && repos.length > 0
            ? 'No repos match the filter.'
            : 'Create your first repository to start working on Yuma.'}
        </Empty>
      ) : (
        visible.map((repo) => (
          <Link key={repo.id} to={`/r/${repo.slug}`} className="repo-card">
            <div className="row between">
              <span className="slug">{repo.slug}</span>
              <span className="row">
                <Chip kind={repo.visibility === 'public' ? 'ok' : 'default'}>
                  {repo.visibility}
                </Chip>
                <span className="small faint">default: {repo.default_branch}</span>
                <span className="small faint">{formatRelative(repo.created_at)}</span>
              </span>
            </div>
          </Link>
        ))
      )}
      <details
        open={showConnect}
        onToggle={(event) => setShowConnect(event.currentTarget.open)}
      >
        <summary>Import an existing repository (optional)</summary>
        {showConnect && <ConnectWizard repos={repos ?? []} onDone={refresh} />}
      </details>
    </div>
  );
}
