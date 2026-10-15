import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, asApiError, type ApiError, type Changeset, type DiffResult } from '../api';
import { DiffView } from '../DiffView';
import { useSlug } from '../slug';
import { Empty, ErrorNotice, Field, Loading, shortId } from '../ui';

/** `/r/:slug/diff?from=&to=` — revision pickers fed by the history RPC. */
export function DiffExplorerView(): ReactElement {
  const slug = useSlug();
  const [searchParams, setSearchParams] = useSearchParams();
  const fromParam = searchParams.get('from') ?? '';
  const toParam = searchParams.get('to') ?? 'main';
  const mode = searchParams.get('mode') === 'direct' ? 'direct' : 'merge-base';

  const [from, setFrom] = useState(fromParam);
  const [to, setTo] = useState(toParam);
  const [history, setHistory] = useState<Changeset[]>([]);
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api
      .getHistory(slug, { cs: 'main', limit: 50 })
      .then((h) => setHistory(h.changesets))
      .catch(() => setHistory([]));
  }, [slug]);

  const compare = useCallback(
    (nextFrom: string, nextTo: string, nextMode: string) => {
      const params: Record<string, string> = {};
      if (nextFrom !== '') params.from = nextFrom;
      if (nextTo !== '') params.to = nextTo;
      if (nextMode === 'direct') params.mode = 'direct';
      setSearchParams(params);
    },
    [setSearchParams],
  );

  useEffect(() => {
    setFrom(fromParam);
    setTo(toParam);
  }, [fromParam, toParam]);

  useEffect(() => {
    if (fromParam === '' || toParam === '') {
      setDiff(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getDiff(slug, { from: fromParam, to: toParam, text: true, mode })
      .then((d) => {
        if (cancelled) return;
        setDiff(d);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(asApiError(err));
        setDiff(null);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug, fromParam, toParam, mode]);

  const picker = (value: string, onChange: (v: string) => void): ReactElement => (
    <>
      <input
        type="text"
        list="diff-history"
        placeholder="changeset id or ref (e.g. main)"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </>
  );

  return (
    <div>
      <div className="small muted">Diff explorer</div>
      <h1 className="mono" style={{ marginTop: 4 }}>
        {slug}
      </h1>

      <datalist id="diff-history">
        {history.map((cs) => (
          <option key={cs.id} value={cs.id}>
            {cs.message.split('\n')[0].slice(0, 60)}
          </option>
        ))}
      </datalist>

      <form
        className="panel row"
        style={{ alignItems: 'flex-end' }}
        onSubmit={(e) => {
          e.preventDefault();
          compare(from.trim(), to.trim(), mode);
        }}
      >
        <Field label="From">{picker(from, setFrom)}</Field>
        <Field label="To">{picker(to, setTo)}</Field>
        <Field label="Mode">
          <select
            value={mode}
            onChange={(e) => compare(from.trim(), to.trim(), e.target.value)}
          >
            <option value="merge-base">merge-base (three-dot)</option>
            <option value="direct">direct (two-dot)</option>
          </select>
        </Field>
        <button type="submit" className="primary">
          Compare
        </button>
      </form>

      {error && <ErrorNotice error={error} />}
      {loading && <Loading label="Computing diff…" />}

      {diff ? (
        <>
          <div className="panel tight small muted">
            <span className="row">
              <span className="mono">merge base: {shortId(diff.merge_base)}</span>
              <span>
                <code>{shortId(diff.from)}</code> → <code>{shortId(diff.to)}</code>
              </span>
              <span>
                {diff.files.length} files {diff.truncated ? '· truncated' : ''}
              </span>
            </span>
            {diff.texts_truncated && (
              <div className="notice warn" style={{ marginBottom: 0 }}>
                {diff.texts_hint ?? 'text diffs truncated'} — use the tree view for
                individual files.
              </div>
            )}
          </div>
          {diff.files.length === 0 ? (
            <Empty>No differences between these revisions.</Empty>
          ) : (
            <DiffView files={diff.files} texts={diff.texts} />
          )}
        </>
      ) : (
        !loading && (
          <Empty>
            Pick two revisions and press Compare. Revisions accept ref names (
            <code>main</code>) or full changeset ids.
          </Empty>
        )
      )}
    </div>
  );
}
