import type { Env } from '../env';
import { getChangeset } from './changesets';

/**
 * Ancestry checks (architecture §1.4).
 *
 * PROVISIONAL: bounded breadth-first reachability over **all** parent edges
 * (a first-parent-only walk falsely rejects true descendants that arrive via
 * a merge's second parent — real bug found in review, fixed here until the
 * skip-list lands). Cap: 10k visited changesets. This is the
 * `X-YAG-Provisional: ancestor` fallback — issue #8 replaces it with the
 * O(log n) skip-list derived data (`isAncestor` / `mergeBase`) and deletes
 * this walk.
 *
 * Note: reachability over immutable changesets is itself immutable, so
 * callers may compute it outside any lock (see `RefLockDO`).
 */
export async function isAncestorProvisional(
  env: Env,
  repoId: string,
  a: string,
  b: string,
): Promise<boolean> {
  if (a === b) return true;
  const seen = new Set<string>();
  const queue: string[] = [b];
  while (queue.length > 0 && seen.size < 10_000) {
    const id = queue.shift() as string;
    if (id === a) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const cs = await getChangeset(env, repoId, id);
    if (cs === null) continue;
    for (const parent of cs.parents) {
      if (!seen.has(parent)) queue.push(parent);
    }
  }
  return false;
}

/**
 * PROVISIONAL merge base: ancestor-set intersection over first-parent chains
 * (spec-mandated stopgap; `X-YAG-Provisional: merge-base` — issue #8 replaces
 * with skip-list convergence). Returns the first node of `b`'s first-parent
 * chain that is reachable from `a`, or null.
 */
export async function provisionalMergeBase(
  env: Env,
  repoId: string,
  a: string,
  b: string,
): Promise<string | null> {
  const ancestors = new Set<string>();
  let cursor: string | null = a;
  while (cursor !== null && ancestors.size < 10_000) {
    ancestors.add(cursor);
    const cs = await getChangeset(env, repoId, cursor);
    cursor = cs ? cs.first_parent : null;
  }
  cursor = b;
  let hops = 0;
  while (cursor !== null && hops < 10_000) {
    if (ancestors.has(cursor)) return cursor;
    const cs = await getChangeset(env, repoId, cursor);
    cursor = cs ? cs.first_parent : null;
    hops++;
  }
  return null;
}
