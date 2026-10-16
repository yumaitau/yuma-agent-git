import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import {
  api,
  asApiError,
  type ApiError,
  type ApiToken,
  type CreatedToken,
  type Member,
  type PathRule,
  type Repo,
} from '../api';
import { useToast } from '../toast';
import { RulesetsPanel } from './Rulesets';
import { ApprovalsPanel } from './Guardrails';
import {
  Chip,
  Empty,
  ErrorNotice,
  Field,
  Loading,
  SecretBox,
  formatRelative,
} from '../ui';

const ALL_SCOPES = ['repo:read', 'repo:write', 'agent:run'] as const;
const SUPERFAN_COMPONENTS = [
  'commit-path',
  'import-pipeline',
  'queues',
  'refs',
  'agents',
  'ai',
] as const;

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

function TokensPanel(): ReactElement {
  const toast = useToast();
  const [tokens, setTokens] = useState<ApiToken[] | null>(null);
  const [created, setCreated] = useState<CreatedToken | null>(null);
  const [label, setLabel] = useState('');
  const [scopes, setScopes] = useState<Record<string, boolean>>({
    'repo:read': true,
    'repo:write': true,
    'agent:run': true,
  });
  const [error, setError] = useState<ApiError | null>(null);

  const load = useCallback(() => {
    api
      .listTokens()
      .then(setTokens)
      .catch((err) => setError(asApiError(err)));
  }, []);
  useEffect(load, [load]);

  const create = useCallback(async () => {
    setError(null);
    try {
      const chosen = ALL_SCOPES.filter((s) => scopes[s]);
      const token = await api.createToken({
        label: label.trim(),
        scopes: chosen.length === ALL_SCOPES.length ? undefined : chosen,
      });
      setCreated(token); // raw value — shown exactly once
      setLabel('');
      load();
    } catch (err) {
      setError(asApiError(err));
    }
  }, [label, scopes, load]);

  const remove = useCallback(
    async (id: string) => {
      try {
        await api.deleteToken(id);
        toast.show('token deleted');
        load();
      } catch (err) {
        toast.showError(err);
      }
    },
    [toast, load],
  );

  return (
    <div className="panel">
      <h2>API tokens</h2>
      {error && <ErrorNotice error={error} />}
      {created && <SecretBox secret={created.token} />}
      {tokens === null ? (
        <Loading />
      ) : tokens.length === 0 ? (
        <Empty>No tokens yet.</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Label</th>
              <th>Scopes</th>
              <th>Created</th>
              <th>Last used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {tokens.map((t) => (
              <tr key={t.id}>
                <td>{t.label}</td>
                <td className="row">
                  {t.scopes.map((s) => (
                    <Chip key={s} kind="info">
                      {s}
                    </Chip>
                  ))}
                </td>
                <td className="small muted">{formatRelative(t.created_at)}</td>
                <td className="small muted">
                  {t.last_used_at ? formatRelative(t.last_used_at) : 'never'}
                </td>
                <td>
                  <button className="danger" onClick={() => void remove(t.id)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h3>New token</h3>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <Field label="Label">
          <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <fieldset className="checks">
          <legend className="small">Scopes</legend>
          {ALL_SCOPES.map((s) => (
            <label key={s}>
              <input
                type="checkbox"
                checked={scopes[s] ?? false}
                onChange={(e) =>
                  setScopes((prev) => ({ ...prev, [s]: e.target.checked }))
                }
              />
              {s}
            </label>
          ))}
        </fieldset>
        <button
          className="primary"
          disabled={label.trim() === ''}
          onClick={() => void create()}
        >
          Create token
        </button>
      </div>
      <div className="small faint" style={{ marginTop: 6 }}>
        The raw token is returned once at creation and stored only as a SHA-256 hash.
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Repo admin (members + path rules)
// ---------------------------------------------------------------------------

function RepoSelector({
  repos,
  value,
  onChange,
}: {
  repos: Repo[];
  value: string;
  onChange: (slug: string) => void;
}): ReactElement {
  return (
    <Field label="Repository">
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">select a repo…</option>
        {repos.map((r) => (
          <option key={r.id} value={r.slug}>
            {r.slug}
          </option>
        ))}
      </select>
    </Field>
  );
}

function MembersPanel({ repos }: { repos: Repo[] }): ReactElement {
  const toast = useToast();
  const [slug, setSlug] = useState('');
  const [members, setMembers] = useState<Member[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [user, setUser] = useState('');
  const [lookup, setLookup] = useState<'login' | 'id'>('login');
  const [role, setRole] = useState<'admin' | 'write' | 'triage' | 'read'>('read');

  const load = useCallback(() => {
    setMembers(null);
    setError(null);
    if (slug === '') return;
    api
      .listMembers(slug)
      .then(setMembers)
      .catch((err) => setError(asApiError(err)));
  }, [slug]);
  useEffect(load, [load]);

  const add = useCallback(async () => {
    try {
      const input =
        lookup === 'id'
          ? { user_id: user.trim(), role }
          : { user_login: user.trim(), role };
      await api.putMember(slug, input);
      toast.show('member saved');
      setUser('');
      load();
    } catch (err) {
      toast.showError(err);
      setError(asApiError(err));
    }
  }, [slug, lookup, user, role, toast, load]);

  const remove = useCallback(
    async (userId: string) => {
      try {
        await api.deleteMember(slug, userId);
        load();
      } catch (err) {
        toast.showError(err);
      }
    },
    [slug, toast, load],
  );

  return (
    <div className="panel">
      <h2>Repo members</h2>
      {error && <ErrorNotice error={error} />}
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <RepoSelector repos={repos} value={slug} onChange={setSlug} />
      </div>
      {slug !== '' &&
        (members === null ? (
          <Loading />
        ) : members.length === 0 ? (
          <Empty>No members — only the creator has access.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>User id</th>
                <th>Role</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.user_id}>
                  <td className="mono small wrap-any">{m.user_id}</td>
                  <td>
                    <Chip kind={m.role === 'admin' ? 'info' : 'default'}>{m.role}</Chip>
                  </td>
                  <td>
                    <button className="danger" onClick={() => void remove(m.user_id)}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      {slug !== '' && (
        <div className="row" style={{ alignItems: 'flex-end', marginTop: 10 }}>
          <Field label="GitHub login or user id">
            <input type="text" value={user} onChange={(e) => setUser(e.target.value)} />
          </Field>
          <Field label="Lookup by">
            <select
              value={lookup}
              onChange={(e) => setLookup(e.target.value as 'login' | 'id')}
            >
              <option value="login">GitHub login</option>
              <option value="id">user id</option>
            </select>
          </Field>
          <Field label="Role">
            <select value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
              <option value="read">read</option>
              <option value="triage">triage</option>
              <option value="write">write</option>
              <option value="admin">admin</option>
            </select>
          </Field>
          <button disabled={slug === '' || user.trim() === ''} onClick={() => void add()}>
            Add / update member
          </button>
        </div>
      )}
    </div>
  );
}

function PathRulesPanel({ repos }: { repos: Repo[] }): ReactElement {
  const toast = useToast();
  const [slug, setSlug] = useState('');
  const [rules, setRules] = useState<PathRule[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [prefix, setPrefix] = useState('');
  const [effect, setEffect] = useState<'grant' | 'deny'>('deny');
  const [principal, setPrincipal] = useState('*');
  const [perms, setPerms] = useState<Record<string, boolean>>({ history: true });

  const load = useCallback(() => {
    setRules(null);
    setError(null);
    if (slug === '') return;
    api
      .listPathRules(slug)
      .then(setRules)
      .catch((err) => setError(asApiError(err)));
  }, [slug]);
  useEffect(load, [load]);

  const add = useCallback(async () => {
    try {
      const chosen = (['read', 'write', 'history'] as const).filter((p) => perms[p]);
      await api.createPathRule(slug, {
        path_prefix: prefix.trim(),
        effect,
        principal: principal.trim(),
        perms: chosen,
      });
      toast.show('path rule created');
      setPrefix('');
      load();
    } catch (err) {
      toast.showError(err);
      setError(asApiError(err));
    }
  }, [slug, prefix, effect, principal, perms, toast, load]);

  const remove = useCallback(
    async (id: number) => {
      try {
        await api.deletePathRule(slug, id);
        load();
      } catch (err) {
        toast.showError(err);
      }
    },
    [slug, toast, load],
  );

  return (
    <div className="panel">
      <h2>Path rules</h2>
      <div className="small muted" style={{ marginBottom: 8 }}>
        Directory-level permissions — e.g. deny <code>history</code> on{' '}
        <code>secrets/</code> while the repo stays readable. Deny beats grant at equal
        specificity.
      </div>
      {error && <ErrorNotice error={error} />}
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <RepoSelector repos={repos} value={slug} onChange={setSlug} />
      </div>
      {slug !== '' &&
        (rules === null ? (
          <Loading />
        ) : rules.length === 0 ? (
          <Empty>No path rules configured.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Prefix</th>
                <th>Effect</th>
                <th>Principal</th>
                <th>Perms</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id}>
                  <td className="mono">{r.path_prefix}</td>
                  <td>
                    <Chip kind={r.effect === 'deny' ? 'danger' : 'ok'}>{r.effect}</Chip>
                  </td>
                  <td className="mono small">{r.principal}</td>
                  <td className="small">{r.perms.join(', ')}</td>
                  <td>
                    <button className="danger" onClick={() => void remove(r.id)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      {slug !== '' && (
        <div className="row" style={{ alignItems: 'flex-end', marginTop: 10 }}>
          <Field label="Path prefix">
            <input
              type="text"
              placeholder="secrets/"
              value={prefix}
              onChange={(e) => setPrefix(e.target.value)}
            />
          </Field>
          <Field label="Effect">
            <select
              value={effect}
              onChange={(e) => setEffect(e.target.value as typeof effect)}
            >
              <option value="deny">deny</option>
              <option value="grant">grant</option>
            </select>
          </Field>
          <Field label="Principal (* , role:admin|write|triage|read, user:ID, agent:ID)">
            <input
              type="text"
              value={principal}
              onChange={(e) => setPrincipal(e.target.value)}
            />
          </Field>
          <fieldset className="checks">
            <legend className="small">Perms</legend>
            {(['read', 'write', 'history'] as const).map((p) => (
              <label key={p}>
                <input
                  type="checkbox"
                  checked={perms[p] ?? false}
                  onChange={(e) =>
                    setPerms((prev) => ({ ...prev, [p]: e.target.checked }))
                  }
                />
                {p}
              </label>
            ))}
          </fieldset>
          <button
            disabled={slug === '' || prefix.trim() === '' || principal.trim() === ''}
            onClick={() => void add()}
          >
            Add rule
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Superfans
// ---------------------------------------------------------------------------

function SuperfansPanel({ repos }: { repos: Repo[] }): ReactElement {
  const toast = useToast();
  const [slug, setSlug] = useState('');
  const [component, setComponent] =
    useState<(typeof SUPERFAN_COMPONENTS)[number]>('commit-path');
  const [intervalMin, setIntervalMin] = useState('30');
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  const register = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const minutes = Number(intervalMin);
      if (slug === '') throw new Error('select a repo to file investigations into');
      if (!Number.isInteger(minutes) || minutes <= 0 || minutes > 1440) {
        throw new Error('interval must be an integer between 1 and 1440 minutes');
      }
      await api.createSuperfan(slug, { component, interval_min: minutes });
      toast.show(`superfan registered for ${component} on ${slug} (every ${minutes}m)`);
    } catch (err) {
      setError(asApiError(err));
    } finally {
      setBusy(false);
    }
  }, [slug, component, intervalMin, toast]);

  return (
    <div className="panel">
      <h2>Superfans</h2>
      <div className="small muted" style={{ marginBottom: 8 }}>
        Long-lived per-component monitors (issue #19) — registered by a repo admin and
        driven by a Durable Object alarm loop. Anomalies open investigation tasks in that
        repo. Registration is idempotent per repo and component.
      </div>
      {error && <ErrorNotice error={error} />}
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <RepoSelector repos={repos} value={slug} onChange={setSlug} />
        <Field label="Component">
          <select
            value={component}
            onChange={(e) => setComponent(e.target.value as typeof component)}
          >
            {SUPERFAN_COMPONENTS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Interval (minutes)">
          <input
            type="number"
            min={1}
            max={1440}
            value={intervalMin}
            onChange={(e) => setIntervalMin(e.target.value)}
          />
        </Field>
        <button className="primary" disabled={busy} onClick={() => void register()}>
          Register superfan
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function SettingsView(): ReactElement {
  const [repos, setRepos] = useState<Repo[]>([]);
  useEffect(() => {
    api
      .listRepos()
      .then(setRepos)
      .catch(() => setRepos([]));
  }, []);

  return (
    <div>
      <h1>Settings</h1>
      <TokensPanel />
      <MembersPanel repos={repos} />
      <PathRulesPanel repos={repos} />
      <RulesetsPanel repos={repos} />
      <ApprovalsPanel repos={repos} />
      <SuperfansPanel repos={repos} />
      <div className="small faint">
        Sign-in methods and second factors are managed on{' '}
        <Link to="/security">Security</Link>. Creating a token needs a second factor from
        the last 12 hours once you have one. Machine access uses the tokens above.
      </div>
    </div>
  );
}
