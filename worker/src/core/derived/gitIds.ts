import { z } from 'zod';
import type { Env } from '../../env';
import { run, tx } from '../../db/client';
import { C, T } from '../../db/schema';
import { getBlob } from '../blobs';
import {
  ancestorsParentsFirst,
  HistoryWalkLimitError,
  type Changeset,
} from '../changesets';
import {
  continuation,
  DerivedDeferredError,
  enqueueDerived,
  getDerived,
  isSentinel,
  registerKind,
  type DerivedKind,
} from '../derived';
import { ObjectCorruptError } from '../errors';
import { getTree } from '../trees';
import {
  blobIdsFor,
  commitIdsFor,
  commitIdsForMany,
  gitCommitFor,
  gitTreeEntries,
  treeIdsFor,
} from '../../git/mapping';
import {
  EMPTY_TREE,
  gitBlobId,
  gitCommitId,
  gitTreeId,
  type GitIds,
} from '../../git/objects';
import { storageId } from '../network';

/**
 * `git_ids` derived kind (issue #30): the Git commit/tree/blob IDs of a
 * changeset, computed once and stored in `git_commits` / `git_trees` /
 * `git_blobs` (the derived row holds the commit IDs).
 *
 * Incremental like the commit path: trees and blobs that already have IDs are
 * one batched lookup, so a small change hashes only what it touched. Small
 * changes compute in the commit path; large ones, and any computation that
 * would hash more than `MAX_HASH_BYTES`, continue in the derived-data queue
 * with their progress kept.
 */

export const GIT_IDS = 'git_ids';

/** Hashing bound per invocation (issue #30 constraint). */
export const MAX_HASH_BYTES = 64 * 1024 * 1024;
/** Commit-path bound: larger changes are deferred to the queue. */
export const EAGER_MAX_BYTES = 8 * 1024 * 1024;
export const EAGER_MAX_FILES = 1_000;
/** Changesets without IDs one invocation may walk back through. */
export const MAX_WALK = 250;

const ROW_CHUNK = 30; // 3 params per row, under D1's bound-parameter cap

/** Counts blob bytes, which dominate; trees and commits are small. */
class HashBudget {
  private used = 0;
  constructor(private readonly max: number) {}

  /** False when `bytes` more would pass the bound (the first spend always fits). */
  fits(bytes: number): boolean {
    return this.used === 0 || this.used + bytes <= this.max;
  }

  spend(bytes: number): void {
    this.used += bytes;
  }
}

interface Run {
  env: Env;
  repoId: string;
  budget: HashBudget;
  trees: Map<string, GitIds>;
}

async function storeBlobs(env: Env, rows: [string, GitIds][]): Promise<void> {
  if (rows.length === 0) return;
  await tx(env, (t) => {
    for (let i = 0; i < rows.length; i += ROW_CHUNK) {
      const chunk = rows.slice(i, i + ROW_CHUNK);
      t.q(
        `INSERT OR IGNORE INTO ${T.gitBlobs}
           (${C.gitBlobs.blobHash}, ${C.gitBlobs.sha1}, ${C.gitBlobs.sha256})
         VALUES ${chunk.map(() => '(?, ?, ?)').join(', ')}`,
        chunk.flatMap(([hash, ids]) => [hash, ids.sha1, ids.sha256]),
      );
    }
  });
}

/** Git IDs of one of our trees, computing (and storing) missing subtrees first. */
async function treeIds(r: Run, hash: string): Promise<GitIds> {
  const known =
    r.trees.get(hash) ?? (await treeIdsFor(r.env, r.repoId, [hash])).get(hash);
  if (known) {
    r.trees.set(hash, known);
    return known;
  }
  const tree = await getTree(r.env, r.repoId, hash);
  if (tree === null)
    throw new ObjectCorruptError('tree', hash, 'missing while computing git ids');

  const subtrees = tree.entries.filter((e) => e.kind === 'tree').map((e) => e.hash);
  const stored = await treeIdsFor(
    r.env,
    r.repoId,
    subtrees.filter((h) => !r.trees.has(h)),
  );
  for (const [h, ids] of stored) r.trees.set(h, ids);
  for (const h of subtrees) if (!r.trees.has(h)) await treeIds(r, h);

  const blobs = await blobIdsFor(
    r.env,
    tree.entries.filter((e) => e.kind === 'blob').map((e) => e.hash),
  );
  const fresh: [string, GitIds][] = [];
  for (const entry of tree.entries) {
    if (entry.kind !== 'blob' || blobs.has(entry.hash)) continue;
    const blob = await getBlob(r.env, r.repoId, entry.hash);
    if (blob === null) {
      throw new ObjectCorruptError('blob', entry.hash, 'missing while computing git ids');
    }
    if (!r.budget.fits(blob.size)) {
      // keep what this run hashed so the next one moves forward
      await storeBlobs(r.env, fresh);
      throw new DerivedDeferredError(`git_ids: hash budget spent at blob ${entry.hash}`);
    }
    r.budget.spend(blob.size);
    const ids = await gitBlobId(blob.content);
    blobs.set(entry.hash, ids);
    fresh.push([entry.hash, ids]);
  }

  const ids = await gitTreeId(gitTreeEntries(tree.entries, r.trees, blobs));
  await storeBlobs(r.env, fresh);
  await run(
    r.env,
    `INSERT OR IGNORE INTO ${T.gitTrees}
       (${C.gitTrees.repoId}, ${C.gitTrees.treeHash}, ${C.gitTrees.sha1}, ${C.gitTrees.sha256})
     VALUES (?, ?, ?, ?)`,
    [storageId(r.repoId), hash, ids.sha1, ids.sha256],
  );
  r.trees.set(hash, ids);
  return ids;
}

/**
 * Commit IDs for `cs`, first computing any ancestors that lack them (parents
 * before children). Throws `DerivedDeferredError` past the hashing or walk
 * bounds; everything finished so far stays stored.
 */
export async function computeGitIds(
  env: Env,
  repoId: string,
  cs: Changeset,
  maxHashBytes = MAX_HASH_BYTES,
): Promise<GitIds> {
  const existing = await commitIdsFor(env, repoId, cs.id);
  if (existing) return existing;

  const known = new Map<string, GitIds>();
  let missing: Changeset[];
  try {
    missing = await ancestorsParentsFirst(env, repoId, cs.id, MAX_WALK, async (id) => {
      const ids = await commitIdsFor(env, repoId, id);
      if (ids) known.set(id, ids);
      return ids !== null;
    });
  } catch (err) {
    if (!(err instanceof HistoryWalkLimitError)) throw err;
    throw new DerivedDeferredError('git_ids: long history without ids', err.frontier);
  }

  const r: Run = { env, repoId, budget: new HashBudget(maxHashBytes), trees: new Map() };
  for (const c of missing) {
    const tree = c.root_tree === null ? EMPTY_TREE : await treeIds(r, c.root_tree);
    const parents = c.parents.map((p) => {
      const ids = known.get(p);
      if (!ids) throw new Error(`git_ids: parent ${p} of ${c.id} not found`);
      return ids;
    });
    const ids = await gitCommitId(gitCommitFor(c, tree, parents));
    // Conflict on (repo_id, sha1) means two changesets became one Git commit:
    // fail loudly rather than map a Git commit to two changesets.
    await run(
      env,
      `INSERT INTO ${T.gitCommits}
         (${C.gitCommits.repoId}, ${C.gitCommits.csId}, ${C.gitCommits.sha1}, ${C.gitCommits.sha256})
       VALUES (?, ?, ?, ?)
       ON CONFLICT (${C.gitCommits.repoId}, ${C.gitCommits.csId}) DO NOTHING`,
      [storageId(repoId), c.id, ids.sha1, ids.sha256],
    );
    known.set(c.id, ids);
  }
  return known.get(cs.id) as GitIds;
}

const gitIdsSchema = z.object({ sha1: z.string(), sha256: z.string() });

export const gitIdsKind: DerivedKind<GitIds> = {
  name: GIT_IDS,
  eager: false,
  isolated: true,
  compute(env, repoId, cs) {
    return computeGitIds(env, repoId, cs);
  },
  parse(payload) {
    return gitIdsSchema.parse(JSON.parse(payload));
  },
};

registerKind(gitIdsKind);

/**
 * Stored Git commit IDs for a changeset, computing them on a miss
 * (cache-aside). Null for an unknown changeset or a failed computation.
 */
export async function ensureGitIds(
  env: Env,
  repoId: string,
  csId: string,
): Promise<GitIds | null> {
  const ids = await getDerived<GitIds>(env, repoId, GIT_IDS, csId);
  return ids === null || isSentinel(ids) ? null : ids;
}

/**
 * Commit hook: compute now when the change is small and every parent already
 * has IDs, else hand the changeset to the derived-data queue. Git IDs never
 * fail a commit.
 */
export async function scheduleGitIds(
  env: Env,
  repoId: string,
  cs: Changeset,
): Promise<void> {
  const message = { repo_id: repoId, kind: GIT_IDS, cs_id: cs.id };
  const bytes = cs.changed_files.reduce((sum, f) => sum + (f.size ?? 0), 0);
  const small = cs.changed_files.length <= EAGER_MAX_FILES && bytes <= EAGER_MAX_BYTES;
  const parentsReady =
    (await commitIdsForMany(env, repoId, cs.parents)).size === new Set(cs.parents).size;
  if (small && parentsReady) {
    try {
      await ensureGitIds(env, repoId, cs.id);
      return;
    } catch (err) {
      if (err instanceof DerivedDeferredError) {
        await enqueueDerived(env, [continuation(message, err)]);
        return;
      }
      console.error('git_ids: eager compute failed, deferring', cs.id, err);
    }
  }
  await enqueueDerived(env, [message]);
}
