import type { Env } from '../env';
import { q, q1 } from '../db/client';
import { C, T } from '../db/schema';
import { getBlob } from '../core/blobs';
import { getChangeset, type Changeset } from '../core/changesets';
import { ObjectCorruptError } from '../core/errors';
import { getTree, type TreeEntry } from '../core/trees';
import { storageId } from '../core/network';
import { commitSignatures } from './identity';
import {
  EMPTY_TREE,
  TREE_MODE,
  encodeCommit,
  encodeTree,
  gitObjectId,
  type GitCommit,
  type GitIds,
  type GitObjectType,
  type GitTreeEntry,
} from './objects';

/**
 * Stored Git ID mapping (issue #30), the API fetch/push (#31, #32) build on.
 * Every lookup is one indexed D1 query: `git_commits` by `(repo_id, cs_id)` or
 * `(repo_id, sha1)`, `git_trees` by `(repo_id, tree_hash)` or `(repo_id, sha1)`,
 * `git_blobs` by `blob_hash` or `sha1`. Rows are written by the `git_ids`
 * derived kind (`core/derived/gitIds.ts`).
 *
 * Nothing here applies path rules: callers serving clients must (auth/guards.ts).
 */

/** D1 caps bound parameters per statement; IN lists are chunked below this. */
const IN_CHUNK = 90;

function idsOf(row: Record<string, unknown>): GitIds {
  return { sha1: String(row.sha1), sha256: String(row.sha256) };
}

async function lookupMany(
  env: Env,
  sql: (marks: string) => string,
  prefix: unknown[],
  keys: string[],
  keyColumn: string,
): Promise<Map<string, GitIds>> {
  const out = new Map<string, GitIds>();
  const unique = [...new Set(keys)];
  for (let i = 0; i < unique.length; i += IN_CHUNK) {
    const chunk = unique.slice(i, i + IN_CHUNK);
    const rows = await q(env, sql(chunk.map(() => '?').join(', ')), [
      ...prefix,
      ...chunk,
    ]);
    for (const row of rows) out.set(String(row[keyColumn]), idsOf(row));
  }
  return out;
}

/** Changeset → Git commit IDs (null until computed). */
export async function commitIdsFor(
  env: Env,
  repoId: string,
  csId: string,
): Promise<GitIds | null> {
  const row = await q1(
    env,
    `SELECT ${C.gitCommits.sha1}, ${C.gitCommits.sha256} FROM ${T.gitCommits}
      WHERE ${C.gitCommits.repoId} = ? AND ${C.gitCommits.csId} = ?`,
    [storageId(repoId), csId],
  );
  return row ? idsOf(row) : null;
}

export function commitIdsForMany(
  env: Env,
  repoId: string,
  csIds: string[],
): Promise<Map<string, GitIds>> {
  return lookupMany(
    env,
    (marks) =>
      `SELECT ${C.gitCommits.csId}, ${C.gitCommits.sha1}, ${C.gitCommits.sha256}
         FROM ${T.gitCommits}
        WHERE ${C.gitCommits.repoId} = ? AND ${C.gitCommits.csId} IN (${marks})`,
    [storageId(repoId)],
    csIds,
    C.gitCommits.csId,
  );
}

/** Git commit SHA-1 → changeset id. */
export async function changesetForSha1(
  env: Env,
  repoId: string,
  sha1: string,
): Promise<string | null> {
  const row = await q1(
    env,
    `SELECT ${C.gitCommits.csId} FROM ${T.gitCommits}
      WHERE ${C.gitCommits.repoId} = ? AND ${C.gitCommits.sha1} = ?`,
    [storageId(repoId), sha1],
  );
  return row ? String(row[C.gitCommits.csId]) : null;
}

/** Our tree hashes → Git tree IDs (only the computed ones). */
export function treeIdsFor(
  env: Env,
  repoId: string,
  treeHashes: string[],
): Promise<Map<string, GitIds>> {
  return lookupMany(
    env,
    (marks) =>
      `SELECT ${C.gitTrees.treeHash}, ${C.gitTrees.sha1}, ${C.gitTrees.sha256}
         FROM ${T.gitTrees}
        WHERE ${C.gitTrees.repoId} = ? AND ${C.gitTrees.treeHash} IN (${marks})`,
    [storageId(repoId)],
    treeHashes,
    C.gitTrees.treeHash,
  );
}

/** Our blob hashes → Git blob IDs (only the computed ones). */
export function blobIdsFor(env: Env, blobHashes: string[]): Promise<Map<string, GitIds>> {
  return lookupMany(
    env,
    (marks) =>
      `SELECT ${C.gitBlobs.blobHash}, ${C.gitBlobs.sha1}, ${C.gitBlobs.sha256}
         FROM ${T.gitBlobs} WHERE ${C.gitBlobs.blobHash} IN (${marks})`,
    [],
    blobHashes,
    C.gitBlobs.blobHash,
  );
}

export interface GitObjectRef {
  type: GitObjectType;
  /** Our address: changeset id, tree hash or blob hash. */
  id: string;
}

/**
 * Git SHA-1 → what it names in this repo, in one query (each branch indexed).
 * Blob rows are global, so callers must still read the blob from this repo.
 */
export async function resolveSha1(
  env: Env,
  repoId: string,
  sha1: string,
): Promise<GitObjectRef | null> {
  const row = await q1(
    env,
    `SELECT 'commit' AS type, ${C.gitCommits.csId} AS id FROM ${T.gitCommits}
      WHERE ${C.gitCommits.repoId} = ?1 AND ${C.gitCommits.sha1} = ?2
     UNION ALL
     SELECT 'tree', ${C.gitTrees.treeHash} FROM ${T.gitTrees}
      WHERE ${C.gitTrees.repoId} = ?1 AND ${C.gitTrees.sha1} = ?2
     UNION ALL
     SELECT 'blob', ${C.gitBlobs.blobHash} FROM ${T.gitBlobs}
      WHERE ${C.gitBlobs.sha1} = ?2
     LIMIT 1`,
    [storageId(repoId), sha1],
  );
  if (!row) return null;
  return { type: row.type as GitObjectType, id: String(row.id) };
}

/** A changeset as a Git commit, given its tree and parent IDs. */
export function gitCommitFor(cs: Changeset, tree: GitIds, parents: GitIds[]): GitCommit {
  const { author, committer } = commitSignatures(cs);
  return {
    tree,
    parents,
    author,
    committer,
    extraHeaders: cs.git_extra_headers,
    gpgsig: cs.gpgsig,
    message: cs.message,
  };
}

/** Git entries for one of our trees, given the child IDs. */
export function gitTreeEntries(
  entries: TreeEntry[],
  trees: Map<string, GitIds>,
  blobs: Map<string, GitIds>,
): GitTreeEntry[] {
  return entries.map((entry) => {
    const ids = (entry.kind === 'tree' ? trees : blobs).get(entry.hash);
    if (!ids) throw new Error(`git ids missing for ${entry.kind} ${entry.hash}`);
    return {
      name: entry.name,
      mode: entry.kind === 'tree' ? TREE_MODE : (entry.mode ?? '100644'),
      ids,
    };
  });
}

export interface GitObject {
  type: GitObjectType;
  /** The object body; `gitObjectBytes(type, body)` is its loose form. */
  body: Uint8Array;
}

/**
 * Raw object bytes for a Git SHA-1 in this repo, rebuilt from our stores and
 * checked against the ID. Null when the repo has no such (computed) object.
 */
export async function readGitObject(
  env: Env,
  repoId: string,
  sha1: string,
): Promise<GitObject | null> {
  if (sha1 === EMPTY_TREE.sha1) return { type: 'tree', body: new Uint8Array() };
  const ref = await resolveSha1(env, repoId, sha1);
  if (ref === null) return null;

  let body: Uint8Array;
  if (ref.type === 'blob') {
    const blob = await getBlob(env, repoId, ref.id);
    if (blob === null) return null; // another repo's content
    body = blob.content;
  } else if (ref.type === 'tree') {
    const tree = await getTree(env, repoId, ref.id);
    if (tree === null) throw new ObjectCorruptError('tree', ref.id, 'missing for git id');
    const trees = await treeIdsFor(
      env,
      repoId,
      tree.entries.filter((e) => e.kind === 'tree').map((e) => e.hash),
    );
    const blobs = await blobIdsFor(
      env,
      tree.entries.filter((e) => e.kind === 'blob').map((e) => e.hash),
    );
    body = encodeTree(gitTreeEntries(tree.entries, trees, blobs), 'sha1');
  } else {
    const cs = await getChangeset(env, repoId, ref.id);
    if (cs === null) return null;
    const tree =
      cs.root_tree === null
        ? EMPTY_TREE
        : (await treeIdsFor(env, repoId, [cs.root_tree])).get(cs.root_tree);
    const parents = await commitIdsForMany(env, repoId, cs.parents);
    if (!tree || parents.size !== new Set(cs.parents).size) {
      throw new Error(`git ids incomplete for changeset ${cs.id}`);
    }
    const commit = gitCommitFor(
      cs,
      tree,
      cs.parents.map((p) => parents.get(p) as GitIds),
    );
    body = encodeCommit(commit, 'sha1');
  }
  if ((await gitObjectId(ref.type, body, 'sha1')) !== sha1) {
    throw new Error(`git ${ref.type} ${sha1} does not rebuild to its id`);
  }
  return { type: ref.type, body };
}
