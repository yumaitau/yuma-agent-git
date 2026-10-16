import type { Env } from '../env';
import type { Committer } from '../db/client';
import { dagMergeBases } from './ancestry';
import { getChangeset, type Changeset } from './changesets';
import { commitChanges } from './commit';
import { ConflictError } from './errors';
import { conflictError, mergeTrees } from './merge';

/**
 * Rebase (issue #42): replay changesets onto a new base, `git rebase` style.
 * Each one is a three-way merge of its own change (its first parent → it)
 * into the new tip, keeping author, author time and message; the committer
 * is whoever asked. Stops at the first conflict, before any ref moves.
 */

/**
 * The changesets on `head` that `onto` lacks (git `onto..head`), parents
 * first. Merge commits are refused: replaying them could drop a resolution.
 */
export async function replayable(
  env: Env,
  repoId: string,
  onto: string,
  head: string,
): Promise<Changeset[]> {
  const { onlyB } = await dagMergeBases(env, repoId, onto, head);
  if (onlyB.some((cs) => cs.parents.length > 1))
    throw new ConflictError(
      'rebase_unsupported',
      'These changes include merge commits, which cannot be rebased. Use a merge commit or squash instead.',
    );
  // without merges they form one chain down from `head`
  const byId = new Map(onlyB.map((cs) => [cs.id, cs]));
  const chain: Changeset[] = [];
  for (let cs = byId.get(head); cs; cs = byId.get(cs.first_parent ?? '')) chain.push(cs);
  return chain.reverse();
}

/**
 * Replay `commits` (parents first) onto `onto`. A changeset whose change is
 * already there is skipped. Throws `merge_conflict` naming the changeset that
 * stopped the replay (`at`).
 */
export async function replay(
  env: Env,
  repoId: string,
  commits: readonly Changeset[],
  onto: Changeset,
  committer: Committer,
): Promise<Changeset> {
  let tip = onto;
  for (const cs of commits) {
    const parent =
      cs.first_parent === null ? null : await getChangeset(env, repoId, cs.first_parent);
    const merged = await mergeTrees(
      env,
      repoId,
      parent?.root_tree ?? null,
      tip.root_tree,
      cs.root_tree,
    );
    if (merged.conflicts.length > 0) throw conflictError(merged.conflicts, { at: cs.id });
    if (merged.changes.length === 0) continue;
    const result = await commitChanges(env, repoId, {
      first_parent: tip.id,
      message: cs.message,
      author: cs.author,
      created_at: cs.created_at,
      changes: merged.changes,
      committer,
      ...(cs.author_tz ? { author_tz: cs.author_tz } : {}),
    });
    tip = result.changeset;
  }
  return tip;
}

/** Rebase the changes `head` adds over `onto`; returns the new tip. */
export async function rebaseOnto(
  env: Env,
  repoId: string,
  onto: Changeset,
  head: string,
  committer: Committer,
): Promise<Changeset> {
  return replay(
    env,
    repoId,
    await replayable(env, repoId, onto.id, head),
    onto,
    committer,
  );
}
