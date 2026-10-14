import type { Env } from '../env';
import { C, T } from '../db/schema';
import { q1, run } from '../db/client';
import { getChangeset, type Changeset } from './changesets';
import { canonicalJson, sha256Hex } from './hashing';

/**
 * Ancestry via skip-list derived data (architecture §1.5) — O(log n) instead
 * of linear log reads.
 *
 * **Semantics: first-parent reachability** (Scion footnote 1 — mainline
 * history is what blame and merge semantics care about). Merge commits are
 * represented by their first-parent spine only. Callers that need full-DAG
 * reachability (ref fast-forward checks, where a merge is a descendant of
 * *both* parents in git semantics) use `isAncestorDag` below.
 *
 * skip_list payload for changeset C (derived_data kind `skip_list`):
 * ```json
 * { "depth": 17, "levels": 5, "pointers": [["p0"], ["p1"], …] }
 * ```
 * `depth` = distance from the root along the spine (root = 0);
 * `pointers[k]` = the 2^k-th first-parent ancestor id, when present.
 */

export interface SkipListEntry {
  depth: number;
  levels: number;
  pointers: string[][];
}

const KIND = 'skip_list';
const MAX_LEVELS = 20;

const skipListEntrySchemaLike = (payload: unknown): SkipListEntry | null => {
  const parsed = payload as Partial<SkipListEntry>;
  if (
    parsed &&
    typeof parsed.depth === 'number' &&
    typeof parsed.levels === 'number' &&
    Array.isArray(parsed.pointers)
  ) {
    return {
      depth: parsed.depth,
      levels: parsed.levels,
      pointers: parsed.pointers.map((p) => (Array.isArray(p) ? p.map(String) : [])),
    };
  }
  return null;
};

// ---------------------------------------------------------------------------
// derived_data storage for this kind (refactored into the generic framework
// in issue #9 — kept minimal here)
// ---------------------------------------------------------------------------

async function readEntry(
  env: Env,
  repoId: string,
  csId: string,
): Promise<SkipListEntry | null> {
  const row = await q1(
    env,
    `SELECT ${C.derivedData.payload} FROM ${T.derivedData}
      WHERE ${C.derivedData.repoId} = ? AND ${C.derivedData.kind} = ? AND ${C.derivedData.csId} = ?`,
    [repoId, KIND, csId],
  );
  if (!row) return null;
  const payload = (row as Record<string, unknown>)[C.derivedData.payload];
  try {
    return skipListEntrySchemaLike(JSON.parse(String(payload)));
  } catch {
    return null;
  }
}

async function writeEntry(
  env: Env,
  repoId: string,
  csId: string,
  entry: SkipListEntry,
): Promise<void> {
  await run(
    env,
    `INSERT INTO ${T.derivedData}
       (${C.derivedData.repoId}, ${C.derivedData.kind}, ${C.derivedData.csId},
        ${C.derivedData.payload}, ${C.derivedData.computedAt})
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (${C.derivedData.repoId}, ${C.derivedData.kind}, ${C.derivedData.csId})
     DO NOTHING`,
    [repoId, KIND, csId, JSON.stringify(entry), Date.now()],
  );
}

/**
 * Read a changeset's skip-list entry, computing (and storing) it on demand —
 * self-healing for chains created before the framework existed.
 */
export async function getSkipListEntry(
  env: Env,
  repoId: string,
  csId: string,
): Promise<SkipListEntry | null> {
  const existing = await readEntry(env, repoId, csId);
  if (existing) return existing;
  const cs = await getChangeset(env, repoId, csId);
  if (!cs) return null;
  return computeSkipList(env, repoId, cs);
}

/**
 * Compute (recursively-but-iteratively) and store the entry for `cs`.
 *
 * Walks the first-parent spine until it finds a changeset with a stored entry
 * (or the root), then computes forward — memoized within the call. Cheap for
 * the eager commit hook: normally the parent's entry already exists, so this
 * is one parent read + one write.
 */
export async function computeSkipList(
  env: Env,
  repoId: string,
  cs: Changeset,
): Promise<SkipListEntry> {
  // Collect the tip→oldest chain of changesets missing entries.
  const chain: Changeset[] = [];
  let cursor: Changeset | null = cs;
  let ancestorEntry: SkipListEntry | null = null;
  while (cursor !== null) {
    const stored = await readEntry(env, repoId, cursor.id);
    if (stored !== null) {
      ancestorEntry = stored;
      break;
    }
    chain.push(cursor);
    cursor =
      cursor.first_parent === null
        ? null
        : await getChangeset(env, repoId, cursor.first_parent);
  }
  if (chain.length === 0) {
    // cs itself already had an entry
    return ancestorEntry as SkipListEntry;
  }

  // ancestorEntry (when present) is the entry of chain[last]'s first parent.
  const byId = new Map<string, SkipListEntry>();
  if (ancestorEntry !== null) {
    const oldest = chain[chain.length - 1] as Changeset;
    byId.set(oldest.first_parent as string, ancestorEntry);
  }

  let result: SkipListEntry | null = null;
  for (let i = chain.length - 1; i >= 0; i--) {
    const node = chain[i] as Changeset;
    const parentEntry =
      node.first_parent === null ? null : (byId.get(node.first_parent) ?? null);
    const entry = await computeEntry(env, repoId, node, parentEntry, byId);
    byId.set(node.id, entry);
    await writeEntry(env, repoId, node.id, entry);
    result = entry;
  }
  return result as SkipListEntry;
}

/**
 * Entry of an ancestor, memoized: in-call map → derived_data → self-healing
 * compute. Needed because `pointers[k] = entry(pointers[k-1]).pointers[k-1]`
 * reads the entries of ancestors at powers-of-two distances, not just the
 * direct parent — without this the incremental path produces truncated
 * pointer levels (a determinism bug found in review testing).
 */
async function entryOf(
  env: Env,
  repoId: string,
  byId: Map<string, SkipListEntry>,
  id: string,
  guard = { depth: 0 },
): Promise<SkipListEntry | null> {
  const local = byId.get(id);
  if (local) return local;
  const stored = await readEntry(env, repoId, id);
  if (stored) {
    byId.set(id, stored);
    return stored;
  }
  if (guard.depth > 20) return null;
  const cs = await getChangeset(env, repoId, id);
  if (!cs) return null;
  guard.depth++;
  const computed = await computeSkipList(env, repoId, cs);
  guard.depth--;
  byId.set(id, computed);
  return computed;
}

async function computeEntry(
  env: Env,
  repoId: string,
  cs: Changeset,
  parentEntry: SkipListEntry | null,
  byId: Map<string, SkipListEntry>,
): Promise<SkipListEntry> {
  if (parentEntry === null || cs.first_parent === null) {
    return { depth: 0, levels: 0, pointers: [] };
  }
  const pointers: string[][] = [[cs.first_parent]];
  for (let k = 1; k < MAX_LEVELS; k++) {
    const prevAncestor = (pointers[k - 1] as string[])[0];
    if (prevAncestor === undefined) break;
    const prevEntry = await entryOf(env, repoId, byId, prevAncestor);
    const jump = prevEntry?.pointers[k - 1]?.[0];
    if (jump === undefined) break;
    pointers.push([jump]);
  }
  const depth = parentEntry.depth + 1;
  const levels = Math.min(Math.floor(Math.log2(depth)) + 1, MAX_LEVELS);
  return { depth, levels, pointers };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

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
 * acceptable; issue #8's skip lists keep the common case O(log n).
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
