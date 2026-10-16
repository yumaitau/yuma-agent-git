import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ApiError, asApiError, type Changeset, apiFetch } from '../api';
import {
  call,
  type CiOverview,
  type CiPolicy,
  type Detection,
  type MergeConflict,
  type MergeMethod,
  type PipelineJob,
  type PipelineRun,
  type Pull,
  type PullConflicts,
  type PullDetail,
  type ReviewRequest,
  type ReviewThread,
} from '../collaboration';
import { NewThread, ThreadCard, type Draft, type ThreadActions } from './ReviewThreads';
import { useSlug } from '../slug';
import {
  ErrorNotice,
  Field,
  Loading,
  Empty,
  shortId,
  formatRelative,
  authorLabel,
} from '../ui';
import { DiffView } from '../DiffView';
import { Markdown } from '../Markdown';
import { api } from '../api';
import type { DiffResult } from '../api';

function useRemote<T>(path: string): {
  data: T | null;
  error: ApiError | null;
  refresh: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    setData(null);
    setError(null);
    const load = async (): Promise<void> => {
      try {
        const result = await call<T>(path);
        if (!cancelled) {
          setData(result);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(asApiError(err));
      }
      if (!cancelled)
        timer = setTimeout(() => {
          if (document.hidden) timer = setTimeout(() => void load(), 10000);
          else void load();
        }, 10000);
    };
    void load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [path, nonce]);
  return { data, error, refresh };
}
export function RepoNav({ active }: { active: string }): ReactElement {
  const slug = useSlug();
  return (
    <>
      <Link className="small muted" to={`/r/${slug}`}>
        {slug}
      </Link>
      <nav className="repo-tabs" aria-label="Repository">
        {[
          ['Code', ''],
          ['History', '/history'],
          ['Issues', '/issues'],
          ['Pull requests', '/pulls'],
          ['CI', '/ci'],
        ].map(([name, tail]) => (
          <Link
            key={name}
            aria-current={active === name ? 'page' : undefined}
            to={`/r/${slug}${tail}`}
          >
            {name}
          </Link>
        ))}
      </nav>
    </>
  );
}
export function HistoryView(): ReactElement {
  const slug = useSlug();
  const [params, setParams] = useSearchParams();
  const cursor = params.get('cursor');
  const path = `/repos/${slug}/changesets?limit=30${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
  const { data, error } = useRemote<{
    changesets: Changeset[];
    next_cursor?: string | null;
  }>(path);
  return (
    <>
      <RepoNav active="History" />
      <h1>Commit history</h1>
      {error && <ErrorNotice error={error} />}
      {!data && !error && <Loading />}
      {data?.changesets.length === 0 && (
        <Empty>Create a commit or import a repository to start its history.</Empty>
      )}
      <ol className="history-list">
        {data?.changesets.map((cs) => (
          <li key={cs.id}>
            <Link to={`/r/${slug}/cs/${cs.id}`}>
              <strong>{cs.message.split('\n')[0]}</strong>
            </Link>
            <div className="small muted">
              {authorLabel(cs.author)} · {formatRelative(cs.created_at)} ·{' '}
              <code>{shortId(cs.id)}</code>
              {cs.parents.length > 1 ? ' · merge' : ''}
            </div>
            <Link className="small" to={`/r/${slug}/tree/${cs.id}`}>
              Browse files
            </Link>
          </li>
        ))}
      </ol>
      <div className="row">
        {cursor && <button onClick={() => setParams({})}>Latest commits</button>}
        {data?.next_cursor && (
          <button onClick={() => setParams({ cursor: data.next_cursor! })}>
            Older commits
          </button>
        )}
      </div>
    </>
  );
}
export function PullsView(): ReactElement {
  const slug = useSlug();
  const navigate = useNavigate();
  const { data, error } = useRemote<{ pulls: Pull[] }>(`/repos/${slug}/pulls`);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState('');
  const [head, setHead] = useState('');
  const [body, setBody] = useState('');
  const [draft, setDraft] = useState(false);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const submit = async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      const result = await call<{ pull: Pull }>(`/repos/${slug}/pulls`, 'POST', {
        title,
        head_cs: head.trim(),
        body,
        draft,
      });
      navigate(`/r/${slug}/pulls/${result.pull.id}`);
    } catch (err) {
      setFailure(asApiError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <RepoNav active="Pull requests" />
      <div className="row between">
        <h1>Pull requests</h1>
        <button className="primary" onClick={() => setCreating(!creating)}>
          New pull request
        </button>
      </div>
      {(failure || error) && <ErrorNotice error={(failure || error)!} />}
      {creating && (
        <form
          className="setup-flow stack"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <h2>Propose a change</h2>
          <Field label="Title">
            <input
              type="text"
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </Field>
          <Field label="Proposed changeset ID">
            <input
              type="text"
              required
              className="mono"
              value={head}
              onChange={(e) => setHead(e.target.value)}
              placeholder="Full changeset ID from yag commit"
            />
          </Field>
          <Field label="What changed and why?">
            <textarea value={body} onChange={(e) => setBody(e.target.value)} />
          </Field>
          <label>
            <input
              type="checkbox"
              checked={draft}
              onChange={(e) => setDraft(e.target.checked)}
            />{' '}
            Start as a draft
          </label>
          <button className="primary" disabled={busy}>
            {busy ? 'Creating…' : 'Create pull request'}
          </button>
        </form>
      )}
      {!data && !error && <Loading />}
      {data?.pulls.length === 0 && (
        <Empty>
          Review changes here before they reach the default branch. Create a changeset
          with <code>yag commit</code>, then open your first pull request.
        </Empty>
      )}
      <ul className="history-list">
        {data?.pulls.map((pull) => (
          <li key={pull.id}>
            <Link to={`/r/${slug}/pulls/${pull.id}`}>
              <strong>{pull.title}</strong>
            </Link>
            <div className="small muted">
              #{pull.number} · {pull.state} · {formatRelative(pull.updated_at)}
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
export function PullView(): ReactElement {
  const slug = useSlug();
  const { id } = useParams();
  const { data, error, refresh } = useRemote<PullDetail>(`/repos/${slug}/pulls/${id}`);
  const threads = useRemote<{ threads: ReviewThread[]; names: Record<string, string> }>(
    `/repos/${slug}/pulls/${id}/threads`,
  );
  const reviewers = useRemote<{
    review_requests: ReviewRequest[];
    names: Record<string, string>;
  }>(`/repos/${slug}/pulls/${id}/reviewers`);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [requested, setRequested] = useState('');
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [text, setText] = useState('');
  const [head, setHead] = useState('');
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [method, setMethod] = useState<MergeMethod | null>(null);
  const [conflicts, setConflicts] = useState<PullConflicts | null>(null);
  const base = data?.pull.base_cs;
  const tip = data?.pull.head_cs;
  const open = ['open', 'draft'].includes(data?.pull.state ?? '');
  const chosen = method ?? data?.gate.method ?? 'merge';
  useEffect(() => {
    let cancelled = false;
    setConflicts(null);
    if (open && tip)
      void call<PullConflicts>(`/repos/${slug}/pulls/${id}/conflicts`)
        .then((value) => {
          if (!cancelled) setConflicts(value);
        })
        .catch(() => {
          /* the merge gate still reports blockers */
        });
    return () => {
      cancelled = true;
    };
  }, [slug, id, open, tip, base]);
  useEffect(() => {
    let cancelled = false;
    setDiff(null);
    if (base && tip)
      void api
        .getDiff(slug, { from: base, to: tip, text: true, mode: 'merge-base' })
        .then((value) => {
          if (!cancelled) setDiff(value);
        })
        .catch((err) => {
          if (!cancelled) setFailure(asApiError(err));
        });
    return () => {
      cancelled = true;
    };
  }, [slug, base, tip]);
  const action = async (name: string, body: Record<string, unknown>): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      await call(`/repos/${slug}/pulls/${id}/${name}`, 'POST', {
        ...body,
        revision: data?.pull.revision,
      });
      setText('');
      refresh();
    } catch (err) {
      setFailure(asApiError(err));
    } finally {
      setBusy(false);
    }
  };
  const run: ThreadActions['run'] = async (path, method, body) => {
    setBusy(true);
    setFailure(null);
    try {
      await call(path, method, body);
      refresh();
      threads.refresh();
      reviewers.refresh();
      return true;
    } catch (err) {
      setFailure(asApiError(err));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const actions: ThreadActions | null = data
    ? {
        slug,
        pull: data.pull,
        names: { ...reviewers.data?.names, ...threads.data?.names },
        busy,
        run,
      }
    : null;
  const allThreads = threads.data?.threads ?? [];
  const check = async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      await call(`/repos/${slug}/ci/runs`, 'POST', { head: tip });
      refresh();
    } catch (err) {
      setFailure(asApiError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <RepoNav active="Pull requests" />
      {(failure || error) && <ErrorNotice error={(failure || error)!} />}
      {!data && !error && <Loading />}
      {data && (
        <>
          <h1>
            {data.pull.title} <span className="muted">#{data.pull.number}</span>
          </h1>
          <p className="muted">
            {data.pull.state}
            {data.pull.merge_method ? ` (${data.pull.merge_method})` : ''} ·{' '}
            <code>{shortId(tip)}</code> into <code>{data.pull.base_ref}</code>
          </p>
          <Markdown source={data.pull.body} slug={slug} />
          {['open', 'draft'].includes(data.pull.state) && (
            <section className="merge-gate" aria-label="Merge requirements">
              <h2>Ready to merge?</h2>
              {data.gate.reasons.length ? (
                <ul>
                  {data.gate.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              ) : (
                <p>Reviews and checks are satisfied for this revision.</p>
              )}
              {conflicts && !conflicts.mergeable && (
                <ConflictView conflicts={conflicts} baseRef={data.pull.base_ref} />
              )}
              <div className="row">
                <select
                  aria-label="Merge method"
                  value={chosen}
                  onChange={(e) => setMethod(e.target.value as MergeMethod)}
                >
                  {data.gate.methods.map((m) => (
                    <option key={m} value={m}>
                      {METHOD_LABELS[m]}
                    </option>
                  ))}
                </select>
                <button
                  disabled={
                    busy ||
                    !data.gate.mergeable ||
                    conflicts?.mergeable === false ||
                    !data.gate.methods.includes(chosen)
                  }
                  className="primary"
                  onClick={() => void action('merge', { head_cs: tip, method: chosen })}
                >
                  {METHOD_LABELS[chosen]}
                </button>
                {conflicts && conflicts.target_cs !== data.pull.base_cs && (
                  <>
                    <button
                      disabled={busy || !conflicts.mergeable}
                      onClick={() =>
                        void action('update-branch', { head_cs: tip, method: 'merge' })
                      }
                    >
                      Update branch
                    </button>
                    <button
                      disabled={busy || !conflicts.mergeable}
                      onClick={() =>
                        void action('update-branch', { head_cs: tip, method: 'rebase' })
                      }
                    >
                      Update with rebase
                    </button>
                  </>
                )}
                <button disabled={busy} onClick={() => void check()}>
                  Run checks
                </button>
                <Link to={`/r/${slug}/ci`}>View CI</Link>
                {data.pull.state === 'draft' && (
                  <button
                    disabled={busy}
                    onClick={() => void action('update', { state: 'open' })}
                  >
                    Mark ready for review
                  </button>
                )}
                <button
                  disabled={busy}
                  onClick={() => void action('update', { state: 'closed' })}
                >
                  Close
                </button>
              </div>
              <details>
                <summary>Update the proposed revision</summary>
                <p className="small muted">
                  Use this to submit a conflict resolution: a changeset whose parents are
                  this revision and the target head. Changing the head requires fresh
                  approvals and checks.
                </p>
                <div className="row">
                  <input
                    type="text"
                    aria-label="New changeset ID"
                    value={head}
                    onChange={(e) => setHead(e.target.value)}
                  />
                  <button
                    disabled={busy || !/^[a-f0-9]{64}$/.test(head)}
                    onClick={() => void action('update', { head_cs: head })}
                  >
                    Update revision
                  </button>
                </div>
              </details>
            </section>
          )}
          <section aria-label="Reviewers">
            <h2>Reviewers</h2>
            <ul>
              {reviewers.data?.review_requests.map((r) => (
                <li key={r.principal}>
                  {actions?.names[r.principal] ?? r.principal}{' '}
                  <span className="small muted">{r.state}</span>
                </li>
              ))}
            </ul>
            {open && (
              <form
                className="row"
                onSubmit={(e) => {
                  e.preventDefault();
                  const current =
                    reviewers.data?.review_requests.map((r) => r.principal) ?? [];
                  const added = requested
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean);
                  void run(`/repos/${slug}/pulls/${id}/reviewers`, 'PUT', {
                    reviewers: [...current, ...added],
                  }).then((ok) => ok && setRequested(''));
                }}
              >
                <input
                  type="text"
                  aria-label="Request reviewers"
                  placeholder="login, team:<id> or agent:<id>"
                  value={requested}
                  onChange={(e) => setRequested(e.target.value)}
                />
                <button disabled={busy || !requested.trim()}>Request review</button>
              </form>
            )}
          </section>
          {tip && <PipelineRuns slug={slug} head={tip} />}
          <h2>Changes</h2>
          {diff ? (
            <DiffView
              files={diff.files}
              texts={diff.texts}
              review={(file) =>
                !actions || file.side === 'from'
                  ? undefined
                  : {
                      onLine: (anchor) =>
                        open && setDraft({ path: file.path, ...anchor }),
                      below: (anchor) => (
                        <>
                          {allThreads
                            .filter(
                              (t) =>
                                !t.outdated &&
                                t.path === file.path &&
                                t.side === anchor.side &&
                                t.end_line === anchor.line,
                            )
                            .map((t) => (
                              <ThreadCard key={t.id} thread={t} actions={actions} />
                            ))}
                          {draft?.path === file.path &&
                            draft.side === anchor.side &&
                            draft.line === anchor.line && (
                              <NewThread
                                draft={draft}
                                actions={actions}
                                onClose={() => setDraft(null)}
                              />
                            )}
                        </>
                      ),
                    }
              }
            />
          ) : (
            <Loading label="Loading diff…" />
          )}
          <h2>
            Review threads{' '}
            <span className="small muted">
              {allThreads.filter((t) => !t.resolved_at).length} unresolved
            </span>
          </h2>
          {actions &&
            allThreads.map((t) => <ThreadCard key={t.id} thread={t} actions={actions} />)}
          <h2>Review</h2>
          <ol className="history-list">
            {data.reviews.map((review) => (
              <li key={review.id}>
                <strong>{review.decision.replace('_', ' ')}</strong>{' '}
                <span className="small muted">
                  {formatRelative(review.created_at)}
                  {review.revision !== data.pull.revision ? ' · previous revision' : ''}
                </span>
                <p className="preserve-lines">{review.body}</p>
              </li>
            ))}
          </ol>
          {['open', 'draft'].includes(data.pull.state) && (
            <form
              className="stack"
              onSubmit={(e) => {
                e.preventDefault();
                void action('review', { decision: 'comment', body: text, head_cs: tip });
              }}
            >
              <Field label="Review comment">
                <textarea value={text} onChange={(e) => setText(e.target.value)} />
              </Field>
              <div className="row">
                <button disabled={busy}>Comment</button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void action('review', {
                      decision: 'approve',
                      body: text,
                      head_cs: tip,
                    })
                  }
                >
                  Approve
                </button>
                <button
                  type="button"
                  disabled={busy || !text.trim()}
                  onClick={() =>
                    void action('review', {
                      decision: 'request_changes',
                      body: text,
                      head_cs: tip,
                    })
                  }
                >
                  Request changes
                </button>
              </div>
            </form>
          )}
        </>
      )}
    </>
  );
}

const METHOD_LABELS: Record<MergeMethod, string> = {
  merge: 'Create a merge commit',
  squash: 'Squash and merge',
  rebase: 'Rebase and merge',
};

const CONFLICT_LABELS: Record<MergeConflict['kind'], string> = {
  content: 'both changed the same lines',
  add_add: 'both added different files',
  modify_delete: 'changed on one side, deleted on the other',
  file_directory: 'a file on one side, a directory on the other',
  mode: 'both changed the file mode',
  binary: 'binary file changed on both sides',
  too_large: 'too large to merge on the server',
  unsupported: 'entry type the server cannot merge',
  multiple_merge_bases: 'histories cross-merged; no single merge base',
};

/** Server-side conflict report (#42): paths, then base / target / proposed hunks. */
function ConflictView({
  conflicts,
  baseRef,
}: {
  conflicts: PullConflicts;
  baseRef: string;
}): ReactElement {
  return (
    <div className="stack" aria-label="Merge conflicts">
      <h3>Conflicts with {baseRef}</h3>
      <p className="small muted">
        Commit a resolution with parents [this revision,{' '}
        <code>{shortId(conflicts.target_cs)}</code>], then update the proposed revision.
      </p>
      {conflicts.conflicts.map((c) => (
        <details key={`${c.path}:${c.kind}`}>
          <summary>
            <code>{c.path || '(repository)'}</code>{' '}
            <span className="small muted">{CONFLICT_LABELS[c.kind]}</span>
          </summary>
          {c.hunks?.map((h, i) => (
            <div key={i} className="row">
              {(
                [
                  ['Base', h.base],
                  [baseRef, h.ours],
                  ['This pull request', h.theirs],
                ] as const
              ).map(([label, side]) => (
                <figure key={label} className="stack">
                  <figcaption className="small muted">
                    {label}, line {side.start}
                  </figcaption>
                  <pre className="mono small">{side.lines.join('')}</pre>
                </figure>
              ))}
            </div>
          ))}
        </details>
      ))}
    </div>
  );
}

/** Columns of the job graph: a job sits one stage after the deepest job it needs. */
function stages(jobs: PipelineJob[]): PipelineJob[][] {
  const depth = new Map<string, number>();
  const of = (name: string): number => {
    const known = depth.get(name);
    if (known !== undefined) return known;
    const needs = jobs.find((j) => j.job === name)?.needs ?? [];
    const value = needs.length ? 1 + Math.max(...needs.map(of)) : 0;
    depth.set(name, value);
    return value;
  };
  const out: PipelineJob[][] = [];
  for (const job of jobs) (out[of(job.job)] ??= []).push(job);
  return out;
}

/** Pipeline spec v2 runs with their job graph; nothing when there are none. */
export function PipelineRuns({
  slug,
  head,
  canWrite = false,
  onLog,
}: {
  slug: string;
  head?: string;
  canWrite?: boolean;
  onLog?: (runId: string) => void;
}): ReactElement | null {
  const { data, error, refresh } = useRemote<{ runs: PipelineRun[] }>(
    `/repos/${slug}/ci/pipelines${head ? `?head=${head}` : ''}`,
  );
  const [failure, setFailure] = useState<ApiError | null>(null);
  if (error) return <ErrorNotice error={error} />;
  if (!data?.runs.length) return null;
  const cancel = async (id: string): Promise<void> => {
    try {
      await call(`/repos/${slug}/ci/pipelines/runs/${id}/cancel`, 'POST', {});
      refresh();
    } catch (err) {
      setFailure(asApiError(err));
    }
  };
  return (
    <section aria-label="Pipeline runs">
      <h2>Pipelines</h2>
      {failure && <ErrorNotice error={failure} />}
      {data.runs.map((r) => (
        <article key={r.id} className="pipeline-run">
          <div className="row between">
            <div>
              <strong>{r.name}</strong>{' '}
              <span className={`ci-state state-${r.state}`}>{r.state}</span>
              <div className="small muted">
                {r.event.replace('_', ' ')} · {r.ref ?? 'revision'} ·{' '}
                <code>{shortId(r.head_cs)}</code> · {formatRelative(r.created_at)}
              </div>
            </div>
            {canWrite && r.state === 'running' && (
              <button onClick={() => void cancel(r.id)}>Cancel</button>
            )}
          </div>
          {r.errors ? (
            <ul aria-label={`${r.pipeline} errors`}>
              {r.errors.map((e) => (
                <li key={`${e.line}:${e.column}:${e.message}`}>
                  <code>
                    {r.pipeline}:{e.line}:{e.column}
                  </code>{' '}
                  {e.message}
                </li>
              ))}
            </ul>
          ) : (
            <div className="job-graph" aria-label={`${r.name} job graph`}>
              {stages(r.jobs).map((stage, i) => (
                <ol key={i} className="job-stage">
                  {stage.map((j) => (
                    <li key={j.key} className="job-node">
                      <strong>{j.key}</strong>
                      <span className={`ci-state state-${j.state}`}>
                        {j.state.replace('_', ' ')}
                      </span>
                      {j.needs.length > 0 && (
                        <span className="small muted">needs {j.needs.join(', ')}</span>
                      )}
                      {j.error && <span className="small">{j.error}</span>}
                      {j.state === 'waiting' &&
                        ['pending', 'approved'].includes(j.approval?.state ?? '') && (
                          <span className="small">
                            {j.approval!.state === 'pending'
                              ? `Waiting for approval to deploy to ${j.environment}`
                              : `Approved for ${j.environment}; waiting for its timer or a runner`}
                          </span>
                        )}
                      {onLog && j.run_id && (
                        <button onClick={() => onLog(j.run_id!)}>Log</button>
                      )}
                    </li>
                  ))}
                </ol>
              ))}
            </div>
          )}
        </article>
      ))}
    </section>
  );
}

const WAITING =
  'This run is waiting for environment approval. Reviewers can approve it under Secrets and environments.';
export function CiView(): ReactElement {
  const slug = useSlug();
  const path = `/repos/${slug}/ci`;
  const { data, error, refresh } = useRemote<CiOverview>(path);
  const [edit, setEdit] = useState(false);
  const [commands, setCommands] = useState('');
  const [preset, setPreset] = useState<CiPolicy['preset']>('node');
  const [minutes, setMinutes] = useState(5);
  const [approvals, setApprovals] = useState(1);
  const [requireChecks, setRequireChecks] = useState(true);
  const [protectDefault, setProtectDefault] = useState(true);
  const [image, setImage] = useState('');
  const [dockerfile, setDockerfile] = useState('Dockerfile');
  const [environment, setEnvironment] = useState('');
  const [secretNames, setSecretNames] = useState('');
  const [idToken, setIdToken] = useState(false);
  const [awsRole, setAwsRole] = useState('');
  const [awsRegion, setAwsRegion] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [log, setLog] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const config = data?.config;
  useEffect(() => {
    let cancelled = false;
    if (!data) return;
    if (config) {
      setCommands(config.commands.join('\n'));
      setPreset(config.preset);
      setMinutes(config.timeout_seconds / 60);
      setApprovals(config.required_approvals);
      setRequireChecks(config.require_checks);
      setProtectDefault(config.protect_default);
      setImage(config.image ?? '');
      setDockerfile(config.dockerfile);
      setEnvironment(config.environment ?? '');
      setSecretNames((config.secrets ?? []).join(', '));
      setIdToken(config.permissions?.id_token === 'write');
      setAwsRole(config.aws?.role_arn ?? '');
      setAwsRegion(config.aws?.region ?? '');
    } else if (data.can_admin)
      void call<Detection>(`${path}/detect`)
        .then((d) => {
          if (!cancelled) {
            setCommands(d.commands.join('\n'));
            setPreset(d.preset);
            if (d.empty)
              setNotice('Add a commit or import your repository before starting a run.');
          }
        })
        .catch((err) => {
          if (!cancelled) setFailure(asApiError(err));
        });
    return () => {
      cancelled = true;
    };
  }, [data?.version, slug]); // Configuration refresh must not overwrite an in-progress form.
  const task = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setFailure(null);
    setNotice('');
    try {
      await fn();
    } catch (err) {
      setFailure(asApiError(err));
    } finally {
      setBusy(false);
    }
  };
  const showLog = (id: string): Promise<void> =>
    task(async () => {
      const res = await apiFetch(`/api/v1${path}/runs/${id}/log`);
      if (!res.ok) throw new Error('Cannot load this log');
      setLog(await res.text());
    });
  const save = async (start: boolean): Promise<void> =>
    task(async () => {
      await call(path, 'PUT', {
        preset,
        commands: commands.split('\n').filter((v) => v.trim()),
        timeout_seconds: minutes * 60,
        required_approvals: approvals,
        require_checks: requireChecks,
        protect_default: protectDefault,
        dockerfile,
        image: image.trim() || null,
        environment: environment.trim() || null,
        secrets: secretNames
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        permissions: { id_token: idToken ? 'write' : 'none' },
        aws:
          idToken && awsRole.trim()
            ? {
                role_arn: awsRole.trim(),
                region: awsRegion.trim(),
                ...(config?.aws?.session_name
                  ? { session_name: config.aws.session_name }
                  : {}),
              }
            : null,
      });
      setEdit(false);
      setNotice('CI configuration saved.');
      refresh();
      if (start) {
        const started = await call<{ approval?: unknown }>(`${path}/runs`, 'POST', {});
        setNotice(started.approval ? WAITING : 'Your first run is queued.');
        refresh();
      }
    });
  return (
    <>
      <RepoNav active="CI" />
      <div className="row between">
        <h1>Continuous integration</h1>
        <div className="row">
          <Link to={`/r/${slug}/ci/access`}>Secrets and environments</Link>
          {config && data?.can_admin && (
            <button onClick={() => setEdit(!edit)}>
              {edit ? 'Close setup' : 'Edit pipeline'}
            </button>
          )}
        </div>
      </div>
      {(failure || error) && <ErrorNotice error={(failure || error)!} />}{' '}
      {notice && <p role="status">{notice}</p>}
      {!data && !error && <Loading />}
      {data && !data.enabled && (
        <div className="setup-note">
          Runner deployment is pending. You can save your pipeline now. An administrator
          must enable Cloudflare execution before jobs can run.
        </div>
      )}
      {data && !config && !data.can_admin && (
        <Empty>
          A repository administrator can set up the pipeline. Once configured, writers can
          run checks here.
        </Empty>
      )}
      {data?.can_admin && (!config || edit) && (
        <form
          className="setup-flow"
          onSubmit={(e) => {
            e.preventDefault();
            void save(data.enabled);
          }}
        >
          <div className="step-label">1 / Project checks</div>
          <h2>A small pipeline. A predictable limit.</h2>
          <p className="muted">
            We detected{' '}
            {preset === 'node'
              ? 'a Node.js project'
              : preset === 'docker'
                ? 'a Dockerfile'
                : 'a custom project'}
            . Each line runs in order in a fresh Linux container.
          </p>
          <Field label="Commands">
            <textarea
              className="mono"
              rows={6}
              value={commands}
              onChange={(e) => setCommands(e.target.value)}
              required
            />
          </Field>
          <div className="step-label">2 / Optional container publishing</div>
          <Field label="Image destination">
            <input
              type="text"
              placeholder="ghcr.io/team/project"
              value={image}
              onChange={(e) => setImage(e.target.value)}
            />
          </Field>
          <p className="small muted">
            Leave blank for checks only. Publishing is a separate admin action from the
            default branch, after checks pass.{' '}
            {data.registry
              ? `Registry: ${data.registry}.`
              : 'Registry credentials have not been configured.'}
          </p>
          {image && (
            <Field label="Dockerfile">
              <input
                type="text"
                value={dockerfile}
                onChange={(e) => setDockerfile(e.target.value)}
              />
            </Field>
          )}
          <div className="step-label">3 / Deployment access</div>
          <p className="small muted">
            Jobs get no credentials unless you ask. Secrets and OIDC tokens are never
            given to pull requests from forks or from authors without write access.{' '}
            <Link to={`/r/${slug}/ci/access`}>Manage secrets and environments</Link>.
          </p>
          <div className="row">
            <Field label="Environment">
              <input
                type="text"
                placeholder="production"
                value={environment}
                onChange={(e) => setEnvironment(e.target.value)}
              />
            </Field>
            <Field label="Secrets (names, comma separated)">
              <input
                type="text"
                placeholder="NPM_TOKEN"
                value={secretNames}
                onChange={(e) => setSecretNames(e.target.value)}
              />
            </Field>
          </div>
          <label>
            <input
              type="checkbox"
              checked={idToken}
              onChange={(e) => setIdToken(e.target.checked)}
            />{' '}
            Allow OIDC ID tokens (cloud access without stored keys)
          </label>
          {idToken && (
            <div className="row">
              <Field label="AWS role ARN (optional)">
                <input
                  type="text"
                  placeholder="arn:aws:iam::123456789012:role/deploy"
                  value={awsRole}
                  onChange={(e) => setAwsRole(e.target.value)}
                />
              </Field>
              <Field label="AWS region">
                <input
                  type="text"
                  placeholder="ap-southeast-2"
                  value={awsRegion}
                  onChange={(e) => setAwsRegion(e.target.value)}
                />
              </Field>
            </div>
          )}
          <div className="step-label">4 / Cost and review limits</div>
          <div className="row">
            <Field label="Maximum run time (minutes)">
              <input
                type="number"
                min={1}
                max={10}
                value={minutes}
                onChange={(e) => setMinutes(Number(e.target.value))}
              />
            </Field>
            <Field label="Required approvals">
              <select
                value={approvals}
                onChange={(e) => setApprovals(Number(e.target.value))}
              >
                <option value={0}>Just me (0)</option>
                <option value={1}>One teammate</option>
                <option value={2}>Two teammates</option>
                {[3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {n} teammates
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="stack">
            <label>
              <input
                type="checkbox"
                checked={requireChecks}
                onChange={(e) => setRequireChecks(e.target.checked)}
              />{' '}
              Require passing checks before merge
            </label>
            <label>
              <input
                type="checkbox"
                checked={protectDefault}
                onChange={(e) => setProtectDefault(e.target.checked)}
              />{' '}
              Protect the default branch from direct updates
            </label>
            <span className="small muted">
              Saving writes these three choices to the &quot;CI policy (default
              branch)&quot; ruleset. Manage it and other rulesets in Settings.
            </span>
          </div>
          <p className="cost-note">
            Reserves up to <strong>${((minutes * 60 + 30) * 0.000036).toFixed(3)}</strong>{' '}
            of the shared <strong>${data.monthly_budget_usd.toFixed(2)}/month</strong>{' '}
            compute budget per run. Storage, networking, and the Cloudflare plan are
            additional. Two admitted runs maximum.
          </p>
          <div className="row">
            <button className="primary" disabled={busy || !commands.trim()}>
              {busy ? 'Saving…' : data.enabled ? 'Save and run checks' : 'Save pipeline'}
            </button>
            <Link to={`/r/${slug}/history`}>Browse source history</Link>
          </div>
        </form>
      )}
      {data && config && !edit && (
        <>
          <div className="row between">
            <p className="muted">
              {config.timeout_seconds / 60} min limit · ${data.reserved_usd.toFixed(3)}{' '}
              reserved by this repository this month
            </p>
            <div className="row">
              <button
                className="primary"
                disabled={busy || !data.enabled || !data.can_write}
                onClick={() =>
                  void task(async () => {
                    const started = await call<{ approval?: unknown }>(
                      `${path}/runs`,
                      'POST',
                      {},
                    );
                    if (started.approval) setNotice(WAITING);
                    refresh();
                  })
                }
              >
                Run checks
              </button>
              {config.image && (
                <button
                  disabled={busy || !data.enabled || !data.registry || !data.can_admin}
                  onClick={() =>
                    void task(async () => {
                      await call(`${path}/runs`, 'POST', { publish: true });
                      refresh();
                    })
                  }
                >
                  Build &amp; push image
                </button>
              )}
            </div>
          </div>
          {data.runs.length === 0 ? (
            <Empty>
              Your pipeline is ready. Run checks to validate the latest default-branch
              revision.
            </Empty>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Run</th>
                    <th>Revision</th>
                    <th>Status</th>
                    <th>Started</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {data.runs.map((job) => (
                    <tr key={job.id}>
                      <td className="small">
                        {job.publish ? 'Build & push' : 'Checks'}
                        {job.image && <div className="mono wrap-any">{job.image}</div>}
                      </td>
                      <td>
                        <Link to={`/r/${slug}/cs/${job.head_cs}`} className="mono">
                          {shortId(job.head_cs)}
                        </Link>
                      </td>
                      <td>
                        <span className={`ci-state state-${job.state}`}>
                          {job.state.replace('_', ' ')}
                        </span>
                        {job.error && <div className="small">{job.error}</div>}
                      </td>
                      <td className="small muted">{formatRelative(job.created_at)}</td>
                      <td>
                        <div className="row">
                          <button onClick={() => void showLog(job.id)}>Log</button>
                          {['queued', 'running'].includes(job.state) ? (
                            <button
                              disabled={busy || !data.can_write}
                              onClick={() =>
                                void task(async () => {
                                  await call(`${path}/runs/${job.id}/cancel`, 'POST', {});
                                  refresh();
                                })
                              }
                            >
                              Cancel
                            </button>
                          ) : (
                            <button
                              disabled={busy || !data.enabled || !data.can_write}
                              onClick={() =>
                                void task(async () => {
                                  // the server reuses the run's trigger (ref, event, pull)
                                  const started = await call<{ approval?: unknown }>(
                                    `${path}/runs/${job.id}/retry`,
                                    'POST',
                                    {},
                                  );
                                  if (started.approval) setNotice(WAITING);
                                  refresh();
                                })
                              }
                            >
                              Retry
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      <PipelineRuns
        slug={slug}
        canWrite={data?.can_write}
        onLog={(id) => void showLog(id)}
      />
      {log !== null && (
        <section>
          <div className="row between">
            <h2>Build log</h2>
            <button onClick={() => setLog(null)}>Close log</button>
          </div>
          <pre className="code build-log">{log || 'No output.'}</pre>
          <p className="small muted">
            Logs are limited to 512 KiB and retained for seven days.
          </p>
        </section>
      )}
    </>
  );
}
