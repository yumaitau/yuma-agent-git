import { useEffect, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import { Link, useParams } from 'react-router-dom';
import { asApiError, type ApiError } from '../api';
import { call } from '../collaboration';
import { Chip, Empty, ErrorNotice, Field, formatRelative, Loading } from '../ui';

interface ImportJob {
  id: string;
  github_org: string;
  status: string;
  resume_at: number | null;
  error: string | null;
  created_at: number;
}

interface RepoReport {
  github: string;
  repo: string | null;
  status: string;
  phase: string;
  counts: Record<string, number>;
  warnings: Record<string, unknown>[];
  error: string | null;
}

interface Report extends ImportJob {
  totals: Record<string, number>;
  repos: RepoReport[];
}

const FINISHED = new Set(['done', 'partial', 'failed']);
const KIND: Record<string, 'ok' | 'warn' | 'danger' | 'info'> = {
  done: 'ok',
  partial: 'warn',
  rate_limited: 'warn',
  failed: 'danger',
};

/**
 * GitHub bulk import for an org (`/orgs/:org/imports`), issue #72: start an
 * import through the GitHub App installation, follow each repo's phase and
 * counts, and resume failed repos from their checkpoints.
 */
export function ImportView(): ReactElement {
  const { org = '' } = useParams();
  const base = `/orgs/${encodeURIComponent(org)}/imports`;
  const [jobs, setJobs] = useState<ImportJob[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [githubOrg, setGithubOrg] = useState('');
  const [installation, setInstallation] = useState('');
  const [repos, setRepos] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    call<{ imports: ImportJob[] }>(base)
      .then((r) => {
        if (cancelled) return;
        setJobs(r.imports);
        setSelected((s) => s ?? r.imports[0]?.id ?? null);
      })
      .catch((err) => !cancelled && setError(asApiError(err)));
    return () => {
      cancelled = true;
    };
  }, [base, nonce]);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = (): void => {
      call<{ import: Report }>(`${base}/${selected}`)
        .then((r) => {
          if (cancelled) return;
          setReport(r.import);
          if (!FINISHED.has(r.import.status)) timer = setTimeout(load, 5000);
        })
        .catch((err) => !cancelled && setError(asApiError(err)));
    };
    load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [base, selected, nonce]);

  const start = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    try {
      const names = repos
        .split(/[\s,]+/)
        .map((r) => r.trim())
        .filter(Boolean);
      const started = await call<{ import: ImportJob }>(base, 'POST', {
        source: 'github',
        github_org: githubOrg.trim(),
        installation_id: Number(installation),
        ...(names.length ? { repos: names } : {}),
      });
      setSelected(started.import.id);
      setNonce((n) => n + 1);
    } catch (err) {
      setError(asApiError(err));
    }
  };

  const resume = async (id: string): Promise<void> => {
    setError(null);
    try {
      await call(`${base}/${id}/resume`, 'POST');
      setNonce((n) => n + 1);
    } catch (err) {
      setError(asApiError(err));
    }
  };

  return (
    <>
      <div className="row between">
        <h1>Import from GitHub</h1>
        <Link to={`/orgs/${org}`}>Back to {org}</Link>
      </div>
      {error && <ErrorNotice error={error} />}

      <section className="panel">
        <h2>New import</h2>
        <p className="small muted">
          Install the GitHub App on the GitHub organisation first. History keeps its
          commit SHAs; issues, pull requests, reviews, releases and LFS objects follow.
          The App token is read-only.
        </p>
        <form onSubmit={(e) => void start(e)}>
          <Field label="GitHub organisation">
            <input
              value={githubOrg}
              onChange={(e) => setGithubOrg(e.target.value)}
              required
            />
          </Field>
          <Field label="App installation id">
            <input
              value={installation}
              inputMode="numeric"
              onChange={(e) => setInstallation(e.target.value)}
              required
            />
          </Field>
          <Field label="Only these repos (optional, comma separated)">
            <input value={repos} onChange={(e) => setRepos(e.target.value)} />
          </Field>
          <button className="primary" type="submit">
            Start import
          </button>
        </form>
      </section>

      <section className="panel">
        <h2>Imports</h2>
        {!jobs && !error && <Loading />}
        {jobs?.length === 0 && <Empty>No imports yet.</Empty>}
        {jobs && jobs.length > 0 && (
          <ul className="history-list">
            {jobs.map((j) => (
              <li key={j.id} className="row between">
                <button onClick={() => setSelected(j.id)}>
                  {j.github_org} · {formatRelative(j.created_at)}
                </button>
                <Chip kind={KIND[j.status] ?? 'info'}>{j.status}</Chip>
              </li>
            ))}
          </ul>
        )}
      </section>

      {report && (
        <section className="panel">
          <div className="row between">
            <h2>
              {report.github_org}{' '}
              <Chip kind={KIND[report.status] ?? 'info'}>{report.status}</Chip>
            </h2>
            {(report.status === 'partial' || report.status === 'failed') && (
              <button onClick={() => void resume(report.id)}>Resume failed repos</button>
            )}
          </div>
          {report.status === 'rate_limited' && report.resume_at && (
            <p className="small muted">
              Paused for the GitHub rate limit; resumes {formatRelative(report.resume_at)}
              .
            </p>
          )}
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>GitHub repo</th>
                  <th>Repo</th>
                  <th>Phase</th>
                  <th>Imported</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {report.repos.map((r) => (
                  <tr key={r.github}>
                    <td>{r.github}</td>
                    <td>{r.repo ? <Link to={`/r/${r.repo}`}>{r.repo}</Link> : '—'}</td>
                    <td>{r.phase}</td>
                    <td className="small">
                      {Object.entries(r.counts)
                        .map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`)
                        .join(', ')}
                      {r.warnings.length > 0 && ` · ${r.warnings.length} warnings`}
                    </td>
                    <td>
                      <Chip kind={KIND[r.status] ?? 'info'}>{r.status}</Chip>
                      {r.error && <div className="small muted">{r.error}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
