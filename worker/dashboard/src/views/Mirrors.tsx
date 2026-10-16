import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { asApiError, type ApiError } from '../api';
import { call } from '../collaboration';
import { useSlug } from '../slug';
import { Chip, Empty, ErrorNotice, Field, formatRelative, Loading } from '../ui';
import { RepoNav } from './Collaboration';

interface RefResult {
  ref: string;
  status: string;
  detail?: string;
}
interface Mirror {
  id: string;
  direction: 'pull' | 'push';
  remote_url: string;
  auth: 'none' | 'token' | 'github_app';
  has_token: boolean;
  interval_s: number;
  force: boolean;
  enabled: boolean;
  syncing: boolean;
  last_sync_at: number | null;
  last_success_at: number | null;
  last_error: string | null;
  last_result: RefResult[];
}
interface Check {
  name: string;
  ok: boolean;
  message: string;
}
interface Migration {
  state: 'github' | 'mirror' | 'dual' | 'cutover';
  pull_mirror_id: string | null;
  push_mirror_id: string | null;
  transitions: { to: string; checks: Check[] }[];
}

const STATE_TEXT: Record<Migration['state'], string> = {
  github: 'GitHub only',
  mirror: 'GitHub primary, pulled into the forge',
  dual: 'Forge primary, pushed to GitHub',
  cutover: 'Forge only, GitHub archived',
};
const NOT_MIRRORED = new Set(['diverged', 'failed']);

/**
 * Mirrors and the GitHub cutover (issues #36, #73): pull and push mirrors
 * with their last sync, failures and diverged refs, and the cutover state
 * with the checks for each move. Repo admins only; tokens are write-only.
 */
export function MirrorsView(): ReactElement {
  const slug = useSlug();
  const [mirrors, setMirrors] = useState<Mirror[] | null>(null);
  const [migration, setMigration] = useState<Migration | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState('');
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      call<{ mirrors: Mirror[] }>(`/repos/${slug}/mirrors`),
      call<Migration>(`/repos/${slug}/migration`),
    ])
      .then(([m, g]) => {
        if (cancelled) return;
        setMirrors(m.mirrors);
        setMigration(g);
      })
      .catch((err) => !cancelled && setError(asApiError(err)));
    return () => {
      cancelled = true;
    };
  }, [slug, nonce]);

  const act = async (fn: () => Promise<unknown>, done: string): Promise<void> => {
    setError(null);
    setNotice('');
    try {
      await fn();
      setNotice(done);
    } catch (err) {
      setError(asApiError(err));
    }
    refresh();
  };

  return (
    <>
      <RepoNav active="Code" />
      <h1>Mirrors</h1>
      {error && <ErrorNotice error={error} />}
      {notice && <p role="status">{notice}</p>}
      {!mirrors && !error && <Loading />}
      {migration && mirrors && (
        <CutoverPanel
          migration={migration}
          mirrors={mirrors}
          onMove={(body) =>
            act(
              () => call(`/repos/${slug}/migration`, 'POST', body),
              `Moved to ${String((body as { to: string }).to)}.`,
            )
          }
        />
      )}
      {mirrors && (
        <section className="panel">
          {mirrors.length === 0 ? (
            <Empty>No mirrors yet.</Empty>
          ) : (
            <ul className="history-list">
              {mirrors.map((m) => (
                <li key={m.id} className="stack">
                  <div className="row between">
                    <span>
                      <Chip kind="info">{m.direction}</Chip> <code>{m.remote_url}</code>{' '}
                      <Chip kind={!m.enabled ? 'warn' : m.last_error ? 'danger' : 'ok'}>
                        {!m.enabled ? 'paused' : m.last_error ? 'failing' : 'in sync'}
                      </Chip>{' '}
                      <span className="small muted">
                        {m.id} · every {Math.round(m.interval_s / 60)} min
                        {m.force ? ' · force' : ''}
                        {m.last_sync_at
                          ? ` · last sync ${formatRelative(m.last_sync_at)}`
                          : ' · never synced'}
                      </span>
                    </span>
                    <span className="row">
                      <button
                        disabled={!m.enabled || m.syncing}
                        onClick={() =>
                          void act(
                            () => call(`/repos/${slug}/mirrors/${m.id}/sync`, 'POST'),
                            'Mirror synced.',
                          )
                        }
                      >
                        Sync now
                      </button>
                      <button
                        onClick={() =>
                          void act(
                            () =>
                              call(`/repos/${slug}/mirrors/${m.id}`, 'PATCH', {
                                enabled: !m.enabled,
                              }),
                            m.enabled ? 'Mirror paused.' : 'Mirror resumed.',
                          )
                        }
                      >
                        {m.enabled ? 'Pause' : 'Resume'}
                      </button>
                      <button
                        onClick={() =>
                          void act(
                            () => call(`/repos/${slug}/mirrors/${m.id}`, 'DELETE'),
                            'Mirror deleted.',
                          )
                        }
                      >
                        Delete
                      </button>
                    </span>
                  </div>
                  {m.last_error && <p className="small error">{m.last_error}</p>}
                  {m.last_result.some((r) => NOT_MIRRORED.has(r.status)) && (
                    <ul className="small">
                      {m.last_result
                        .filter((r) => NOT_MIRRORED.has(r.status))
                        .map((r) => (
                          <li key={r.ref}>
                            <code>{r.ref}</code> {r.status}
                            {r.detail ? `: ${r.detail}` : ''}
                          </li>
                        ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      <NewMirrorForm
        onCreate={(body) =>
          act(() => call(`/repos/${slug}/mirrors`, 'POST', body), 'Mirror created.')
        }
      />
    </>
  );
}

function CutoverPanel({
  migration,
  mirrors,
  onMove,
}: {
  migration: Migration;
  mirrors: Mirror[];
  onMove: (body: unknown) => Promise<void>;
}): ReactElement {
  const slug = useSlug();
  const [pull, setPull] = useState(migration.pull_mirror_id ?? '');
  const [push, setPush] = useState(migration.push_mirror_id ?? '');
  const [confirm, setConfirm] = useState('');
  const options = (direction: Mirror['direction']) =>
    mirrors
      .filter((m) => m.direction === direction)
      .map((m) => (
        <option key={m.id} value={m.id}>
          {m.remote_url}
        </option>
      ));
  return (
    <section className="panel stack">
      <h2>GitHub cutover</h2>
      <p>
        <Chip kind="info">{migration.state}</Chip> {STATE_TEXT[migration.state]}
      </p>
      <div className="row">
        <Field label="Pull mirror">
          <select value={pull} onChange={(e) => setPull(e.target.value)}>
            <option value="">None</option>
            {options('pull')}
          </select>
        </Field>
        <Field label="Push mirror">
          <select value={push} onChange={(e) => setPush(e.target.value)}>
            <option value="">None</option>
            {options('push')}
          </select>
        </Field>
        <Field label={`Type ${slug} to approve GitHub changes`}>
          <input value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
      </div>
      {migration.transitions.map((t) => (
        <div key={t.to} className="stack">
          <ul className="small">
            {t.checks.map((check) => (
              <li key={check.name}>
                <Chip kind={check.ok ? 'ok' : 'warn'}>{check.name}</Chip> {check.message}
              </li>
            ))}
          </ul>
          <div className="row">
            <button
              onClick={() =>
                void onMove({
                  to: t.to,
                  ...(pull ? { pull_mirror_id: pull } : {}),
                  ...(push ? { push_mirror_id: push } : {}),
                  ...(confirm ? { confirm } : {}),
                })
              }
            >
              Move to {t.to}
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}

function NewMirrorForm({
  onCreate,
}: {
  onCreate: (body: unknown) => Promise<void>;
}): ReactElement {
  const [direction, setDirection] = useState<Mirror['direction']>('pull');
  const [url, setUrl] = useState('');
  const [auth, setAuth] = useState<Mirror['auth']>('github_app');
  const [token, setToken] = useState('');
  return (
    <section className="panel">
      <h2>Add a mirror</h2>
      <p className="small muted">
        A pull mirror copies the remote&apos;s branches and tags into this repository; a
        push mirror sends this repository&apos;s branches and tags to the remote. SHAs
        stay the same. Remote history is never overwritten unless you turn on force.
      </p>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void onCreate({
            direction,
            remote_url: url.trim(),
            auth,
            ...(auth === 'token' ? { token } : {}),
          }).then(() => {
            setUrl('');
            setToken('');
          });
        }}
      >
        <div className="row">
          <Field label="Direction">
            <select
              value={direction}
              onChange={(e) => setDirection(e.target.value as Mirror['direction'])}
            >
              <option value="pull">Pull from remote</option>
              <option value="push">Push to remote</option>
            </select>
          </Field>
          <Field label="Remote URL">
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://github.com/owner/repo.git"
              required
            />
          </Field>
        </div>
        <div className="row">
          <Field label="Credentials">
            <select
              value={auth}
              onChange={(e) => setAuth(e.target.value as Mirror['auth'])}
            >
              <option value="github_app">GitHub App</option>
              <option value="token">Access token</option>
              <option value="none">None (public)</option>
            </select>
          </Field>
          {auth === 'token' && (
            <Field label="Access token">
              <input
                type="password"
                autoComplete="off"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                required
              />
            </Field>
          )}
        </div>
        <div className="row">
          <button className="primary">Add mirror</button>
        </div>
      </form>
    </section>
  );
}
