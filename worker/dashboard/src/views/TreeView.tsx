import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  api,
  asApiError,
  rawFileUrl,
  type ApiError,
  type BlameRange,
  type FileContent,
  type TreeEntry,
} from '../api';
import { tokenize, languageOf, type Token } from '../highlight';
import { usePolling } from '../hooks';
import { useSlug } from '../slug';
import {
  Empty,
  ErrorNotice,
  Loading,
  RefPicker,
  authorLabel,
  formatBytes,
  shortId,
} from '../ui';

// ---------------------------------------------------------------------------
// File rendering helpers
// ---------------------------------------------------------------------------

function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8192);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

/** Distribute whole-file tokens into per-line token rows. */
function tokensToLines(tokens: Token[]): Token[][] {
  const lines: Token[][] = [[]];
  for (const tok of tokens) {
    const parts = tok.text.split('\n');
    parts.forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (part !== '') lines[lines.length - 1].push({ text: part, cls: tok.cls });
    });
  }
  return lines;
}

const MAX_RENDER_LINES = 5_000;

/** Per-line blame attribution map (1-based ranges from the blame RPC). */
function blameByLine(ranges: BlameRange[], lineCount: number): (BlameRange | null)[] {
  const map: (BlameRange | null)[] = new Array(lineCount).fill(null);
  for (const range of ranges) {
    for (let line = range.start; line <= range.end; line++) {
      if (line >= 1 && line <= lineCount) map[line - 1] = range;
    }
  }
  return map;
}

function BlameGutterCell({
  range,
  slug,
  onHover,
}: {
  range: BlameRange | null;
  slug: string;
  onHover: (range: BlameRange | null) => void;
}): ReactElement {
  if (!range) return <td className="bl" />;
  const tip = `${authorLabel(range.author)}: ${range.message ?? '(no message)'}`;
  return (
    <td className="bl" title={tip}>
      <Link
        to={`/r/${slug}/cs/${range.cs}`}
        onMouseEnter={() => onHover(range)}
        onMouseLeave={() => onHover(null)}
      >
        {shortId(range.cs)}
      </Link>
    </td>
  );
}

function FileView({
  slug,
  cs,
  path,
  file,
}: {
  slug: string;
  cs: string;
  path: string;
  file: FileContent;
}): ReactElement {
  const bytes = useMemo(() => decodeBase64(file.content_b64), [file]);
  const binary = useMemo(() => looksBinary(bytes), [bytes]);
  const text = useMemo(
    () => (binary ? '' : new TextDecoder('utf-8').decode(bytes)),
    [bytes, binary],
  );
  const lines = useMemo(
    () => tokensToLines(tokenize(text, languageOf(path))),
    [text, path],
  );

  // Blame: cold responses are 202 {status:'computing'} — poll until complete.
  const [blameDisabled, setBlameDisabled] = useState(false);
  const {
    data: blame,
    error: blameError,
    refresh: refreshBlame,
  } = usePolling(
    () => api.getBlame(slug, { cs, path, annotate: true }),
    4000,
    !binary && !blameDisabled,
  );

  useEffect(() => {
    if (blame?.complete) setBlameDisabled(true);
  }, [blame]);

  const retryBlame = useCallback(() => {
    setBlameDisabled(false);
    refreshBlame();
  }, [refreshBlame]);

  const [hovered, setHovered] = useState<BlameRange | null>(null);
  const attribution = useMemo(
    () => (blame ? blameByLine(blame.ranges, lines.length) : []),
    [blame, lines.length],
  );

  if (binary) {
    return (
      <div className="panel">
        <div className="row between">
          <span className="mono">{path}</span>
          <a className="btn" href={rawFileUrl(slug, cs, path)}>
            Download raw ({formatBytes(file.size)})
          </a>
        </div>
        <div className="notice info">Binary file — showing metadata only.</div>
      </div>
    );
  }

  return (
    <div>
      <div className="row between">
        <span className="small muted">
          {formatBytes(file.size)} · blob <code>{shortId(file.blob_sha256)}</code>
          {blame && !blame.complete ? ' · blame computing…' : ''}
          {blameDisabled && blame?.complete ? ' · blame complete' : ''}
        </span>
        <span className="row">
          {blameError && <button onClick={retryBlame}>Retry blame</button>}
          <a className="btn" href={rawFileUrl(slug, cs, path)}>
            Raw
          </a>
        </span>
      </div>
      {blameError && (
        <div className="notice warn small">
          Blame unavailable ({blameError.code}) — showing source without attribution.
          {blameError.deniedBy && (
            <span>
              {' '}
              Denied by rule <code>#{blameError.deniedBy.id}</code> on{' '}
              <code>{blameError.deniedBy.path_prefix}</code>.
            </span>
          )}
        </div>
      )}
      <div className="notice info small blame-detail">
        {hovered ? (
          <span>
            <code>{shortId(hovered.cs)}</code> — {authorLabel(hovered.author)}:{' '}
            {hovered.message ?? '(no message)'}{' '}
            <Link to={`/r/${slug}/cs/${hovered.cs}`}>open changeset →</Link>
          </span>
        ) : (
          <span className="muted">
            Hover a blame gutter entry for message/author; click to open the changeset.
          </span>
        )}
      </div>
      <div className="file-view">
        <table className="file-table">
          <tbody>
            {lines.slice(0, MAX_RENDER_LINES).map((tokens, i) => (
              <tr
                key={i}
                className={hovered && attribution[i] === hovered ? 'hovered' : ''}
              >
                <td className="ln">{i + 1}</td>
                <BlameGutterCell
                  range={attribution[i] ?? null}
                  slug={slug}
                  onHover={setHovered}
                />
                <td className="src">
                  {tokens.map((tok, j) => (
                    <span key={j} className={tok.cls ?? undefined}>
                      {tok.text}
                    </span>
                  ))}
                  {tokens.length === 0 ? '\u00a0' : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {lines.length > MAX_RENDER_LINES && (
          <div className="notice warn small">
            File has {lines.length} lines — rendering the first {MAX_RENDER_LINES}.
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tree browser
// ---------------------------------------------------------------------------

interface TreeState {
  entries: TreeEntry[];
  path: string;
}

export function TreeView(): ReactElement {
  const slug = useSlug();
  const params = useParams();
  const cs = params.cs ?? '';
  const path = params['*'] ?? '';
  const navigate = useNavigate();
  const { data: refs } = usePolling(() => api.listRefs(slug), 60_000);

  const [tree, setTree] = useState<TreeState | null>(null);
  const [file, setFile] = useState<FileContent | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    setTree(null);
    setFile(null);
    api
      .getTree(slug, { cs, path, recursive: false })
      .then((result) => {
        setTree(result);
        setLoading(false);
      })
      .catch((err: unknown) => {
        const apiErr = asApiError(err);
        if (apiErr.code === 'not_a_tree') {
          return api
            .getFile(slug, { cs, path })
            .then((content) => {
              setFile(content);
              setLoading(false);
            })
            .catch((fileErr: unknown) => {
              setError(asApiError(fileErr));
              setLoading(false);
            });
        }
        setError(apiErr);
        setLoading(false);
        return undefined;
      });
  }, [slug, cs, path]);

  useEffect(() => {
    load();
  }, [load]);

  const segments = path === '' ? [] : path.split('/');
  // ref names contain slashes, so the revision is one encoded route segment
  const base = `/r/${slug}/tree/${encodeURIComponent(cs)}`;
  const switchRef = (name: string): void => {
    const target = encodeURIComponent(`ref:${name}`);
    navigate(`/r/${slug}/tree/${target}${path === '' ? '' : `/${path}`}`);
  };

  return (
    <div>
      <div className="small muted">
        <Link to={`/r/${slug}`}>{slug}</Link>
      </div>
      <div className="crumb" style={{ margin: '4px 0 14px' }}>
        <Link to={base}>root</Link>
        {segments.map((seg, i) => {
          const sub = segments.slice(0, i + 1).join('/');
          return (
            <span key={sub} className="row" style={{ gap: 6 }}>
              <span className="sep">/</span>
              <Link to={`${base}/${sub}`}>{seg}</Link>
            </span>
          );
        })}
        {refs && refs.length > 0 ? (
          <RefPicker
            refs={refs}
            value={cs.startsWith('ref:') ? cs.slice('ref:'.length) : cs}
            onChange={switchRef}
          />
        ) : (
          <span className="faint small mono">@ {shortId(cs)}</span>
        )}
      </div>

      {error && <ErrorNotice error={error} />}
      {error && error.code === 'file_too_large' && (
        <div className="row">
          <a className="btn" href={rawFileUrl(slug, cs, path)}>
            Download raw
          </a>
        </div>
      )}
      {loading && <Loading label="Loading tree…" />}

      {tree && (
        <div className="panel tight">
          {tree.entries.length === 0 ? (
            <Empty>Empty directory.</Empty>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>Name</th>
                  <th>Size</th>
                  <th>Hash</th>
                </tr>
              </thead>
              <tbody>
                {tree.entries
                  .slice()
                  .sort((a, b) =>
                    a.kind === b.kind
                      ? (a.name ?? '').localeCompare(b.name ?? '')
                      : a.kind === 'tree'
                        ? -1
                        : 1,
                  )
                  .map((entry) => {
                    const entryPath =
                      path === '' ? (entry.name ?? '') : `${path}/${entry.name ?? ''}`;
                    return (
                      <tr key={entryPath}>
                        <td>
                          <span className={`chip ${entry.kind === 'tree' ? 'info' : ''}`}>
                            {entry.kind}
                          </span>
                        </td>
                        <td className="mono">
                          <Link to={`${base}/${entryPath}`}>
                            {entry.name}
                            {entry.kind === 'tree' ? '/' : ''}
                          </Link>
                        </td>
                        <td className="small muted">
                          {entry.kind === 'blob' ? formatBytes(entry.size) : ''}
                        </td>
                        <td className="small muted mono">{shortId(entry.hash)}</td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {file && (
        <FileView key={`${cs}:${path}`} slug={slug} cs={cs} path={path} file={file} />
      )}
    </div>
  );
}
