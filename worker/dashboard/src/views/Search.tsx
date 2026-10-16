import { useEffect, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { asApiError, type ApiError } from '../api';
import { call } from '../collaboration';
import { Empty, ErrorNotice, Field, Loading, formatBytes } from '../ui';

interface CodeMatch {
  line: number;
  text: string;
  ranges: [number, number][];
}
interface CodeResult {
  repo: string;
  path: string;
  lang: string | null;
  cs: string;
  matches: CodeMatch[];
}
interface CodeResponse {
  results: CodeResult[];
  truncated: boolean;
  partial: boolean;
  skipped_repos: { repo: string; reason: string }[];
}
interface PathResult {
  repo: string;
  path: string;
  lang: string | null;
  size: number;
  cs: string;
}
interface PathResponse {
  files: PathResult[];
  truncated: boolean;
}

const FIELDS = ['q', 'repo', 'path', 'lang', 'rev'] as const;
type FieldName = (typeof FIELDS)[number];

function treeLink(repo: string, cs: string, path: string): string {
  return `/r/${repo}/tree/${encodeURIComponent(cs)}/${path}`;
}

/** A line with each match range wrapped in `<mark>`. */
function Highlighted({ match }: { match: CodeMatch }): ReactElement {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [start, end] of match.ranges) {
    if (start < at) continue;
    parts.push(match.text.slice(at, start));
    parts.push(<mark key={start}>{match.text.slice(start, end)}</mark>);
    at = end;
  }
  parts.push(match.text.slice(at));
  return <code>{parts}</code>;
}

/**
 * Code search and file finder (issue #45) across every repo the viewer can
 * read. The query lives in the URL so a search can be shared or reloaded.
 */
export function SearchView(): ReactElement {
  const [params, setParams] = useSearchParams();
  const mode = params.get('mode') === 'files' ? 'files' : 'code';
  const [draft, setDraft] = useState(
    () =>
      Object.fromEntries(FIELDS.map((f) => [f, params.get(f) ?? ''])) as Record<
        FieldName,
        string
      >,
  );
  const [regex, setRegex] = useState(params.get('regex') === '1');
  const [matchCase, setMatchCase] = useState(params.get('case') === '1');
  const [code, setCode] = useState<CodeResponse | null>(null);
  const [files, setFiles] = useState<PathResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);
  const query = params.toString();

  useEffect(() => {
    const current = new URLSearchParams(query);
    if ((current.get('q') ?? '') === '') return;
    let cancelled = false;
    current.delete('mode');
    if (mode === 'files') {
      current.delete('regex');
      current.delete('case');
    }
    setLoading(true);
    setError(null);
    const request =
      mode === 'files'
        ? call<PathResponse>(`/search/paths?${current}`).then((r) => {
            if (!cancelled) setFiles(r);
          })
        : call<CodeResponse>(`/search/code?${current}`).then((r) => {
            if (!cancelled) setCode(r);
          });
    request
      .catch((err) => !cancelled && setError(asApiError(err)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [query, mode]);

  const submit = (e: { preventDefault(): void }, nextMode = mode): void => {
    e.preventDefault();
    const next = new URLSearchParams();
    for (const f of FIELDS) if (draft[f].trim() !== '') next.set(f, draft[f].trim());
    if (nextMode === 'files') next.set('mode', 'files');
    else {
      if (regex) next.set('regex', '1');
      if (matchCase) next.set('case', '1');
    }
    setCode(null);
    setFiles(null);
    setParams(next);
  };
  const set = (field: FieldName, value: string): void =>
    setDraft((d) => ({ ...d, [field]: value }));

  return (
    <>
      <h1>Search</h1>
      <form className="panel stack" onSubmit={submit}>
        <div className="row">
          <button
            type="button"
            className={mode === 'code' ? 'primary' : ''}
            onClick={(e) => submit(e, 'code')}
          >
            Code
          </button>
          <button
            type="button"
            className={mode === 'files' ? 'primary' : ''}
            onClick={(e) => submit(e, 'files')}
          >
            Files
          </button>
        </div>
        <Field label={mode === 'files' ? 'File name or path' : 'Search text'}>
          <input
            type="search"
            value={draft.q}
            onChange={(e) => set('q', e.target.value)}
            maxLength={200}
            autoFocus
          />
        </Field>
        <div className="row">
          <Field label="Repository">
            <input
              type="text"
              placeholder="owner/name"
              value={draft.repo}
              onChange={(e) => set('repo', e.target.value)}
            />
          </Field>
          <Field label="Path">
            <input
              type="text"
              placeholder="src/ or **/*.ts"
              value={draft.path}
              onChange={(e) => set('path', e.target.value)}
            />
          </Field>
          <Field label="Language">
            <input
              type="text"
              placeholder="typescript"
              value={draft.lang}
              onChange={(e) => set('lang', e.target.value)}
            />
          </Field>
          <Field label="Revision">
            <input
              type="text"
              placeholder="default branch"
              value={draft.rev}
              onChange={(e) => set('rev', e.target.value)}
            />
          </Field>
        </div>
        {mode === 'code' && (
          <div className="row">
            <label>
              <input
                type="checkbox"
                checked={regex}
                onChange={(e) => setRegex(e.target.checked)}
              />{' '}
              Regular expression
            </label>
            <label>
              <input
                type="checkbox"
                checked={matchCase}
                onChange={(e) => setMatchCase(e.target.checked)}
              />{' '}
              Match case
            </label>
          </div>
        )}
        <div className="row">
          <button type="submit" className="primary">
            Search
          </button>
          <span className="small muted">
            Regular expressions: up to 200 characters, no nested quantifiers, the first
            1000 characters of each line. Files over 1 MiB are found by name only.
          </span>
        </div>
      </form>
      {error && <ErrorNotice error={error} />}
      {loading && <Loading label="Searching…" />}
      {mode === 'code' && code && !loading && <CodeResults data={code} />}
      {mode === 'files' && files && !loading && <FileResults data={files} />}
    </>
  );
}

function CodeResults({ data }: { data: CodeResponse }): ReactElement {
  return (
    <section className="panel stack">
      {data.partial && (
        <p className="notice small">
          Some files are still being indexed and were not all read. Results may be
          missing.
        </p>
      )}
      {data.skipped_repos.length > 0 && (
        <p className="notice small">
          Not searched (too large): {data.skipped_repos.map((s) => s.repo).join(', ')}
        </p>
      )}
      {data.results.length === 0 ? (
        <Empty>No matches.</Empty>
      ) : (
        <ul className="history-list">
          {data.results.map((r) => (
            <li key={`${r.repo}:${r.path}`} className="stack">
              <span>
                <span className="muted">{r.repo}</span>{' '}
                <Link to={treeLink(r.repo, r.cs, r.path)}>{r.path}</Link>
                {r.lang && <span className="small muted"> · {r.lang}</span>}
              </span>
              <ol className="mono small">
                {r.matches.map((m) => (
                  <li key={m.line} value={m.line}>
                    <Highlighted match={m} />
                  </li>
                ))}
              </ol>
            </li>
          ))}
        </ul>
      )}
      {data.truncated && (
        <p className="small muted">More files match. Narrow the search to see them.</p>
      )}
    </section>
  );
}

function FileResults({ data }: { data: PathResponse }): ReactElement {
  return (
    <section className="panel">
      {data.files.length === 0 ? (
        <Empty>No files.</Empty>
      ) : (
        <ul className="history-list">
          {data.files.map((f) => (
            <li key={`${f.repo}:${f.path}`}>
              <span className="muted">{f.repo}</span>{' '}
              <Link to={treeLink(f.repo, f.cs, f.path)}>{f.path}</Link>{' '}
              <span className="small muted">{formatBytes(f.size)}</span>
            </li>
          ))}
        </ul>
      )}
      {data.truncated && (
        <p className="small muted">More files match. Narrow the search to see them.</p>
      )}
    </section>
  );
}
