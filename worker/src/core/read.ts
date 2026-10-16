import type { Env } from '../env';
import type { Changeset } from './changesets';
import { NotFoundError } from './errors';
import { getRef } from '../db/repos';
import { getChangeset } from './changesets';

const CS_ID_RE = /^[0-9a-f]{64}$/;

/**
 * Resolve a revision string to a changeset, or null when unresolvable.
 *
 * Accepted forms: a changeset id, `ref:<name>`, or a bare ref name (`main`,
 * `feature/x`, a tag such as `v1.2.3`). Refs are discouraged global state
 * (architecture §1.4) — everything else is a changeset id.
 */
export async function lookupRev(
  env: Env,
  repoId: string,
  rev: string,
): Promise<Changeset | null> {
  if (rev.startsWith('ref:')) {
    return lookupRef(env, repoId, rev.slice('ref:'.length));
  }
  if (CS_ID_RE.test(rev)) {
    return getChangeset(env, repoId, rev);
  }
  return lookupRef(env, repoId, rev);
}

async function lookupRef(
  env: Env,
  repoId: string,
  name: string,
): Promise<Changeset | null> {
  // a bare tag name (`v1.2.3`) resolves like Git's refs/tags/ lookup
  const ref =
    (await getRef(env, repoId, name)) ??
    (name.startsWith('refs/') ? null : await getRef(env, repoId, `refs/tags/${name}`));
  if (!ref) return null;
  return getChangeset(env, repoId, ref.head);
}

/** Like `lookupRev`, but returns just the changeset id. */
export async function lookupRevId(
  env: Env,
  repoId: string,
  rev: string,
): Promise<string | null> {
  const cs = await lookupRev(env, repoId, rev);
  return cs ? cs.id : null;
}

/** `resolveRevision` — 404 `revision_not_found` when unresolvable. */
export async function resolveRevision(
  env: Env,
  repoId: string,
  rev: string,
): Promise<Changeset> {
  const cs = await lookupRev(env, repoId, rev);
  if (!cs) {
    throw new NotFoundError('revision_not_found', `no revision ${rev}`, { rev });
  }
  return cs;
}

// ---------------------------------------------------------------------------
// Content types for `?format=raw`
// ---------------------------------------------------------------------------

const CONTENT_TYPES: Record<string, string> = {
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  json: 'application/json; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  cjs: 'text/javascript; charset=utf-8',
  jsx: 'text/javascript; charset=utf-8',
  ts: 'text/typescript; charset=utf-8',
  mts: 'text/typescript; charset=utf-8',
  tsx: 'text/typescript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  html: 'text/html; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  yaml: 'application/yaml; charset=utf-8',
  yml: 'application/yaml; charset=utf-8',
  toml: 'application/toml; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  wasm: 'application/wasm',
};

export function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  return CONTENT_TYPES[path.slice(dot + 1).toLowerCase()] ?? 'application/octet-stream';
}
