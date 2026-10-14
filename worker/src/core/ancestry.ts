import type { Env } from '../env';
import {
  SKIP_LIST,
  computeSkipListEntry,
  getDerived,
  type SkipListEntry,
} from './derived';
import { getChangeset, type Changeset } from './changesets';
import { canonicalJson, sha256Hex } from './hashing';

/**
 * Ancestry queries over skip-list derived data (architecture §1.5) — O(log n)
 * instead of linear log reads.
 *
 * **Semantics: first-parent reachability** (Scion footnote 1 — mainline
 * history is what blame and merge semantics care about). Merge commits are
 * represented by their first-parent spine only. Callers that need full-DAG
 * reachability (ref fast-forward checks, where a merge is a descendant of
 * *both* parents in git semantics) use `isAncestorDag` below.
 *
 * The skip_list kind itself (payload, computation, storage) is owned by the
 * generic derived-data framework (`core/derived.ts`, issue #9).
 */

export type { SkipListEntry };

/** Compute + store the skip-list entry for `cs` (self-healing for ancestors). */
export function computeSkipList(
  env: Env,
  repoId: string,
  cs: Changeset,
): Promise<SkipListEntry> {
  return computeSkipListEntry(env, repoId, cs);
}

/** Entry for a changeset, computed and stored on demand. */
export async function getSkipListEntry(
  env: Env,
  repoId: string,
  csId: string,
): Promise<SkipListEntry | null> {
  return getDerived<SkipListEntry>(env, repoId, SKIP_LIST, csId);
}

/**
 * `a` is an ancestor of `b` along the first-parent spine (inclusive of `a ===
 * b`). O(log n) D1 reads: greedy highest-level jumps by depth arithmetic.
 */
export async function isAncestor(
  env: Env,
  repoId: string,
  a: string,
  b: string,
): Promise<boolean> {
  if (a === b) return true;
  const ea = await getSkipListEntry(env, repoId, a);
  const eb = await getSkipListEntry(env, repoId, b);
  if (!ea || !eb) return false;
  if (eb.depth <= ea.depth) return false;

  let currentId = b;
  let current = eb;
  while (current.depth > ea.depth) {
    const step = current.depth - ea.depth;
    const k = Math.min(Math.floor(Math.log2(step)), current.pointers.length - 1);
    const next = (current.pointers[k] as string[])[0];
    if (next === undefined) return false;
    const nextEntry = await getSkipListEntry(env, repoId, next);
    if (!nextEntry) return false;
    currentId = next;
    current = nextEntry;
  }
  return currentId === a;
}

/**
 * Merge base over first-parent spines: equalize depths, then tandem-descend
 * the highest level where the pointers differ. O(log n). Returns null when the
 * spines never meet.
 */
export async function mergeBase(
  env: Env,
  repoId: string,
  a: string,
  b: string,
): Promise<string | null> {
  if (a === b) return a;
  let xa = await getSkipListEntry(env, repoId, a);
  let xb = await getSkipListEntry(env, repoId, b);
  if (!xa || !xb) return null;
  let idA = a;
  let idB = b;

  const jumpToDepth = async (
    id: string,
    entry: SkipListEntry,
    targetDepth: number,
  ): Promise<{ id: string; entry: SkipListEntry } | null> => {
    let curId = id;
    let cur = entry;
    while (cur.depth > targetDepth) {
      const step = cur.depth - targetDepth;
      const k = Math.min(Math.floor(Math.log2(step)), cur.pointers.length - 1);
      const next = (cur.pointers[k] as string[])[0];
      if (next === undefined) return null;
      const nextEntry = await getSkipListEntry(env, repoId, next);
      if (!nextEntry) return null;
      curId = next;
      cur = nextEntry;
    }
    return { id: curId, entry: cur };
  };

  if (xa.depth > xb.depth) {
    const up = await jumpToDepth(idA, xa, xb.depth);
    if (!up) return null;
    idA = up.id;
    xa = up.entry;
  } else if (xb.depth > xa.depth) {
    const up = await jumpToDepth(idB, xb, xa.depth);
    if (!up) return null;
    idB = up.id;
    xb = up.entry;
  }

  while (idA !== idB) {
    // highest level where the two spines still differ
    let moved = false;
    const maxK = Math.min(xa.pointers.length, xb.pointers.length) - 1;
    for (let k = maxK; k >= 0; k--) {
      const pa = (xa.pointers[k] as string[])[0];
      const pb = (xb.pointers[k] as string[])[0];
      if (pa !== undefined && pb !== undefined && pa !== pb) {
        const ea = await getSkipListEntry(env, repoId, pa);
        const eb = await getSkipListEntry(env, repoId, pb);
        if (!ea || !eb) return null;
        idA = pa;
        idB = pb;
        xa = ea;
        xb = eb;
        moved = true;
        break;
      }
    }
    if (!moved) {
      // spines agree one level up: the merge base is the shared parent
      const pa = (xa.pointers[0] as string[] | undefined)?.[0];
      return pa ?? null;
    }
  }
  return idA;
}

/**
 * Distance from `a` to `b` along the first-parent spine (b deeper), or null
 * when `a` is not a spine-ancestor of `b`.
 */
export async function ancestorDistance(
  env: Env,
  repoId: string,
  a: string,
  b: string,
): Promise<number | null> {
  const ea = await getSkipListEntry(env, repoId, a);
  const eb = await getSkipListEntry(env, repoId, b);
  if (!ea || !eb) return null;
  if (ea.depth > eb.depth) return null;
  if (!(await isAncestor(env, repoId, a, b))) return null;
  return eb.depth - ea.depth;
}

// ---------------------------------------------------------------------------
// Full-DAG reachability (for ref fast-forward checks)
// ---------------------------------------------------------------------------

/**
 * `a` is an ancestor of `b` over **all** parent edges — git fast-forward
 * semantics, where a merge is a descendant of both parents. The first-parent
 * skip list cannot answer this (it would falsely reject a ref move from a
 * merge's second parent — a real bug found in adversarial review), so this
 * uses the skip list as a fast path and a bounded all-parent BFS as the
 * general case. Ref moves are rare (refs are discouraged), so the walk is
 * acceptable; the skip list keeps the common case O(log n).
 */
export async function isAncestorDag(
  env: Env,
  repoId: string,
  a: string,
  b: string,
): Promise<boolean> {
  if (a === b) return true;
  if (await isAncestor(env, repoId, a, b)) return true;

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

/** Deterministic payload hash — used by tests asserting recomputation stability. */
export function skipListPayloadHash(entry: SkipListEntry): Promise<string> {
  return sha256Hex(new TextEncoder().encode(canonicalJson(entry)));
}
