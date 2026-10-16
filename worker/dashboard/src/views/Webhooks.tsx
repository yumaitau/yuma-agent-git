import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { asApiError, type ApiError } from '../api';
import { call } from '../collaboration';
import { useSlug } from '../slug';
import {
  Chip,
  Empty,
  ErrorNotice,
  Field,
  formatRelative,
  Loading,
  SecretBox,
} from '../ui';
import { RepoNav } from './Collaboration';

interface Hook {
  id: string;
  url: string;
  events: string[];
  format: 'yag' | 'github';
  active: boolean;
  created_at: number;
}
interface Delivery {
  id: string;
  event: string;
  action: string | null;
  status: 'pending' | 'retrying' | 'succeeded' | 'failed';
  attempts: number;
  response_code: number | null;
  error: string | null;
  created_at: number;
  next_attempt_at: number | null;
  redelivery_of: string | null;
}

const EVENTS = [
  'push',
  'ref',
  'pull_request',
  'pull_request_review',
  'pull_request_review_thread',
  'issues',
  'ci_run',
  'work_item',
  'secret_scanning_alert',
  'merge_group',
  'release',
  'package',
];
const STATUS_KIND = {
  pending: 'info',
  retrying: 'warn',
  succeeded: 'ok',
  failed: 'danger',
} as const;

/**
 * Repository webhooks (issue #75): create, pause and delete hooks, and read
 * each hook's delivery log with a redeliver button. Repo admins only; a
 * generated secret is shown once.
 */
export function WebhooksView(): ReactElement {
  const slug = useSlug();
  const [hooks, setHooks] = useState<Hook[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    call<{ hooks: Hook[] }>(`/repos/${slug}/hooks`)
      .then((r) => !cancelled && setHooks(r.hooks))
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
      refresh();
    } catch (err) {
      setError(asApiError(err));
    }
  };

  return (
    <>
      <RepoNav active="CI" />
      <div className="row between">
        <h1>Webhooks</h1>
        <span className="row">
          <Link to={`/r/${slug}/mirrors`}>Mirrors</Link>
          <Link to={`/r/${slug}/ci/access`}>Secrets and environments</Link>
        </span>
      </div>
      {error && <ErrorNotice error={error} />}
      {notice && <p role="status">{notice}</p>}
      {secret && <SecretBox secret={secret} />}
      {!hooks && !error && <Loading />}
      {hooks && (
        <section className="panel">
          {hooks.length === 0 ? (
            <Empty>No webhooks yet.</Empty>
          ) : (
            <ul className="history-list">
              {hooks.map((h) => (
                <li key={h.id} className="stack">
                  <div className="row between">
                    <span>
                      <code>{h.url}</code>{' '}
                      <Chip kind={h.active ? 'ok' : 'warn'}>
                        {h.active ? 'active' : 'paused'}
                      </Chip>{' '}
                      <span className="small muted">
                        {h.format} · {h.events.join(', ')}
                      </span>
                    </span>
                    <span className="row">
                      <button onClick={() => setOpen(open === h.id ? null : h.id)}>
                        {open === h.id ? 'Hide deliveries' : 'Deliveries'}
                      </button>
                      <button
                        onClick={() =>
                          void act(
                            () => call(`/hooks/${h.id}`, 'PATCH', { active: !h.active }),
                            h.active ? 'Webhook paused.' : 'Webhook resumed.',
                          )
                        }
                      >
                        {h.active ? 'Pause' : 'Resume'}
                      </button>
                      <button
                        onClick={() =>
                          void act(
                            () => call(`/hooks/${h.id}`, 'DELETE'),
                            'Webhook deleted.',
                          )
                        }
                      >
                        Delete
                      </button>
                    </span>
                  </div>
                  {open === h.id && <DeliveryLog hookId={h.id} onError={setError} />}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      <NewHookForm
        onCreate={(body) =>
          act(async () => {
            setSecret(null);
            const created = await call<{ secret?: string }>(
              `/repos/${slug}/hooks`,
              'POST',
              body,
            );
            if (created.secret) setSecret(created.secret);
          }, 'Webhook created.')
        }
      />
    </>
  );
}

function DeliveryLog({
  hookId,
  onError,
}: {
  hookId: string;
  onError: (err: ApiError) => void;
}): ReactElement {
  const [deliveries, setDeliveries] = useState<Delivery[] | null>(null);
  const [notice, setNotice] = useState('');
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    call<{ deliveries: Delivery[] }>(`/hooks/${hookId}/deliveries`)
      .then((r) => !cancelled && setDeliveries(r.deliveries))
      .catch((err) => !cancelled && onError(asApiError(err)));
    return () => {
      cancelled = true;
    };
  }, [hookId, nonce, onError]);

  if (!deliveries) return <Loading />;
  return (
    <div className="stack">
      {notice && <p role="status">{notice}</p>}
      {deliveries.length === 0 ? (
        <p className="small muted">No deliveries yet.</p>
      ) : (
        <ul className="history-list">
          {deliveries.map((d) => (
            <li key={d.id} className="row between">
              <span>
                <Chip kind={STATUS_KIND[d.status]}>{d.status}</Chip>{' '}
                <code>{d.action ? `${d.event}.${d.action}` : d.event}</code>{' '}
                <span className="small muted">
                  {d.attempts} attempt{d.attempts === 1 ? '' : 's'}
                  {d.response_code !== null ? ` · HTTP ${d.response_code}` : ''}
                  {d.error && d.response_code === null ? ` · ${d.error}` : ''}
                  {d.status === 'retrying' && d.next_attempt_at
                    ? ` · next ${formatRelative(d.next_attempt_at)}`
                    : ''}
                  {' · '}
                  {formatRelative(d.created_at)}
                  {d.redelivery_of ? ' · redelivery' : ''}
                </span>
              </span>
              <button
                onClick={() =>
                  void call(`/hooks/${hookId}/deliveries/${d.id}/redeliver`, 'POST')
                    .then(() => {
                      setNotice('Redelivery queued.');
                      setNonce((n) => n + 1);
                    })
                    .catch((err) => onError(asApiError(err)))
                }
              >
                Redeliver
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NewHookForm({
  onCreate,
}: {
  onCreate: (body: unknown) => Promise<void>;
}): ReactElement {
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [format, setFormat] = useState<'yag' | 'github'>('yag');
  const [events, setEvents] = useState<string[]>(['push', 'pull_request']);
  return (
    <section className="panel">
      <h2>Add a webhook</h2>
      <p className="small muted">
        Deliveries are signed with <code>X-Yag-Signature-256</code> (and{' '}
        <code>X-Hub-Signature-256</code> in the GitHub format). URLs must use https and
        cannot point at private addresses. Leave the secret blank to have one generated.
      </p>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void onCreate({
            url: url.trim(),
            events,
            format,
            ...(secret ? { secret } : {}),
          }).then(() => {
            setUrl('');
            setSecret('');
          });
        }}
      >
        <Field label="Payload URL">
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://"
            required
          />
        </Field>
        <div className="row">
          <Field label="Format">
            <select
              value={format}
              onChange={(e) => setFormat(e.target.value as 'yag' | 'github')}
            >
              <option value="yag">Yuma</option>
              <option value="github">GitHub compatible</option>
            </select>
          </Field>
          <Field label="Secret (optional)">
            <input
              type="password"
              autoComplete="off"
              minLength={16}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
          </Field>
        </div>
        <fieldset className="row">
          <legend>Events</legend>
          {EVENTS.map((name) => (
            <label key={name}>
              <input
                type="checkbox"
                checked={events.includes(name)}
                onChange={(e) =>
                  setEvents(
                    e.target.checked
                      ? [...events, name]
                      : events.filter((x) => x !== name),
                  )
                }
              />{' '}
              {name}
            </label>
          ))}
        </fieldset>
        <div className="row">
          <button className="primary" disabled={events.length === 0}>
            Add webhook
          </button>
        </div>
      </form>
    </section>
  );
}
