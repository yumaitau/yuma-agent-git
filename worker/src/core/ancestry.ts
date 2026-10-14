import type { Env } from '../env';
import { getChangeset } from './changesets';

/**
 * Ancestry checks (architecture §1.4).
 *
 * PROVISIONAL: bounded first-parent walk (max 1000 hops). This is the
 * `X-YAG-Provisional: ancestor` fallback — issue #8 replaces it with the
 * O(log n) skip-list derived data (`isAncestor` / `mergeBase`) and deletes
 * this walk.
 */
export async function isAncestorProvisional(
  env: Env,
  repoId: string,
  a: string,
  b: string,
): Promise<boolean> {
  if (a === b) return true;
  let cursor: string | null = b;
  let hops = 0;
  while (cursor !== null && hops < 1000) {
    const cs = await getChangeset(env, repoId, cursor);
    if (cs === null) return false;
    if (cs.id === a) return true;
    cursor = cs.first_parent;
    hops++;
  }
  return false;
}
