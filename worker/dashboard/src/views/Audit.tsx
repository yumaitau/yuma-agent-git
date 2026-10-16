import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { Link, useParams } from 'react-router-dom';
import { asApiError, type ApiError } from '../api';
import { call } from '../collaboration';
import { Empty, ErrorNotice, Field, Loading, formatTime } from '../ui';

interface AuditEvent {
  id: number;
  repo_id: string | null;
  actor_kind: string;
  actor_id: string;
  on_behalf_of: string | null;
  action: string;
  target: unknown;
  ip: string | null;
  at: number;
}

interface Filters {
  action: string;
  actor: string;
  repo: string;
  from: string;
  to: string;
}

const NO_FILTERS: Filters = { action: '', actor: '', repo: '', from: '', to: '' };

function queryOf(filters: Filters): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value.trim()) params.set(key, value.trim());
  }
  return params;
}

/**
 * An organisation's audit log (issue #65), newest first, for org owners and
 * admins. Filters match the API; exports download every match as NDJSON or
 * CSV, oldest first, for `yag audit verify` or a spreadsheet.
 */
export function AuditView(): ReactElement {
  const { org = '' } = useParams();
  const [draft, setDraft] = useState<Filters>(NO_FILTERS);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const base = `/orgs/${encodeURIComponent(org)}/audit`;

  const page = async (after: number | null): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const params = queryOf(filters);
      if (after !== null) params.set('cursor', String(after));
      const res = await call<{ events: AuditEvent[]; next_cursor: number | null }>(
        `${base}?${params}`,
      );
      setEvents((prev) =>
        after === null ? res.events : [...(prev ?? []), ...res.events],
      );
      setCursor(res.next_cursor);
    } catch (err) {
      setError(asApiError(err));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    setEvents(null);
    void page(null);
  }, [base, filters]);

  const exportQuery = queryOf(filters);
  const set =
    (key: keyof Filters) =>
    (e: { target: { value: string } }): void =>
      setDraft({ ...draft, [key]: e.target.value });

  return (
    <>
      <Link className="small muted" to={`/orgs/${org}`}>
        {org}
      </Link>
      <h1>Audit log</h1>
      <form
        className="row"
        aria-label="Filter audit events"
        onSubmit={(e) => {
          e.preventDefault();
          setFilters(draft);
        }}
      >
        <Field label="Action">
          <input
            type="text"
            placeholder="ruleset.update"
            value={draft.action}
            onChange={set('action')}
          />
        </Field>
        <Field label="Actor ID">
          <input type="text" value={draft.actor} onChange={set('actor')} />
        </Field>
        <Field label="Repository ID">
          <input type="text" value={draft.repo} onChange={set('repo')} />
        </Field>
        <Field label="From (UTC)">
          <input type="date" value={draft.from} onChange={set('from')} />
        </Field>
        <Field label="Before (UTC)">
          <input type="date" value={draft.to} onChange={set('to')} />
        </Field>
        <button className="primary" disabled={busy}>
          Filter
        </button>
      </form>
      <p className="small">
        Export every match:{' '}
        {(['ndjson', 'csv'] as const).map((format, i) => {
          const params = new URLSearchParams(exportQuery);
          params.set('format', format);
          return (
            <span key={format}>
              {i > 0 && ' · '}
              <a href={`/api/v1${base}?${params}`} download>
                {format.toUpperCase()}
              </a>
            </span>
          );
        })}
      </p>
      {error && <ErrorNotice error={error} />}
      {events === null && !error && <Loading />}
      {events?.length === 0 && <Empty>No audit events match these filters.</Empty>}
      {events && events.length > 0 && (
        <div className="table-scroll">
          <table>
            <caption className="small muted">
              {events.length} event{events.length === 1 ? '' : 's'}, newest first
            </caption>
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Actor</th>
                <th scope="col">Action</th>
                <th scope="col">Repository</th>
                <th scope="col">Target</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.id}>
                  <td className="small mono">{formatTime(event.at)}</td>
                  <td className="small">
                    {event.actor_kind}:{event.actor_id}
                    {event.on_behalf_of && (
                      <div className="muted">for {event.on_behalf_of}</div>
                    )}
                  </td>
                  <td>
                    <code>{event.action}</code>
                  </td>
                  <td className="small mono">{event.repo_id ?? 'org'}</td>
                  <td className="small mono wrap-any">
                    {typeof event.target === 'string'
                      ? event.target
                      : JSON.stringify(event.target)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {cursor !== null && (
        <button disabled={busy} onClick={() => void page(cursor)}>
          Load older events
        </button>
      )}
    </>
  );
}
