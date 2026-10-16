import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { asApiError, type ApiError } from '../api';
import { call } from '../collaboration';
import { Chip, Empty, ErrorNotice, formatRelative, Loading, shortId } from '../ui';
import { RepoNav } from './Collaboration';

interface Entry {
  id: string;
  pull_id: number;
  number: number;
  title: string;
  state: 'queued' | 'testing' | 'merged' | 'ejected' | 'dequeued';
  priority: number;
  method: string;
  reason: string | null;
  enqueued_at: number;
  updated_at: number;
}

interface Group {
  id: string;
  mode: 'strict' | 'optimistic';
  state: string;
  base_cs: string;
  head_cs: string;
  revert_cs: string | null;
  reason: string | null;
  pull_ids: number[];
  created_at: number;
}

interface Queue {
  base_ref: string;
  enabled: boolean;
  mode: 'strict' | 'optimistic' | null;
  max_batch: number | null;
  entries: Entry[];
  groups: Group[];
}

const ENTRY_CHIP: Record<Entry['state'], 'ok' | 'warn' | 'danger' | 'info'> = {
  queued: 'info',
  testing: 'warn',
  merged: 'ok',
  ejected: 'danger',
  dequeued: 'warn',
};

const GROUP_CHIP: Record<string, 'ok' | 'warn' | 'danger' | 'info'> = {
  testing: 'warn',
  landing: 'info',
  landed: 'info',
  merged: 'ok',
  failed: 'danger',
  cancelled: 'warn',
  reverting: 'danger',
  reverted: 'danger',
};

/**
 * Merge queue of one branch (issue #43): pull requests in landing order,
 * their results, and the merge groups the queue built and tested.
 */
export function MergeQueueView(): ReactElement {
  const { owner, name } = useParams();
  const slug = `${owner ?? ''}/${name ?? ''}`;
  const [params, setParams] = useSearchParams();
  const ref = params.get('ref') ?? '';
  const [queue, setQueue] = useState<Queue | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    call<Queue>(
      `/repos/${slug}/merge-queue${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`,
    )
      .then((q) => !cancelled && setQueue(q))
      .catch((err) => !cancelled && setError(asApiError(err)));
    return () => {
      cancelled = true;
    };
  }, [slug, ref, nonce]);

  const remove = async (entry: Entry): Promise<void> => {
    setError(null);
    try {
      await call(`/repos/${slug}/pulls/${entry.pull_id}/queue`, 'DELETE');
      refresh();
    } catch (err) {
      setError(asApiError(err));
    }
  };

  const numberOf = (id: number): string => {
    const entry = queue?.entries.find((e) => e.pull_id === id);
    return entry ? `#${entry.number}` : `pull ${id}`;
  };
  const active = queue?.entries.filter((e) => ['queued', 'testing'].includes(e.state));
  const done = queue?.entries.filter((e) => !['queued', 'testing'].includes(e.state));

  return (
    <>
      <RepoNav active="Merge queue" />
      <div className="row between">
        <h1>Merge queue{queue ? ` for ${queue.base_ref}` : ''}</h1>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            const value = new FormData(e.currentTarget).get('ref');
            setParams(typeof value === 'string' && value ? { ref: value } : {});
          }}
        >
          <input name="ref" aria-label="Branch" placeholder="Branch" defaultValue={ref} />
          <button type="submit">Show</button>
        </form>
      </div>
      {error && <ErrorNotice error={error} />}
      {!queue && !error && <Loading />}
      {queue && (
        <>
          <p className="small muted">
            {queue.enabled ? (
              <>
                <Chip kind="ok">on</Chip> {queue.mode} mode, up to {queue.max_batch} pull
                requests per group.{' '}
                {queue.mode === 'strict'
                  ? 'Each group is tested before it lands.'
                  : 'Groups land at once; a failed check reverts them.'}
              </>
            ) : (
              <>
                <Chip kind="warn">off</Chip> Add a <code>merge_queue</code> rule to a
                branch ruleset to turn the queue on.
              </>
            )}
          </p>

          <section className="panel">
            <h2>Queued</h2>
            {active!.length === 0 && <Empty>No pull requests are waiting.</Empty>}
            {active!.length > 0 && (
              <ol className="history-list">
                {active!.map((e) => (
                  <li key={e.id} className="row between">
                    <span>
                      <Link to={`/r/${slug}/pulls/${e.pull_id}`}>
                        #{e.number} {e.title}
                      </Link>{' '}
                      <Chip kind={ENTRY_CHIP[e.state]}>{e.state}</Chip>{' '}
                      {e.priority > 0 && <Chip kind="info">priority {e.priority}</Chip>}{' '}
                      <span className="small muted">
                        {e.method} · queued {formatRelative(e.enqueued_at)}
                      </span>
                    </span>
                    <button onClick={() => void remove(e)}>Remove #{e.number}</button>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section className="panel">
            <h2>Merge groups</h2>
            {queue.groups.length === 0 && <Empty>No groups yet.</Empty>}
            {queue.groups.length > 0 && (
              <ul className="history-list">
                {queue.groups.map((g) => (
                  <li key={g.id}>
                    <Chip kind={GROUP_CHIP[g.state] ?? 'default'}>{g.state}</Chip>{' '}
                    {g.pull_ids.map(numberOf).join(', ')}{' '}
                    <span className="small muted">
                      <code>{shortId(g.base_cs)}</code> to{' '}
                      <code>{shortId(g.head_cs)}</code>
                      {g.revert_cs && (
                        <>
                          {' '}
                          · reverted in <code>{shortId(g.revert_cs)}</code>
                        </>
                      )}{' '}
                      · {formatRelative(g.created_at)}
                      {g.reason ? ` · ${g.reason}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="panel">
            <h2>Recent results</h2>
            {done!.length === 0 && <Empty>Nothing has left the queue yet.</Empty>}
            {done!.length > 0 && (
              <ul className="history-list">
                {done!.map((e) => (
                  <li key={e.id}>
                    <Link to={`/r/${slug}/pulls/${e.pull_id}`}>
                      #{e.number} {e.title}
                    </Link>{' '}
                    <Chip kind={ENTRY_CHIP[e.state]}>{e.state}</Chip>{' '}
                    <span className="small muted">
                      {formatRelative(e.updated_at)}
                      {e.reason ? ` · ${e.reason}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </>
  );
}
