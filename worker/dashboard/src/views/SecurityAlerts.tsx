import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { asApiError, type ApiError } from '../api';
import { call } from '../collaboration';
import { useSlug } from '../slug';
import { Chip, Empty, ErrorNotice, formatRelative, Loading } from '../ui';
import { RepoNav } from './Collaboration';

type State = 'open' | 'fixed' | 'dismissed';

interface DependencyAlert {
  id: number;
  advisory_id: string;
  ecosystem: string;
  name: string;
  version: string;
  path: string;
  severity: string;
  fixed_version: string | null;
  state: State;
  dismissed_reason: string | null;
  work_number: number | null;
  updated_at: number;
  advisory: { summary?: string; url?: string };
}

interface CodeAlert {
  id: number;
  tool: string;
  rule_id: string;
  rule_name: string | null;
  severity: string;
  message: string;
  path: string;
  start_line: number | null;
  state: State;
  dismissed_reason: string | null;
  updated_at: number;
}

const DEPENDENCY_REASONS: [string, string][] = [
  ['fix_started', 'Fix started'],
  ['inaccurate', 'Inaccurate'],
  ['no_bandwidth', 'No bandwidth'],
  ['not_used', 'Not used'],
  ['tolerable_risk', 'Tolerable risk'],
];
const CODE_REASONS: [string, string][] = [
  ['false_positive', 'False positive'],
  ['wont_fix', "Won't fix"],
  ['used_in_tests', 'Used in tests'],
];

const SEVERITY_KIND: Record<string, 'danger' | 'warn' | 'info'> = {
  critical: 'danger',
  high: 'danger',
  medium: 'warn',
};

function severity(s: string): ReactElement {
  return <Chip kind={SEVERITY_KIND[s] ?? 'info'}>{s}</Chip>;
}

/** Dismiss with a reason while open; reopen while dismissed; nothing once fixed. */
function StateControl({
  label,
  state,
  reasons,
  onChange,
}: {
  label: string;
  state: State;
  reasons: [string, string][];
  onChange: (body: { state: 'open' } | { state: 'dismissed'; reason: string }) => void;
}): ReactElement | null {
  if (state === 'open')
    return (
      <select
        aria-label={`Dismiss ${label}`}
        value=""
        onChange={(e) => onChange({ state: 'dismissed', reason: e.target.value })}
      >
        <option value="" disabled>
          Dismiss as…
        </option>
        {reasons.map(([value, text]) => (
          <option key={value} value={value}>
            {text}
          </option>
        ))}
      </select>
    );
  if (state === 'dismissed')
    return <button onClick={() => onChange({ state: 'open' })}>Reopen</button>;
  return null;
}

/**
 * Dependency and code scanning alerts (issue #67): advisories (OSV) matched
 * against the default branch lockfiles, and SARIF results uploaded from CI.
 * People with write dismiss or reopen alerts and file update work that an
 * agent can pick up from the work queue.
 */
export function SecurityAlertsView(): ReactElement {
  const slug = useSlug();
  const [state, setState] = useState<State>('open');
  const [deps, setDeps] = useState<{
    alerts: DependencyAlert[];
    attribution: string;
  } | null>(null);
  const [code, setCode] = useState<{ ref: string; alerts: CodeAlert[] } | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState('');
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      call<{ alerts: DependencyAlert[]; attribution: string }>(
        `/repos/${slug}/dependency-alerts?state=${state}`,
      ),
      call<{ ref: string; alerts: CodeAlert[] }>(
        `/repos/${slug}/code-scanning/alerts?state=${state}`,
      ),
    ])
      .then(([d, c]) => {
        if (cancelled) return;
        setDeps(d);
        setCode(c);
      })
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

  return (
    <>
      <RepoNav active="Security" />
      <div className="row between">
        <h1>Dependency and code scanning alerts</h1>
        <Link to={`/r/${slug}/secret-scanning`}>Secret scanning</Link>
      </div>
      <p className="small muted">
        A ruleset rule <code>security_alerts</code> blocks merging a pull request that
        adds alerts at or above a severity (high by default). CI uploads SARIF with{' '}
        <code>permissions.security_events: write</code>.
      </p>
      {error && <ErrorNotice error={error} />}
      {notice && <p role="status">{notice}</p>}
      <nav className="row" aria-label="Alert state">
        {(['open', 'fixed', 'dismissed'] as const).map((s) => (
          <button
            key={s}
            aria-pressed={state === s}
            onClick={() => {
              setDeps(null);
              setCode(null);
              setState(s);
            }}
          >
            {s[0]!.toUpperCase() + s.slice(1)}
          </button>
        ))}
      </nav>
      {!deps && !error && <Loading />}
      {deps && (
        <section className="panel">
          <h2>Dependencies</h2>
          {deps.alerts.length === 0 ? (
            <Empty>No {state} dependency alerts.</Empty>
          ) : (
            <ul className="history-list">
              {deps.alerts.map((a) => (
                <li key={a.id} className="row between">
                  <span>
                    {severity(a.severity)} <strong>{a.name}</strong>{' '}
                    <code>{a.version}</code>
                    {a.fixed_version ? ` → ${a.fixed_version}` : ''}{' '}
                    <span className="small muted">
                      {a.advisory.url ? (
                        <a href={a.advisory.url} rel="noreferrer" target="_blank">
                          {a.advisory_id}
                        </a>
                      ) : (
                        a.advisory_id
                      )}
                      {a.advisory.summary ? ` ${a.advisory.summary}` : ''} · {a.path}
                      {a.dismissed_reason ? ` · ${a.dismissed_reason}` : ''}
                      {a.work_number !== null && (
                        <>
                          {' · '}
                          <Link to={`/r/${slug}/issues/${a.work_number}`}>
                            #{a.work_number}
                          </Link>
                        </>
                      )}
                      {' · '}
                      {formatRelative(a.updated_at)}
                    </span>
                  </span>
                  <span className="row">
                    {a.state === 'open' && a.fixed_version && a.work_number === null && (
                      <button
                        onClick={() =>
                          void act(
                            () =>
                              call(
                                `/repos/${slug}/dependency-alerts/${a.id}/work`,
                                'POST',
                              ),
                            'Update work filed.',
                          )
                        }
                      >
                        File update work
                      </button>
                    )}
                    <StateControl
                      label={`${a.name} alert ${a.id}`}
                      state={a.state}
                      reasons={DEPENDENCY_REASONS}
                      onChange={(body) =>
                        void act(
                          () =>
                            call(
                              `/repos/${slug}/dependency-alerts/${a.id}`,
                              'PATCH',
                              body,
                            ),
                          body.state === 'open' ? 'Alert reopened.' : 'Alert dismissed.',
                        )
                      }
                    />
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="small muted">{deps.attribution}</p>
        </section>
      )}
      {code && (
        <section className="panel">
          <h2>Code scanning on {code.ref}</h2>
          {code.alerts.length === 0 ? (
            <Empty>No {state} code scanning alerts.</Empty>
          ) : (
            <ul className="history-list">
              {code.alerts.map((a) => (
                <li key={a.id} className="row between">
                  <span>
                    {severity(a.severity)} <strong>{a.rule_name ?? a.rule_id}</strong>{' '}
                    <code>
                      {a.path}
                      {a.start_line !== null ? `:${a.start_line}` : ''}
                    </code>{' '}
                    <span className="small muted">
                      {a.tool} · {a.message}
                      {a.dismissed_reason ? ` · ${a.dismissed_reason}` : ''} ·{' '}
                      {formatRelative(a.updated_at)}
                    </span>
                  </span>
                  <StateControl
                    label={`${a.rule_id} alert ${a.id}`}
                    state={a.state}
                    reasons={CODE_REASONS}
                    onChange={(body) =>
                      void act(
                        () =>
                          call(
                            `/repos/${slug}/code-scanning/alerts/${a.id}`,
                            'PATCH',
                            body,
                          ),
                        body.state === 'open' ? 'Alert reopened.' : 'Alert dismissed.',
                      )
                    }
                  />
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </>
  );
}
