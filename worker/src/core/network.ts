import { ulid } from './ids';

/**
 * Fork networks (issue #36). A fork's id is `<root id>~<ulid>`, so every
 * repo in a network maps to the root's id for content: changesets, trees,
 * blobs, Git ID mappings, derived data and LFS objects. Forking therefore
 * copies refs only, and a fork's commits are already readable from the
 * upstream when a pull request merges them. Refs, members, pulls and every
 * other repo-scoped row keep the repo's own id.
 *
 * Content ids are content addresses, so a repo in a network can read any
 * object of the network by id (as on GitHub). Access control stays on refs:
 * listings, clones and pulls only start from refs the caller can read.
 */
const SEP = '~';

/** The id content is stored under: the network root's. */
export function storageId(repoId: string): string {
  const at = repoId.indexOf(SEP);
  return at < 0 ? repoId : repoId.slice(0, at);
}

/** A new fork id in `upstreamId`'s network. */
export function forkRepoId(upstreamId: string, now: number = Date.now()): string {
  return `${storageId(upstreamId)}${SEP}${ulid(now)}`;
}

/** Whether two repos share content storage. */
export function sameNetwork(a: string, b: string): boolean {
  return storageId(a) === storageId(b);
}
