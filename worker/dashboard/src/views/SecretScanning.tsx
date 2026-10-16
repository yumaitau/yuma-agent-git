import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { asApiError, type ApiError } from '../api';
import { call } from '../collaboration';
import { useSlug } from '../slug';
import { Chip, Empty, ErrorNotice, formatRelative, Loading, shortId } from '../ui';
import { RepoNav } from './Collaboration';

interface Alert {
  id: number;
  detector: string;
  detector_name: string;
  path: string;
  line: number;
  changeset_id: string | null;
  source: 'push' | 'commit' | 'history';
  state: 'open' | 'resolved';
  resolution: string | null;
  bypass_reason: string | null;
  bypass_comment: string | null;
  created_at: number;
}
interface Scan {
  state: 'queued' | 'running' | 'done' | 'failed';
  changesets: number;
  files: number;
  alerts: number;
  error: string | null;
  updated_at: number;
}

const RESOLUTIONS: [string, string][] = [
  ['revoked', 'Revoked'],
  ['false_positive', 'False positive'],
  ['test_data', 'Test data'],
  ['wont_fix', "Won't fix"],
];
const BYPASS_LABEL: Record<string, string> = {
  false_positive: 'false positive',
  test_data: 'test data',
  will_fix: 'will fix',
};

/**
 * Secret scanning alerts (issue #66): what push protection let through on a
 * bypass and what the history scan found. Repo admins resolve or reopen each
 * alert and can scan the history again. Secrets themselves are never shown:
 * the server does not keep them.
 */
export function SecretScanningView(): ReactElement {
  const slug = useSlug();
  const [state, setState] = useState<'open' | 'resolved'>('open');
  const [data, setData] = useState<{ alerts: Alert[]; scan: Scan | null } | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState('');
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    call<{ alerts: Alert[]; scan: Scan | null }>(
      `/repos/${slug}/secret-scanning/alerts?state=${state}`,
    )
      .then((r) => !cancelled && setData(r))
      .catch((err) => !cancelled && setError(asApiError(err)));
    return () => {
      cancelled = true;
    };
  }, [slug, state, nonce]);

  const act = async (fn: () => Promise<unknown>, done: string): Promise<void> => {
    setError(null);
    setNotice('');
    try {
      await fn();
      setNotice(done);
      refresh();
    } catch (err) {
      setError(asApiError(err));
    }
  };

  const scan = data?.scan;
  return (
    <>
      <RepoNav active="Security" />
      <div className="row between">
        <h1>Secret scanning</h1>
        <button
          onClick={() =>
            void act(
              () => call(`/repos/${slug}/secret-scanning/scans`, 'POST'),
              'History scan queued.',
            )
          }
        >
          Scan history
        </button>
      </div>
      <p className="small muted">
        Pushes and commits that add a secret are refused. A repository admin can push past
        a finding with <code>git push -o secret-scanning.bypass=false_positive</code> (or{' '}
        <code>test_data</code>, <code>will_fix</code>); each bypass is audited and listed
        here.
      </p>
      {scan && (
        <p className="small muted" role="note">
          Last history scan: {scan.state}, {scan.changesets} changesets, {scan.files}{' '}
          files, {scan.alerts} alerts, {formatRelative(scan.updated_at)}
          {scan.error ? ` (${scan.error})` : ''}
        </p>
      )}
      {error && <ErrorNotice error={error} />}
      {notice && <p role="status">{notice}</p>}
      <nav className="row" aria-label="Alert state">
        {(['open', 'resolved'] as const).map((s) => (
          <button
            key={s}
            aria-pressed={state === s}
            onClick={() => {
              setData(null);
              setState(s);
            }}
          >
            {s === 'open' ? 'Open' : 'Resolved'}
          </button>
        ))}
      </nav>
      {!data && !error && <Loading />}
      {data && (
        <section className="panel">
          {data.alerts.length === 0 ? (
            <Empty>No {state} alerts.</Empty>
          ) : (
            <ul className="history-list">
              {data.alerts.map((a) => (
                <li key={a.id} className="row between">
                  <span>
                    <Chip kind={a.state === 'open' ? 'danger' : 'ok'}>
                      {a.state === 'open' ? 'open' : (a.resolution ?? 'resolved')}
                    </Chip>{' '}
                    <strong>{a.detector_name}</strong>{' '}
                    <code>
                      {a.path}:{a.line}
                    </code>{' '}
                    <span className="small muted">
                      {a.source}
                      {a.changeset_id && (
                        <>
                          {' · '}
                          <Link to={`/r/${slug}/cs/${a.changeset_id}`}>
                            {shortId(a.changeset_id)}
                          </Link>
                        </>
                      )}
                      {a.bypass_reason
                        ? ` · bypassed as ${BYPASS_LABEL[a.bypass_reason] ?? a.bypass_reason}`
                        : ''}
                      {a.bypass_comment ? `: ${a.bypass_comment}` : ''}
                      {' · '}
                      {formatRelative(a.created_at)}
                    </span>
                  </span>
                  {a.state === 'open' ? (
                    <select
                      aria-label={`Resolve alert ${a.id}`}
                      value=""
                      onChange={(e) =>
                        void act(
                          () =>
                            call(
                              `/repos/${slug}/secret-scanning/alerts/${a.id}`,
                              'PATCH',
                              {
                                state: 'resolved',
                                resolution: e.target.value,
                              },
                            ),
                          'Alert resolved.',
                        )
                      }
                    >
                      <option value="" disabled>
                        Resolve as…
                      </option>
                      {RESOLUTIONS.map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <button
                      onClick={() =>
                        void act(
                          () =>
                            call(
                              `/repos/${slug}/secret-scanning/alerts/${a.id}`,
                              'PATCH',
                              {
                                state: 'open',
                              },
                            ),
                          'Alert reopened.',
                        )
                      }
                    >
                      Reopen
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </>
  );
}
