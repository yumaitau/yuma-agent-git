import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { Link, useParams } from 'react-router-dom';
import { asApiError, type ApiError } from '../api';
import { call } from '../collaboration';
import { Chip, Empty, ErrorNotice, formatRelative, Loading, SecretBox } from '../ui';
import { RepoNav } from './Collaboration';

interface Runner {
  id: string;
  name: string;
  labels: string[];
  capabilities: Record<string, string>;
  ephemeral: boolean;
  trusted_only: boolean;
  disabled: boolean;
  last_seen_at: number | null;
}

/** A runner long-polls every 30 seconds; a minute of silence means it is offline. */
const ONLINE_MS = 60_000;

/**
 * Self-hosted runners of an org (`/orgs/:org/runners`) or a repo
 * (`/r/:owner/:name/ci/runners`), issue #48: register with a one-time token,
 * disable, mark trusted-only, or revoke.
 */
export function RunnersView(): ReactElement {
  const { org, owner, name } = useParams();
  const repo = org ? null : `${owner ?? ''}/${name ?? ''}`;
  const base = org ? `/orgs/${org}` : `/repos/${repo}`;
  const [runners, setRunners] = useState<Runner[] | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [trustedOnly, setTrustedOnly] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    call<{ runners: Runner[] }>(`${base}/runners`)
      .then((r) => !cancelled && setRunners(r.runners))
      .catch((err) => !cancelled && setError(asApiError(err)));
    return () => {
      cancelled = true;
    };
  }, [base, nonce]);

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setError(null);
    try {
      await fn();
      refresh();
    } catch (err) {
      setError(asApiError(err));
    }
  };

  const mint = (): Promise<void> =>
    act(async () => {
      const minted = await call<{ token: string }>(
        `${base}/runners/registration-token`,
        'POST',
        { trusted_only: trustedOnly },
      );
      setToken(minted.token);
    });

  return (
    <>
      {repo && <RepoNav active="CI" />}
      <div className="row between">
        <h1>Self-hosted runners</h1>
        {repo ? (
          <Link to={`/r/${repo}/ci`}>Back to runs</Link>
        ) : (
          <Link to={`/orgs/${org}`}>Back to {org}</Link>
        )}
      </div>
      {error && <ErrorNotice error={error} />}

      <section className="panel">
        <h2>Add a runner</h2>
        <p className="small muted">
          A registration token works once and expires in an hour. Jobs whose{' '}
          <code>runs-on</code> labels are all on a runner run there; jobs without{' '}
          <code>runs-on</code> stay on the built-in Cloudflare pool.
        </p>
        <label className="row">
          <input
            type="checkbox"
            checked={trustedOnly}
            onChange={(e) => setTrustedOnly(e.target.checked)}
          />
          Trusted only: never run jobs from public repositories or forks
        </label>
        <button className="primary" onClick={() => void mint()}>
          Create registration token
        </button>
        {token && (
          <>
            <SecretBox secret={token} />
            <pre className="small wrap-any">
              {`YAG_RUNNER_TOKEN=${token} npm start -w yag-runner -- register \\\n  --url ${window.location.origin} --name <name> --labels linux,x64\nnpm start -w yag-runner -- run`}
            </pre>
          </>
        )}
      </section>

      <section className="panel">
        <h2>Runners</h2>
        {!runners && !error && <Loading />}
        {runners?.length === 0 && <Empty>No self-hosted runners yet.</Empty>}
        {runners && runners.length > 0 && (
          <ul className="history-list">
            {runners.map((r) => {
              const online =
                r.last_seen_at !== null && Date.now() - r.last_seen_at < ONLINE_MS;
              return (
                <li key={r.id} className="row between">
                  <span>
                    <strong>{r.name}</strong>{' '}
                    {r.labels.map((l) => (
                      <Chip key={l}>{l}</Chip>
                    ))}{' '}
                    <Chip kind={r.disabled ? 'danger' : online ? 'ok' : 'warn'}>
                      {r.disabled ? 'disabled' : online ? 'online' : 'offline'}
                    </Chip>{' '}
                    {r.ephemeral && <Chip kind="info">ephemeral</Chip>}{' '}
                    {r.trusted_only && <Chip kind="info">trusted only</Chip>}{' '}
                    <span className="small muted">
                      {[r.capabilities.os, r.capabilities.arch].filter(Boolean).join(' ')}{' '}
                      · seen {formatRelative(r.last_seen_at)}
                    </span>
                  </span>
                  <span className="row">
                    <button
                      onClick={() =>
                        void act(() =>
                          call(`${base}/runners/${r.id}`, 'PATCH', {
                            disabled: !r.disabled,
                          }),
                        )
                      }
                    >
                      {r.disabled ? 'Enable' : 'Disable'}
                    </button>
                    <button
                      className="danger"
                      onClick={() =>
                        void act(() => call(`${base}/runners/${r.id}`, 'DELETE'))
                      }
                    >
                      Remove {r.name}
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}
