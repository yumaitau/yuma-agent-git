import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { asApiError, type ApiError } from '../api';
import { call } from '../collaboration';
import { useSlug } from '../slug';
import { Chip, Empty, ErrorNotice, Field, formatRelative, Loading, shortId } from '../ui';
import { RepoNav } from './Collaboration';

interface Rules {
  reviewers: { type: 'user' | 'team'; id: string; name: string }[];
  wait_timer_minutes: number;
  allowed_branches: string[];
  humans_only: boolean;
}
interface Environment {
  name: string;
  rules: Rules;
  updated_at: number;
}
interface Approval {
  id: string;
  environment: string;
  head_cs: string;
  ref: string | null;
  actor_kind: string | null;
  requested_by: string;
  state: string;
  created_at: number;
  not_before: number;
}
export interface Entry {
  name: string;
  value?: string;
  updated_at: number;
}

const list = (text: string): string[] =>
  text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * CI secrets, variables, environments and pending approvals (issue #50).
 * Secret values are write-only: this page can set or delete one, never read it.
 */
export function CiAccessView(): ReactElement {
  const slug = useSlug();
  const base = `/repos/${slug}`;
  const [environments, setEnvironments] = useState<Environment[] | null>(null);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [scope, setScope] = useState('');
  const [secrets, setSecrets] = useState<Entry[] | null>(null);
  const [variables, setVariables] = useState<Entry[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState('');
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  const query = scope ? `?environment=${encodeURIComponent(scope)}` : '';

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      call<{ environments: Environment[] }>(`${base}/environments`),
      call<{ approvals: Approval[] }>(`${base}/environment-approvals?state=pending`),
    ])
      .then(([e, a]) => {
        if (cancelled) return;
        setEnvironments(e.environments);
        setApprovals(a.approvals);
      })
      .catch((err) => !cancelled && setError(asApiError(err)));
    // secrets and variables are admin-only; readers still see approvals
    void Promise.all([
      call<{ secrets: Entry[] }>(`${base}/secrets${query}`),
      call<{ variables: Entry[] }>(`${base}/variables${query}`),
    ])
      .then(([s, v]) => {
        if (cancelled) return;
        setSecrets(s.secrets);
        setVariables(v.variables);
      })
      .catch(() => {
        if (cancelled) return;
        setSecrets(null);
        setVariables(null);
      });
    return () => {
      cancelled = true;
    };
  }, [base, query, nonce]);

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
      <RepoNav active="CI" />
      <div className="row between">
        <h1>Secrets and environments</h1>
        <span className="row">
          <Link to={`/r/${slug}/hooks`}>Webhooks</Link>
          <Link to={`/r/${slug}/ci`}>Back to runs</Link>
        </span>
      </div>
      {error && <ErrorNotice error={error} />}
      {notice && <p role="status">{notice}</p>}
      {!environments && !error && <Loading />}

      <section className="panel">
        <h2>Waiting for approval</h2>
        {approvals.length === 0 ? (
          <Empty>No runs are waiting for an environment.</Empty>
        ) : (
          <ul className="history-list">
            {approvals.map((a) => (
              <li key={a.id} className="row between">
                <span>
                  <Chip kind="warn">{a.environment}</Chip>{' '}
                  <code>{a.ref ?? shortId(a.head_cs)}</code>{' '}
                  <span className="small muted">
                    {a.actor_kind === 'agent' ? 'agent' : 'person'} ·{' '}
                    {formatRelative(a.created_at)}
                  </span>
                </span>
                <span className="row">
                  {(['approve', 'reject'] as const).map((decision) => (
                    <button
                      key={decision}
                      className={decision === 'approve' ? 'primary' : undefined}
                      onClick={() =>
                        void act(
                          () =>
                            call(`${base}/environment-approvals/${a.id}`, 'POST', {
                              decision,
                            }),
                          decision === 'approve' ? 'Run approved.' : 'Run rejected.',
                        )
                      }
                    >
                      {decision === 'approve' ? 'Approve' : 'Reject'}
                    </button>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <EnvironmentsPanel
        environments={environments ?? []}
        onSave={(name, body) =>
          act(
            () => call(`${base}/environments/${encodeURIComponent(name)}`, 'PUT', body),
            `Environment ${name} saved.`,
          )
        }
      />

      {secrets && variables && (
        <section className="panel">
          <div className="row between">
            <h2>Secrets and variables</h2>
            <Field label="Scope">
              <select value={scope} onChange={(e) => setScope(e.target.value)}>
                <option value="">Repository</option>
                {(environments ?? []).map((e) => (
                  <option key={e.name} value={e.name}>
                    Environment: {e.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <p className="small muted">
            Secret values are encrypted and can never be read back. Jobs receive the
            secrets their pipeline names, masked in logs.
          </p>
          {(['secrets', 'variables'] as const).map((kind) => (
            <EntryList
              key={kind}
              kind={kind}
              entries={kind === 'secrets' ? secrets : variables}
              onSave={(name, value) =>
                act(
                  () => call(`${base}/${kind}/${name}${query}`, 'PUT', { value }),
                  `${name} saved.`,
                )
              }
              onDelete={(name) =>
                act(
                  () => call(`${base}/${kind}/${name}${query}`, 'DELETE'),
                  `${name} deleted.`,
                )
              }
            />
          ))}
        </section>
      )}
    </>
  );
}

function EnvironmentsPanel({
  environments,
  onSave,
}: {
  environments: Environment[];
  onSave: (name: string, body: unknown) => Promise<void>;
}): ReactElement {
  const [name, setName] = useState('production');
  const [users, setUsers] = useState('');
  const [teams, setTeams] = useState('');
  const [branches, setBranches] = useState('main');
  const [wait, setWait] = useState(0);
  const [humansOnly, setHumansOnly] = useState(true);
  return (
    <section className="panel">
      <h2>Environments</h2>
      {environments.length === 0 ? (
        <Empty>No environments yet. Add one to protect deployments.</Empty>
      ) : (
        <ul className="history-list">
          {environments.map((e) => (
            <li key={e.name}>
              <strong>{e.name}</strong>{' '}
              <span className="small muted">
                {e.rules.reviewers.length
                  ? `reviewers: ${e.rules.reviewers.map((r) => r.name).join(', ')}`
                  : 'no reviewers'}
                {e.rules.allowed_branches.length
                  ? ` · branches: ${e.rules.allowed_branches.join(', ')}`
                  : ' · any branch'}
                {e.rules.wait_timer_minutes
                  ? ` · wait ${e.rules.wait_timer_minutes} min`
                  : ''}
                {e.rules.humans_only ? ' · people only' : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void onSave(name.trim(), {
            reviewers: [
              ...list(users).map((n) => ({ type: 'user', name: n })),
              ...list(teams).map((n) => ({ type: 'team', name: n })),
            ],
            allowed_branches: list(branches),
            wait_timer_minutes: wait,
            humans_only: humansOnly,
          });
        }}
      >
        <div className="row">
          <Field label="Environment name">
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>
          <Field label="Wait timer (minutes)">
            <input
              type="number"
              min={0}
              value={wait}
              onChange={(e) => setWait(Number(e.target.value))}
            />
          </Field>
        </div>
        <Field label="Required reviewers (logins, comma separated)">
          <input value={users} onChange={(e) => setUsers(e.target.value)} />
        </Field>
        <Field label="Reviewer teams (slugs, comma separated)">
          <input value={teams} onChange={(e) => setTeams(e.target.value)} />
        </Field>
        <Field label="Allowed branches (globs, blank for any)">
          <input value={branches} onChange={(e) => setBranches(e.target.value)} />
        </Field>
        <label>
          <input
            type="checkbox"
            checked={humansOnly}
            onChange={(e) => setHumansOnly(e.target.checked)}
          />{' '}
          Only runs started by a person (block agents)
        </label>
        <div className="row">
          <button className="primary">Save environment</button>
        </div>
      </form>
    </section>
  );
}

export function EntryList({
  kind,
  entries,
  onSave,
  onDelete,
}: {
  kind: 'secrets' | 'variables';
  entries: Entry[];
  onSave: (name: string, value: string) => Promise<void>;
  onDelete: (name: string) => Promise<void>;
}): ReactElement {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const secret = kind === 'secrets';
  return (
    <div className="stack">
      <h3>{secret ? 'Secrets' : 'Variables'}</h3>
      {entries.length === 0 ? (
        <p className="small muted">None at this scope.</p>
      ) : (
        <ul className="history-list">
          {entries.map((entry) => (
            <li key={entry.name} className="row between">
              <span>
                <code>{entry.name}</code>{' '}
                {!secret && <span className="mono small">{entry.value}</span>}{' '}
                <span className="small muted">
                  updated {formatRelative(entry.updated_at)}
                </span>
              </span>
              <button
                aria-label={`Delete ${entry.name}`}
                onClick={() => void onDelete(entry.name)}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void onSave(name.trim(), value).then(() => {
            setName('');
            setValue('');
          });
        }}
      >
        <Field label={secret ? 'Secret name' : 'Variable name'}>
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <Field label={secret ? 'Secret value' : 'Variable value'}>
          <input
            type={secret ? 'password' : 'text'}
            autoComplete="off"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            required={secret}
          />
        </Field>
        <button>{secret ? 'Save secret' : 'Save variable'}</button>
      </form>
    </div>
  );
}
