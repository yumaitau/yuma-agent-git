import { RepoNav } from './Collaboration';
import { useCallback, useState } from 'react';
import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import {
  api,
  asApiError,
  fastImportUrl,
  tarballUrl,
  type ApiError,
  type Changeset,
  type Ref,
} from '../api';
import { usePolling } from '../hooks';
import { useSlug } from '../slug';
import { useToast } from '../toast';
import {
  CopyButton,
  Empty,
  ErrorNotice,
  Field,
  Loading,
  formatRelative,
  shortId,
} from '../ui';

/** Move-ref form — CAS against the current head; `ref_stale` becomes a toast. */
function MoveRefForm({
  refs,
  onMoved,
}: {
  refs: Ref[];
  onMoved: () => void;
}): ReactElement {
  const slug = useSlug();
  const toast = useToast();
  const [name, setName] = useState(refs[0]?.name ?? 'main');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const current = refs.find((r) => r.name === name)?.head ?? null;

  const move = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await api.moveRef(slug, name, { from: current, to: to.trim() });
      toast.show(`ref ${name} moved to ${to.trim().slice(0, 8)}`);
      setTo('');
      onMoved();
    } catch (err) {
      toast.showError(err);
      setError(asApiError(err));
    } finally {
      setBusy(false);
    }
  }, [slug, name, current, to, toast, onMoved]);

  return (
    <div className="panel">
      <h3>Move ref (compare-and-swap)</h3>
      {error && error.code !== 'ref_stale' && <ErrorNotice error={error} />}
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <Field label="Ref">
          <select value={name} onChange={(e) => setName(e.target.value)}>
            {refs.map((r) => (
              <option key={r.name} value={r.name}>
                {r.name}
              </option>
            ))}
            {!refs.some((r) => r.name === name) && <option value={name}>{name}</option>}
          </select>
        </Field>
        <Field label={`New head (currently ${shortId(current)})`}>
          <input
            type="text"
            placeholder="changeset id"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </Field>
        <button
          disabled={busy || to.trim() === '' || current === null}
          onClick={() => void move()}
        >
          Move ref
        </button>
      </div>
      <div className="small faint" style={{ marginTop: 6 }}>
        The move only succeeds if the ref still points at {shortId(current)} — a
        concurrent update surfaces as a <code>ref_stale</code> toast with expected/actual
        heads.
      </div>
    </div>
  );
}

export function RepoOverviewView(): ReactElement {
  const slug = useSlug();
  const { data: metadata, error: repoError } = usePolling(
    () => api.getRepo(slug),
    30_000,
  );
  const branch = metadata?.repo.default_branch ?? 'main';
  const head = `ref:${branch}`;
  const [initializing, setInitializing] = useState(false);
  const [initError, setInitError] = useState<ApiError | null>(null);
  const {
    data: refs,
    error: refsError,
    loading: refsLoading,
    refresh: refreshRefs,
  } = usePolling<Ref[]>(() => api.listRefs(slug), 15_000);
  const {
    data: changesets,
    error: csError,
    loading: csLoading,
    refresh: refreshChangesets,
  } = usePolling<Changeset[]>(() => api.listChangesets(slug, { limit: 12 }), 15_000);

  const exportHead = refs?.find((r) => r.name === branch)?.head ?? head;
  const quote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
  const clone = `yag clone ${quote(slug)} ./project --api ${quote(window.location.origin)} --rev ${quote(head)}\ncd project\nyag status`;
  const curl = `# create a repo:read token in Settings, then:\ncurl -fsSL -H "Authorization: Bearer $YAG_TOKEN" "${window.location.origin}${fastImportUrl(slug, head, 'snapshot')}" -o ${slug.replace(/\//g, '-')}.fast-import\n# then, in an empty git repo:\ngit init git-export && cd git-export\ngit fast-import < ../${slug.replace(/\//g, '-')}.fast-import`;
  const initialize = async (): Promise<void> => {
    setInitializing(true);
    setInitError(null);
    try {
      await api.initializeRepo(slug);
      refreshRefs();
      refreshChangesets();
    } catch (err) {
      setInitError(asApiError(err));
    } finally {
      setInitializing(false);
    }
  };

  return (
    <div>
      <RepoNav active="Code" />
      <div className="row between">
        <h1 style={{ margin: 0 }} className="mono">
          {slug}
        </h1>
        <div className="row">
          <Link className="btn" to={`/r/${slug}/diff`}>
            Diff explorer
          </Link>
          <Link className="btn" to={`/r/${slug}/agents`}>
            Agents
          </Link>
          <Link className="btn" to={`/r/${slug}/tree/${encodeURIComponent(exportHead)}`}>
            Browse tree
          </Link>
        </div>
      </div>

      {repoError && <ErrorNotice error={repoError} />}
      {initError && <ErrorNotice error={initError} />}
      {metadata && refs && refs.length === 0 && metadata.can_admin && (
        <div className="panel">
          <h2>Start your repository</h2>
          <p>
            Create a README and the <code>{branch}</code> branch, then clone your code to
            start working.
          </p>
          <button
            className="primary"
            disabled={initializing}
            onClick={() => void initialize()}
          >
            {initializing ? 'Creating README…' : 'Create initial README'}
          </button>
        </div>
      )}
      {metadata && refs?.some((ref) => ref.name === branch) && (
        <div className="panel">
          <h2>Work on this repository</h2>
          <p>
            Install the <code>yag</code> CLI and load a token from{' '}
            <Link to="/settings">Settings</Link> into <code>YAG_TOKEN</code>.
          </p>
          <pre className="code">{clone}</pre>
          <CopyButton text={clone} label="Copy clone command" />
          <p>Commit your changes, open a pull request, and run checks with Yuma CI.</p>
          <Link className="btn primary" to={`/r/${slug}/ci`}>
            Set up Yuma CI
          </Link>
        </div>
      )}

      <h2>Refs</h2>
      {refsError && <ErrorNotice error={refsError} />}
      {refsLoading && !refs ? (
        <Loading />
      ) : refs && refs.length > 0 ? (
        <div className="panel tight">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Head</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {refs.map((r) => (
                <tr key={r.name} className="clickable">
                  <td className="mono">
                    <Link to={`/r/${slug}/cs/${r.head}`}>{r.name}</Link>
                  </td>
                  <td className="mono">
                    <Link to={`/r/${slug}/cs/${r.head}`}>{shortId(r.head)}</Link>
                  </td>
                  <td className="muted small">{formatRelative(r.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>No branches yet.</Empty>
      )}

      <h2>Latest changesets</h2>
      {csError && <ErrorNotice error={csError} />}
      {csLoading && !changesets ? (
        <Loading />
      ) : changesets && changesets.length > 0 ? (
        <div className="panel tight">
          <table>
            <thead>
              <tr>
                <th>Id</th>
                <th>Message</th>
                <th>Author</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {changesets.map((cs) => (
                <tr key={cs.id} className="clickable">
                  <td className="mono">
                    <Link to={`/r/${slug}/cs/${cs.id}`}>{shortId(cs.id)}</Link>
                  </td>
                  <td className="wrap-any">{cs.message.split('\n')[0]}</td>
                  <td className="muted small">
                    {'agent' in cs.author ? cs.author.agent : cs.author.name}
                  </td>
                  <td className="muted small">{formatRelative(cs.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>No changesets yet.</Empty>
      )}

      <details className="panel">
        <summary>Migration and export tools</summary>
        <div className="row">
          <a className="btn" href={tarballUrl(slug, head)} download>
            Download tarball
          </a>
          <Link className="btn" to="/?connect=1">
            Import from GitHub…
          </Link>
          {metadata?.repo.github_repo_id != null && <ExportGithubForm />}
        </div>
        <h3>Fast-import stream</h3>
        <div className="row">
          <CopyButton text={curl} label="Copy curl snippet" />
        </div>
        <pre className="code">{curl}</pre>
      </details>

      {refs && refs.length > 0 && <MoveRefForm refs={refs} onMoved={refreshRefs} />}
    </div>
  );
}

function ExportGithubForm(): ReactElement {
  const slug = useSlug();
  const toast = useToast();
  const [branch, setBranch] = useState('yag-sync');
  const [busy, setBusy] = useState(false);

  const run = useCallback(async () => {
    setBusy(true);
    try {
      const started = await api.exportToGithub(slug, { target_branch: branch.trim() });
      toast.show(`export to GitHub queued (job ${started.job_id})`);
    } catch (err) {
      toast.showError(err);
    } finally {
      setBusy(false);
    }
  }, [slug, branch, toast]);

  return (
    <span className="row">
      <input
        type="text"
        placeholder="target branch"
        value={branch}
        onChange={(e) => setBranch(e.target.value)}
      />
      <button disabled={busy || branch.trim() === ''} onClick={() => void run()}>
        Export to GitHub
      </button>
    </span>
  );
}
