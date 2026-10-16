import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, apiFetch, asApiError } from '../api';
import { call, type CiOverview, type PipelineRun } from '../collaboration';
import { useSlug } from '../slug';
import { ErrorNotice, Loading, formatRelative, shortId } from '../ui';
import { RepoNav, RunArtifacts } from './Collaboration';

/** States a run can still leave; its log is fetched again while in one. */
const ACTIVE = new Set(['queued', 'waiting', 'running']);
/** The log API returns the whole retained log; runs checkpoint it as they go. */
const POLL_MS = 2000;

interface RunSummary {
  label: string;
  state: string;
  head_cs: string;
  error: string | null;
  created_at: number;
}

/** The run from the CI overview, or the pipeline job that owns it. */
async function findRun(slug: string, id: string): Promise<RunSummary | null> {
  const [overview, pipelines] = await Promise.all([
    call<CiOverview>(`/repos/${slug}/ci`),
    call<{ runs: PipelineRun[] }>(`/repos/${slug}/ci/pipelines`),
  ]);
  const run = overview.runs.find((r) => r.id === id);
  if (run)
    return {
      label: run.publish ? 'Build and push' : 'Checks',
      state: run.state,
      head_cs: run.head_cs,
      error: run.error,
      created_at: run.created_at,
    };
  for (const pipeline of pipelines.runs) {
    const job = pipeline.jobs.find((j) => j.run_id === id);
    if (job)
      return {
        label: `${pipeline.name} / ${job.key}`,
        state: job.state,
        head_cs: pipeline.head_cs,
        error: job.error,
        created_at: pipeline.created_at,
      };
  }
  return null;
}

/**
 * One CI run (issue #47): its log, fetched again every two seconds while the
 * run is queued or running, and its artifacts (#51).
 */
export function CiRunView(): ReactElement {
  const slug = useSlug();
  const { id = '' } = useParams();
  const [run, setRun] = useState<RunSummary | null>(null);
  const [log, setLog] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [follow, setFollow] = useState(true);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async (): Promise<void> => {
      try {
        const [summary, res] = await Promise.all([
          findRun(slug, id),
          apiFetch(`/api/v1/repos/${slug}/ci/runs/${id}/log`),
        ]);
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: { code?: string; message?: string };
          };
          throw new ApiError(
            res.status,
            body.error?.code ?? 'request_failed',
            body.error?.message ?? 'Cannot load this log',
          );
        }
        const text = await res.text();
        if (cancelled) return;
        setRun(summary);
        setLog(text);
        setError(null);
        if (summary && ACTIVE.has(summary.state))
          timer = setTimeout(() => void load(), POLL_MS);
      } catch (err) {
        if (!cancelled) setError(asApiError(err));
      }
    };
    void load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [slug, id]);

  useEffect(() => {
    const pre = logRef.current;
    if (follow && pre) pre.scrollTop = pre.scrollHeight;
  }, [log, follow]);

  const live = run !== null && ACTIVE.has(run.state);
  return (
    <>
      <RepoNav active="CI" />
      <div className="row between">
        <h1>{run?.label ?? 'CI run'}</h1>
        <Link to={`/r/${slug}/ci`}>Back to runs</Link>
      </div>
      {error && <ErrorNotice error={error} />}
      {log === null && !error && <Loading />}
      {run && (
        <p className="muted">
          <span className={`ci-state state-${run.state}`}>
            {run.state.replace('_', ' ')}
          </span>{' '}
          · <Link to={`/r/${slug}/cs/${run.head_cs}`}>{shortId(run.head_cs)}</Link> ·{' '}
          {formatRelative(run.created_at)}
          {run.error && <> · {run.error}</>}
        </p>
      )}
      {log !== null && (
        <section aria-labelledby="ci-log-heading">
          <div className="row between">
            <h2 id="ci-log-heading">Log</h2>
            <label>
              <input
                type="checkbox"
                checked={follow}
                onChange={(e) => setFollow(e.target.checked)}
              />{' '}
              Follow the end of the log
            </label>
          </div>
          <p role="status" className="small muted">
            {live ? 'Live: refreshing every 2 seconds.' : 'This run has finished.'}
          </p>
          <pre
            ref={logRef}
            className="code build-log"
            tabIndex={0}
            aria-label="Build log"
          >
            {log || 'No output.'}
          </pre>
          <p className="small muted">
            Logs are limited to 512 KiB and retained for seven days.
          </p>
        </section>
      )}
      {log !== null && (
        <section aria-labelledby="ci-artifacts-heading">
          <h2 id="ci-artifacts-heading">Artifacts</h2>
          <RunArtifacts slug={slug} list={`/repos/${slug}/ci/runs/${id}/artifacts`} />
        </section>
      )}
    </>
  );
}
