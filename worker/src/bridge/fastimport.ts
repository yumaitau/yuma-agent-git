import type { Env } from '../env';
import { getBlob } from '../core/blobs';
import { ancestorsParentsFirst, getChangeset, type Changeset } from '../core/changesets';
import { ensureGitIds } from '../core/derived/gitIds';
import { NotFoundError, ObjectWalkLimitError } from '../core/errors';
import { getTree, type Tree, type TreeEntry } from '../core/trees';
import { commitSignatures } from '../git/identity';
import { formatSignature } from '../git/objects';

/**
 * `git fast-import` stream generation (issue #16) — the off-ramp that lets any
 * git client bootstrap a yag repo with:
 *
 *   curl …/export/fast-import?head=<rev> | git fast-import
 *
 * Contract: a **plain** vanilla-compatible stream (no `feature` directives),
 * deterministic — same head ⇒ byte-identical bytes (marks in tree DFS / commit
 * order) — and bounded-memory: an async generator pulls blobs one at a time,
 * so at most one is ever materialized.
 *
 * Full mode rebuilds the stored Git IDs (issue #30): `git rev-parse HEAD`
 * after import equals `git_commits.sha1` of the head, because identities, time
 * zones, parents and modes come from the same mapping. Fast-import cannot
 * write `gpgsig` or extra headers, so signed commits only round-trip through
 * the Git protocol, not this stream.
 */

export interface FastImportOptions {
  mode?: 'snapshot' | 'full' | 'ranged';
  /** Ranged mode: export (from, to] — `from` exclusive. */
  from?: string;
  maxCommits?: number;
}

const encoder = new TextEncoder();

function line(text: string): Uint8Array {
  return encoder.encode(`${text}\n`);
}

function dataBlock(text: string): Uint8Array {
  const body = encoder.encode(text);
  return rawBlock('data ', body);
}

function rawBlock(header: string, body: Uint8Array): Uint8Array {
  const head = encoder.encode(`${header}${body.byteLength}\n`);
  const out = new Uint8Array(head.length + body.length + 1);
  out.set(head, 0);
  out.set(body, head.length);
  out[head.length + body.length] = 0x0a;
  return out;
}

/** The commit header lines Git hashes: same identities as the stored Git IDs. */
function* commitLines(cs: Changeset): Generator<Uint8Array> {
  const { author, committer } = commitSignatures(cs);
  yield line(`author ${formatSignature(author)}`);
  yield line(`committer ${formatSignature(committer)}`);
  yield dataBlock(cs.message);
}

/** File mode of `path` in a changeset's tree (trees read once per commit). */
async function modeAt(
  env: Env,
  repoId: string,
  rootTree: string | null,
  path: string,
  cache: Map<string, Tree | null>,
): Promise<string> {
  let hash = rootTree;
  const segments = path.split('/');
  for (let i = 0; hash !== null && i < segments.length; i++) {
    if (!cache.has(hash)) cache.set(hash, await getTree(env, repoId, hash));
    const entry = cache.get(hash)?.entries.find((e) => e.name === segments[i]);
    if (!entry) break;
    if (i === segments.length - 1) return entry.mode ?? '100644';
    hash = entry.kind === 'tree' ? entry.hash : null;
  }
  return '100644';
}

interface TreeFile {
  path: string;
  hash: string;
  mode: string;
}

/** All files under a tree in DFS (sorted-name) order — deterministic marks. */
export async function treeFiles(
  env: Env,
  repoId: string,
  rootTree: string,
  base = '',
): Promise<TreeFile[]> {
  const out: TreeFile[] = [];
  const walk = async (hash: string, prefix: string): Promise<void> => {
    const tree = await getTree(env, repoId, hash);
    if (!tree) return;
    for (const item of [...tree.entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = prefix === '' ? item.name : `${prefix}/${item.name}`;
      if (item.kind === 'tree') {
        await walk(item.hash, path);
      } else {
        out.push({ path, hash: item.hash, mode: item.mode ?? '100644' });
      }
    }
  };
  await walk(rootTree, base);
  return out;
}

/** Raise the stream into a Response-ready async generator (bounded memory). */
export async function* fastImportChunks(
  env: Env,
  repoId: string,
  headCs: string,
  opts: FastImportOptions = {},
): AsyncGenerator<Uint8Array> {
  const mode = opts.mode ?? 'snapshot';
  const maxCommits = opts.maxCommits ?? 10_000;

  const head = await getChangeset(env, repoId, headCs);
  if (!head) throw new NotFoundError('revision_not_found', `no changeset ${headCs}`);

  let mark = 0;

  if (mode === 'snapshot') {
    // one commit carrying the whole tree at head
    const files = await treeFiles(env, repoId, head.root_tree as string);
    const ops: string[] = [];
    for (const file of files) {
      const blob = await getBlob(env, repoId, file.hash);
      if (!blob) continue;
      const blobMark = ++mark;
      yield line('blob');
      yield line(`mark :${blobMark}`);
      yield rawBlock('data ', blob.content);
      ops.push(`M ${file.mode} :${blobMark} ${file.path}`);
    }
    const commitMark = ++mark;
    yield line('commit refs/heads/main');
    yield line(`mark :${commitMark}`);
    yield* commitLines(head);
    for (const op of ops) yield line(op);
    yield line('');
    yield line('done');
    return;
  }

  // full / ranged: every ancestor (merges too), parents first, incremental
  // fileops. Ranged mode skips `from` and its ancestors and names parents
  // outside the range by their stored Git IDs, which the target already has.
  let history: Changeset[];
  try {
    const exclude = new Set<string>();
    if (mode === 'ranged' && opts.from) {
      for (const cs of await ancestorsParentsFirst(env, repoId, opts.from, maxCommits)) {
        exclude.add(cs.id);
      }
    }
    history = await ancestorsParentsFirst(env, repoId, headCs, maxCommits, (id) =>
      exclude.has(id),
    );
  } catch (err) {
    if (err instanceof ObjectWalkLimitError) throw new Error('too-many-commits');
    throw err;
  }

  const marks = new Map<string, number>();
  for (const cs of history) {
    const parents: string[] = [];
    for (const parentId of cs.parents) {
      const parentMark = marks.get(parentId);
      if (parentMark !== undefined) {
        parents.push(`:${parentMark}`);
        continue;
      }
      const ids = await ensureGitIds(env, repoId, parentId);
      if (!ids)
        throw new NotFoundError('revision_not_found', `no git id for ${parentId}`);
      parents.push(ids.sha1);
    }
    // changed_files semantics 1:1 — M/D per change (vs first parent), modes
    // from the changeset's own tree; blobs go before their commit command
    const trees = new Map<string, Tree | null>();
    const ops: string[] = [];
    for (const change of cs.changed_files) {
      if (change.op === 'del') {
        ops.push(`D ${change.path}`);
        continue;
      }
      const blob = await getBlob(env, repoId, change.hash as string);
      if (!blob) continue;
      const blobMark = ++mark;
      yield line('blob');
      yield line(`mark :${blobMark}`);
      yield rawBlock('data ', blob.content);
      const fileMode = await modeAt(env, repoId, cs.root_tree, change.path, trees);
      ops.push(`M ${fileMode} :${blobMark} ${change.path}`);
    }
    // a later root must not continue from the branch tip
    if (parents.length === 0 && marks.size > 0) yield line('reset refs/heads/main');
    yield line('commit refs/heads/main');
    const commitMark = ++mark;
    yield line(`mark :${commitMark}`);
    yield* commitLines(cs);
    const [first, ...merges] = parents;
    if (first !== undefined) yield line(`from ${first}`);
    for (const merge of merges) yield line(`merge ${merge}`);
    for (const op of ops) yield line(op);
    yield line('');
    marks.set(cs.id, commitMark);
  }
  yield line('done');
}

/** Wrap the generator as a pull-based stream (one chunk in flight). */
export function fastImportStream(
  env: Env,
  repoId: string,
  headCs: string,
  opts: FastImportOptions = {},
): ReadableStream<Uint8Array> {
  const iterator = fastImportChunks(env, repoId, headCs, opts);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) {
        controller.close();
        return;
      }
      controller.enqueue(next.value);
    },
  });
}

export type { TreeEntry };
