import { z } from 'zod';
import type { Env } from '../../env';
import type { Changeset } from '../changesets';
import { getChangeset } from '../changesets';
import { getDerived, registerKind, type DerivedKind } from '../derived';
import { SKIP_LIST } from '../derived';

/**
 * `path_history` derived kind (architecture §1.5, issue #10) — the query that
 * used to force git users to keep full local clones.
 *
 * Payload per changeset C: `{paths: {path → [cs ids]}}`, restricted to the
 * paths **C itself touched** (payloads stay ∝ change size), each list holding
 * up to 50 most-recent first-parent-spine touchers of that path, newest
 * first. The list chain carries across changesets: a walk reads one payload,
 * jumps to the oldest listed toucher's payload, and continues — O(list hops)
 * instead of O(history).
 */

export const PATH_HISTORY = 'path_history';
export const PATH_HISTORY_LIST_CAP = 50;

const payloadSchema = z.object({
  paths: z.record(z.string(), z.array(z.string())),
});

export type PathHistoryPayload = z.infer<typeof payloadSchema>;

/** Previous touchers of `path` (first-parent spine), capped, newest first. */
async function collectTouchers(
  env: Env,
  repoId: string,
  cs: Changeset,
  path: string,
): Promise<string[]> {
  const ids = [cs.id];
  let cursor: string | null = cs.first_parent;
  let hops = 0;
  while (ids.length < PATH_HISTORY_LIST_CAP && cursor !== null && hops < 500) {
    hops++;
    const parent = await getChangeset(env, repoId, cursor);
    if (parent === null) break;
    const touched = parent.changed_files.some((f) => f.path === path);
    if (!touched) {
      // Parent's payload only covers paths it touched — keep walking.
      cursor = parent.first_parent;
      continue;
    }
    const payload = await getDerived<PathHistoryPayload>(
      env,
      repoId,
      PATH_HISTORY,
      parent.id,
    );
    for (const id of payload?.paths[path] ?? []) {
      if (ids.length >= PATH_HISTORY_LIST_CAP) break;
      if (!ids.includes(id)) ids.push(id);
    }
    break; // the parent's own list already chains further back
  }
  return ids;
}

export const pathHistoryKind: DerivedKind<PathHistoryPayload> = {
  name: PATH_HISTORY,
  eager: false,
  async compute(env, repoId, cs) {
    const paths: Record<string, string[]> = {};
    for (const file of cs.changed_files) {
      paths[file.path] = await collectTouchers(env, repoId, cs, file.path);
    }
    return { paths };
  },
  parse(payload) {
    return payloadSchema.parse(JSON.parse(payload));
  },
};

registerKind(pathHistoryKind);

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export interface PathHistoryResult {
  /** Changeset ids touching `path`, newest first. */
  commits: string[];
  /**
   * Resume cursor: pass as the next request's `cs` to continue the walk with
   * nothing repeated and nothing skipped (first parent of the last returned
   * commit). Null when the walk reached the root.
   */
  next: string | null;
  complete: boolean;
}

/**
 * Changesets touching `path`, newest first, walking the payload chain.
 * Bounded: `maxHops` changesets visited per request (the route resumes from
 * `next`).
 */
export function matchesQuery(entryPath: string, query: string): boolean {
  return entryPath === query || entryPath.startsWith(`${query}/`);
}

/** Newest-first on the first-parent spine (skip-list depth is the total order). */
async function sortNewestFirst(
  env: Env,
  repoId: string,
  ids: string[],
): Promise<string[]> {
  const depths = await Promise.all(
    ids.map(async (id) => {
      const entry = await getDerived<{ depth: number }>(env, repoId, SKIP_LIST, id);
      return { id, depth: entry?.depth ?? -1 };
    }),
  );
  return depths.sort((a, b) => b.depth - a.depth).map((d) => d.id);
}

export async function pathHistoryAt(
  env: Env,
  repoId: string,
  csId: string,
  path: string,
  limit: number,
  maxHops = 200,
): Promise<PathHistoryResult> {
  const out: string[] = [];
  let hops = 0;
  let cursor: string | null = csId;

  while (cursor !== null && out.length < limit && hops < maxHops) {
    hops++;
    const cs = await getChangeset(env, repoId, cursor);
    if (cs === null) break;

    if (cs.changed_files.some((f) => matchesQuery(f.path, path))) {
      const payload = await getDerived<PathHistoryPayload>(
        env,
        repoId,
        PATH_HISTORY,
        cursor,
      );
      // Exact-path lists, or every under-path list for a directory query.
      const ids = new Set<string>();
      for (const [entryPath, list] of Object.entries(payload?.paths ?? {})) {
        if (!matchesQuery(entryPath, path)) continue;
        for (const id of list) ids.add(id);
      }
      for (const id of await sortNewestFirst(env, repoId, [...ids])) {
        if (out.length >= limit) break;
        if (!out.includes(id)) out.push(id);
      }
      if (out.length >= limit) break;
      const oldest = out[out.length - 1];
      if (oldest !== undefined && oldest !== cursor) {
        // Jump past the whole listed run.
        const oldestCs = await getChangeset(env, repoId, oldest);
        cursor = oldestCs?.first_parent ?? null;
        continue;
      }
    }
    cursor = cs.first_parent;
  }

  // Resume point: the walk continues from just below the last returned commit.
  let next: string | null = cursor;
  const last = out[out.length - 1];
  if (out.length >= limit && last !== undefined) {
    const lastCs = await getChangeset(env, repoId, last);
    next = lastCs?.first_parent ?? null;
  }
  return {
    commits: out,
    next,
    complete: next === null,
  };
}
