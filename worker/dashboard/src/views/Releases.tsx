import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { ApiError, asApiError } from '../api';
import { call } from '../collaboration';
import { Markdown } from '../Markdown';
import { useSlug } from '../slug';
import {
  Chip,
  Empty,
  ErrorNotice,
  Field,
  formatBytes,
  formatRelative,
  Loading,
} from '../ui';
import { RepoNav } from './Collaboration';
import type { GeneratedNotes, Release } from '../../../shared/releases';

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Raw upload; the server hashes the bytes and refuses them if they differ from ours. */
async function uploadAsset(slug: string, releaseId: string, file: File): Promise<void> {
  const bytes = await file.arrayBuffer();
  const res = await fetch(
    `/api/v1/repos/${slug}/releases/${releaseId}/assets?name=${encodeURIComponent(file.name)}&sha256=${await sha256Hex(bytes)}`,
    {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': file.type || 'application/octet-stream' },
      body: bytes,
    },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { code?: string; message?: string };
    };
    throw new ApiError(
      res.status,
      body.error?.code ?? 'upload_failed',
      `${file.name}: ${body.error?.message ?? `HTTP ${res.status}`}`,
    );
  }
}

/**
 * Releases (issue #54): published releases for every reader, drafts for
 * writers, assets with their SHA-256 and attached provenance, and a form to
 * create a release from a tag with generated notes and assets.
 */
export function ReleasesView(): ReactElement {
  const slug = useSlug();
  const [releases, setReleases] = useState<Release[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState('');
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    call<{ releases: Release[] }>(`/repos/${slug}/releases`)
      .then((r) => !cancelled && setReleases(r.releases))
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
      <RepoNav active="Releases" />
      <h1>Releases</h1>
      {error && <ErrorNotice error={error} />}
      {notice && <p role="status">{notice}</p>}
      {!releases && !error && <Loading />}
      {releases && releases.length === 0 && <Empty>No releases yet.</Empty>}
      {releases?.map((r) => (
        <section key={r.id} className="panel stack">
          <div className="row between">
            <h2>
              {r.name} <code className="small">{r.tag}</code>{' '}
              {r.latest && <Chip kind="ok">latest</Chip>}{' '}
              {r.prerelease && <Chip kind="warn">prerelease</Chip>}{' '}
              {r.draft && <Chip kind="info">draft</Chip>}
            </h2>
            <span className="row">
              {r.draft && (
                <button
                  onClick={() =>
                    void act(
                      () =>
                        call(`/repos/${slug}/releases/${r.id}`, 'PATCH', {
                          draft: false,
                        }),
                      `Published ${r.tag}.`,
                    )
                  }
                >
                  Publish
                </button>
              )}
              <button
                onClick={() =>
                  void act(
                    () => call(`/repos/${slug}/releases/${r.id}`, 'DELETE'),
                    `Deleted release ${r.tag}.`,
                  )
                }
              >
                Delete
              </button>
            </span>
          </div>
          <p className="small muted">
            {r.published_at
              ? `Published ${formatRelative(r.published_at)}`
              : 'Not published'}{' '}
            · {r.created_by}
          </p>
          {r.body && <Markdown source={r.body} slug={slug} />}
          {r.assets.length > 0 && (
            <ul className="history-list">
              {r.assets.map((a) => (
                <li key={a.id} className="row between">
                  <a
                    href={`/api/v1/repos/${slug}/releases/${r.id}/assets/${a.id}`}
                    download
                  >
                    {a.name}
                  </a>
                  <span className="small muted">
                    {formatBytes(a.size)} · <code>sha256:{a.sha256.slice(0, 16)}</code>
                    {r.attestations.some((t) =>
                      t.subjects.some((s) => s.digest.sha256 === a.sha256),
                    ) && (
                      <>
                        {' '}
                        <Chip kind="ok">provenance</Chip>
                      </>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
      <NewReleaseForm
        slug={slug}
        onError={setError}
        onCreate={(body, files) =>
          act(async () => {
            const { release } = await call<{ release: Release }>(
              `/repos/${slug}/releases`,
              'POST',
              body,
            );
            for (const file of files) await uploadAsset(slug, release.id, file);
          }, 'Release created.')
        }
      />
    </>
  );
}

function NewReleaseForm({
  slug,
  onCreate,
  onError,
}: {
  slug: string;
  onCreate: (body: unknown, files: File[]) => Promise<void>;
  onError: (err: ApiError) => void;
}): ReactElement {
  const [tags, setTags] = useState<string[]>([]);
  const [tag, setTag] = useState('');
  const [name, setName] = useState('');
  const [body, setBody] = useState('');
  const [draft, setDraft] = useState(false);
  const [prerelease, setPrerelease] = useState(false);
  const [files, setFiles] = useState<File[]>([]);

  useEffect(() => {
    let cancelled = false;
    call<{ tags: { name: string }[] }>(`/repos/${slug}/tags?limit=100`)
      .then((r) => {
        if (cancelled) return;
        setTags(r.tags.map((t) => t.name));
        setTag((current) => current || (r.tags.at(-1)?.name ?? ''));
      })
      .catch((err) => !cancelled && onError(asApiError(err)));
    return () => {
      cancelled = true;
    };
  }, [slug, onError]);

  return (
    <section className="panel">
      <h2>New release</h2>
      <p className="small muted">
        A release names an existing tag. Drafts stay hidden from readers until you publish
        them. Assets are checked against their SHA-256 on upload and on every download.
      </p>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void onCreate(
            { tag, ...(name ? { name } : {}), body, draft, prerelease },
            files,
          ).then(() => {
            setName('');
            setBody('');
            setFiles([]);
          });
        }}
      >
        <div className="row">
          <Field label="Tag">
            <select value={tag} onChange={(e) => setTag(e.target.value)} required>
              {tags.length === 0 && <option value="">No tags yet</option>}
              {tags.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Title">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={tag}
            />
          </Field>
        </div>
        <Field label="Notes">
          <textarea rows={8} value={body} onChange={(e) => setBody(e.target.value)} />
        </Field>
        <div className="row">
          <button
            type="button"
            disabled={!tag}
            onClick={() =>
              void call<GeneratedNotes>(
                `/repos/${slug}/releases/generate-notes`,
                'POST',
                {
                  tag,
                },
              )
                .then((notes) => setBody(body ? `${body}\n\n${notes.body}` : notes.body))
                .catch((err) => onError(asApiError(err)))
            }
          >
            Generate notes
          </button>
          <label>
            <input
              type="checkbox"
              checked={draft}
              onChange={(e) => setDraft(e.target.checked)}
            />{' '}
            Draft
          </label>
          <label>
            <input
              type="checkbox"
              checked={prerelease}
              onChange={(e) => setPrerelease(e.target.checked)}
            />{' '}
            Prerelease
          </label>
        </div>
        <Field label="Assets">
          <input
            type="file"
            multiple
            onChange={(e) => setFiles([...(e.target.files ?? [])])}
          />
        </Field>
        <div className="row">
          <button className="primary" disabled={!tag}>
            Create release
          </button>
        </div>
      </form>
    </section>
  );
}
