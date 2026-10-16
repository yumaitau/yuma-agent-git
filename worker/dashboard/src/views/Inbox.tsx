import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { asApiError, type ApiError } from '../api';
import { call } from '../collaboration';
import { Chip, Empty, ErrorNotice, Field, formatRelative, Loading } from '../ui';

interface Notification {
  id: string;
  repo: string;
  reason: string;
  event: string;
  action: string | null;
  actor: string | null;
  subject: {
    type: string;
    id: string;
    number: number | null;
    title: string;
    url: string;
  };
  unread: boolean;
  created_at: number;
}
interface Inbox {
  notifications: Notification[];
  names: Record<string, string>;
  unread_count: number;
  next_cursor: string | null;
}
interface Settings {
  settings: {
    email: 'off' | 'instant' | 'digest';
    digest_hour: number;
    skip_weekends: boolean;
    reasons: Record<string, boolean>;
  };
  email_address: string | null;
  email_available: boolean;
  digest_time_zone: string;
}

const REASON_LABEL: Record<string, string> = {
  review_requested: 'Review requested',
  mention: 'Mentioned',
  assign: 'Assigned',
  approval_requested: 'Approval needed',
  security_alert: 'Security alert',
  ci_failed: 'CI failed',
  queue_ejected: 'Left merge queue',
  work_claimed: 'Work claimed',
  author: 'Your thread',
  comment: 'Participating',
  manual: 'Subscribed',
  subscribed: 'Watching',
};

const STATES = [
  ['inbox', 'Inbox'],
  ['unread', 'Unread'],
  ['done', 'Done'],
] as const;

/**
 * Notification inbox (issue #44): review requests, mentions, CI failures and
 * the rest, newest first. Mark each read or done, or the whole inbox read,
 * and choose how email arrives. Repo watch levels and thread mutes live on
 * the repository and thread pages' API.
 */
export function InboxView(): ReactElement {
  const [state, setState] = useState<(typeof STATES)[number][0]>('inbox');
  const [data, setData] = useState<Inbox | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    call<Inbox>(`/notifications?state=${state}`)
      .then((r) => !cancelled && setData(r))
      .catch((err) => !cancelled && setError(asApiError(err)));
    return () => {
      cancelled = true;
    };
  }, [state, nonce]);

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setError(null);
    try {
      await fn();
      refresh();
    } catch (err) {
      setError(asApiError(err));
    }
  };
  const mark = (id: string, body: { read?: boolean; done?: boolean }) =>
    void act(() => call(`/notifications/${id}`, 'PATCH', body));

  return (
    <>
      <div className="row between">
        <h1>Notifications</h1>
        <button
          disabled={!data || data.unread_count === 0}
          onClick={() => void act(() => call('/notifications/read', 'POST'))}
        >
          Mark all read
        </button>
      </div>
      {error && <ErrorNotice error={error} />}
      <nav className="row" aria-label="Notification state">
        {STATES.map(([value, label]) => (
          <button
            key={value}
            aria-pressed={state === value}
            onClick={() => {
              setData(null);
              setState(value);
            }}
          >
            {label}
          </button>
        ))}
        {data && <span className="small muted">{data.unread_count} unread</span>}
      </nav>
      {!data && !error && <Loading />}
      {data && (
        <section className="panel">
          {data.notifications.length === 0 ? (
            <Empty>Nothing here.</Empty>
          ) : (
            <ul className="history-list">
              {data.notifications.map((n) => (
                <li key={n.id} className="row between">
                  <span>
                    <Chip kind={n.unread ? 'info' : 'default'}>
                      {REASON_LABEL[n.reason] ?? n.reason}
                    </Chip>{' '}
                    <span className="small muted">{n.repo}</span>{' '}
                    <Link
                      to={n.subject.url}
                      onClick={() => n.unread && mark(n.id, { read: true })}
                    >
                      {n.unread ? <strong>{n.subject.title}</strong> : n.subject.title}
                      {n.subject.number === null ? '' : ` #${n.subject.number}`}
                    </Link>{' '}
                    <span className="small muted">
                      {n.actor ? `${data.names[n.actor] ?? n.actor} · ` : ''}
                      {formatRelative(n.created_at)}
                    </span>
                  </span>
                  <span className="row">
                    <button onClick={() => mark(n.id, { read: !n.unread })}>
                      {n.unread ? 'Mark read' : 'Mark unread'}
                    </button>
                    {state !== 'done' ? (
                      <button
                        aria-label={`Done: ${n.subject.title}`}
                        onClick={() => mark(n.id, { done: true })}
                      >
                        Done
                      </button>
                    ) : (
                      <button onClick={() => mark(n.id, { done: false })}>
                        Move to inbox
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      <EmailSettings />
    </>
  );
}

function EmailSettings(): ReactElement {
  const [data, setData] = useState<Settings | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    call<Settings>('/notifications/settings')
      .then(setData)
      .catch((err) => setError(asApiError(err)));
  }, []);

  const save = async (patch: Partial<Settings['settings']>): Promise<void> => {
    setError(null);
    setNotice('');
    try {
      setData(await call<Settings>('/notifications/settings', 'PUT', patch));
      setNotice('Saved.');
    } catch (err) {
      setError(asApiError(err));
    }
  };

  if (!data) return error ? <ErrorNotice error={error} /> : <Loading />;
  const s = data.settings;
  return (
    <section className="panel stack">
      <h2>Email</h2>
      {!data.email_available && (
        <p className="small muted">This forge is not set up to send email yet.</p>
      )}
      <p className="small muted">
        {data.email_address
          ? `Sent to ${data.email_address}.`
          : 'No verified email address is linked to your account.'}
      </p>
      {error && <ErrorNotice error={error} />}
      {notice && <p role="status">{notice}</p>}
      <Field label="Notification email">
        <select
          value={s.email}
          onChange={(e) =>
            void save({ email: e.target.value as Settings['settings']['email'] })
          }
        >
          <option value="instant">Each notification</option>
          <option value="digest">Daily digest</option>
          <option value="off">Off</option>
        </select>
      </Field>
      {s.email === 'digest' && (
        <>
          <Field label={`Digest hour (${data.digest_time_zone})`}>
            <select
              value={s.digest_hour}
              onChange={(e) => void save({ digest_hour: Number(e.target.value) })}
            >
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {`${String(h).padStart(2, '0')}:00`}
                </option>
              ))}
            </select>
          </Field>
          <label className="row">
            <input
              type="checkbox"
              checked={s.skip_weekends}
              onChange={(e) => void save({ skip_weekends: e.target.checked })}
            />
            No digest on weekends
          </label>
        </>
      )}
      <fieldset className="stack">
        <legend>Notify me about</legend>
        {Object.entries(s.reasons).map(([reason, on]) => (
          <label key={reason} className="row">
            <input
              type="checkbox"
              checked={on}
              onChange={(e) => void save({ reasons: { [reason]: e.target.checked } })}
            />
            {REASON_LABEL[reason] ?? reason}
          </label>
        ))}
      </fieldset>
    </section>
  );
}
