import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  api,
  asApiError,
  type AgentProvenance,
  type ApiError,
  type Changeset,
  type DiffResult,
  type FileChange,
  type SourceProvenance,
} from '../api';
import { DiffView } from '../DiffView';
import { useSlug } from '../slug';
import {
  Empty,
  ErrorNotice,
  Loading,
  authorLabel,
  formatBytes,
  formatTime,
  shortId,
} from '../ui';

const OP_CHIP: Record<FileChange['op'], string> = {
  add: 'ok',
  del: 'danger',
  mod: 'info',
};

/** "Codex on behalf of justin, task #42" for changesets an agent token wrote. */
function agentLine(p: AgentProvenance): string {
  const task = p.task_id ? `, task #${p.task_id}` : '';
  return `${p.agent_name ?? p.agent_id} on behalf of ${p.on_behalf_of_login ?? p.on_behalf_of}${task}`;
}

/** Signature, signed provenance and agent sessions (#58), when there are any. */
function SourceFacts({
  slug,
  facts,
}: {
  slug: string;
  facts: SourceProvenance;
}): ReactElement {
  const { signature, records, sessions } = facts;
  const verified = records.filter((r) => r.verified);
  return (
    <>
      {signature && (
        <>
          <span className="k">Signature</span>
          <span>
            {signature.status === 'verified' ? (
              <span className="chip ok">Verified</span>
            ) : signature.status === 'unverified' ? (
              <span className="chip warn">Unverified</span>
            ) : (
              <span className="chip">Unsigned</span>
            )}{' '}
            <span className="small muted">
              {[
                signature.format,
                signature.user_login ?? signature.signer,
                signature.status === 'unverified' ? signature.reason : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </span>
        </>
      )}
      {records.length > 0 && (
        <>
          <span className="k">Provenance</span>
          <span>
            {verified.length > 0 ? (
              <span className="chip ok">Signed provenance</span>
            ) : (
              <span className="chip danger">Provenance does not verify</span>
            )}{' '}
            <span className="small muted">
              {records
                .map(
                  (r) => `${r.ref} via ${r.via}${r.bypass ? ' (ruleset bypassed)' : ''}`,
                )
                .join(', ')}
            </span>
          </span>
        </>
      )}
      {sessions.length > 0 && (
        <>
          <span className="k">Sessions</span>
          <span>
            {sessions.map((s) => (
              <div key={s.id} className="small">
                {[s.model, s.harness].filter(Boolean).join(', ') || 'agent session'}
                {s.task_id ? `, task ${s.task_id}` : ''}{' '}
                {s.transcript_available && (
                  <a href={`/api/v1/repos/${slug}/sessions/${s.id}/transcript`}>
                    transcript
                  </a>
                )}
              </div>
            ))}
          </span>
        </>
      )}
    </>
  );
}

export function ChangesetView(): ReactElement {
  const slug = useSlug();
  const { id = '' } = useParams();
  const [changeset, setChangeset] = useState<Changeset | null>(null);
  const [provenance, setProvenance] = useState<AgentProvenance | null>(null);
  const [facts, setFacts] = useState<SourceProvenance | null>(null);
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setChangeset(null);
    setDiff(null);
    setFacts(null);
    // best-effort: signatures and provenance never block the changeset itself
    api
      .getProvenance(slug, id)
      .then((p) => {
        if (!cancelled && Array.isArray(p.records)) setFacts(p);
      })
      .catch(() => undefined);
    api
      .getChangeset(slug, id)
      .then((cs) => {
        if (cancelled) return;
        setChangeset(cs);
        setProvenance(cs.provenance);
        if (cs.first_parent) {
          return api
            .getDiff(slug, {
              from: cs.first_parent,
              to: cs.id,
              text: true,
              mode: 'direct',
            })
            .then((d) => {
              if (!cancelled) setDiff(d);
            })
            .catch(() => undefined); // diff is best-effort; the file list stands
        }
        return undefined;
      })
      .catch((err) => {
        if (!cancelled) setError(asApiError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [slug, id]);

  if (error) return <ErrorNotice error={error} />;
  if (!changeset) return <Loading label="Loading changeset…" />;

  return (
    <div>
      <div className="small muted">
        <Link to={`/r/${slug}`}>{slug}</Link> / changeset
      </div>
      <h1 className="mono" style={{ marginTop: 4 }}>
        {shortId(changeset.id)}
      </h1>
      <div className="panel">
        <div className="kv">
          <span className="k">Full id</span>
          <span className="mono wrap-any small">{changeset.id}</span>
          <span className="k">Author</span>
          <span>{authorLabel(changeset.author)}</span>
          {provenance && (
            <>
              <span className="k">Agent</span>
              <span>{agentLine(provenance)}</span>
            </>
          )}
          {facts && <SourceFacts slug={slug} facts={facts} />}
          <span className="k">Created</span>
          <span>{formatTime(changeset.created_at)}</span>
          <span className="k">Parents</span>
          <span className="row">
            {changeset.parents.length === 0 && (
              <span className="muted">root changeset</span>
            )}
            {changeset.parents.map((p) => (
              <Link key={p} className="mono" to={`/r/${slug}/cs/${p}`}>
                {shortId(p)}
              </Link>
            ))}
          </span>
          <span className="k">Root tree</span>
          <span className="mono">{shortId(changeset.root_tree)}</span>
        </div>
        <pre className="code" style={{ whiteSpace: 'pre-wrap' }}>
          {changeset.message}
        </pre>
      </div>

      <h2>Changed files ({changeset.changed_files.length})</h2>
      {changeset.changed_files.length === 0 ? (
        <Empty>No files changed.</Empty>
      ) : (
        <div className="panel tight">
          <table>
            <thead>
              <tr>
                <th>Op</th>
                <th>Path</th>
                <th>Hash</th>
                <th>Size</th>
                <th>Blame</th>
              </tr>
            </thead>
            <tbody>
              {changeset.changed_files.map((f) => (
                <tr key={f.path}>
                  <td>
                    <span className={`chip ${OP_CHIP[f.op]}`}>{f.op}</span>
                  </td>
                  <td className="mono wrap-any">
                    <Link to={`/r/${slug}/tree/${changeset.id}/${f.path}`}>{f.path}</Link>
                  </td>
                  <td className="mono small muted">{shortId(f.hash)}</td>
                  <td className="small muted">{formatBytes(f.size)}</td>
                  <td>
                    <Link
                      className="small"
                      to={`/r/${slug}/tree/${changeset.id}/${f.path}`}
                    >
                      at this revision →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Diff</h2>
      {!changeset.first_parent ? (
        <div className="notice info">
          Root changeset — there is no parent to diff against; see the changed files
          above.
        </div>
      ) : diff ? (
        <>
          {diff.texts_truncated && (
            <div className="notice warn">
              Text diffs exceeded the response budget — fetch individual files via the
              tree view.
            </div>
          )}
          <div className="small muted">
            <code>{shortId(diff.from)}</code> → <code>{shortId(diff.to)}</code> ·{' '}
            {diff.files.length} files {diff.truncated ? '(truncated)' : ''}
          </div>
          <DiffView files={diff.files} texts={diff.texts} />
        </>
      ) : (
        <Loading label="Computing diff…" />
      )}
    </div>
  );
}
