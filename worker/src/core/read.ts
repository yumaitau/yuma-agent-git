import type { Env } from '../env';
import { getChangeset, type Changeset } from './changesets';
import { getRef } from '../db/repos';

const CS_ID_RE = /^[0-9a-f]{64}$/;

/**
 * Resolve a revision string to a changeset, or null when unresolvable.
 *
 * Accepted forms: a changeset id, `ref:<name>`, or a bare ref name (`main`,
 * `release/1.2`). Refs are discouraged global state (architecture §1.4) —
 * everything else is a changeset id.
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
  const ref = await getRef(env, repoId, name);
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
