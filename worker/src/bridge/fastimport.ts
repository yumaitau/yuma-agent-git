import type { Env } from '../env';
import { getBlob } from '../core/blobs';
import { firstParentHistory, getChangeset, type Changeset } from '../core/changesets';
import { NotFoundError } from '../core/errors';
import { getTree, type TreeEntry } from '../core/trees';

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

function signature(cs: Changeset): string {
  const name = 'name' in cs.author ? cs.author.name : cs.author.agent;
  const email = 'email' in cs.author ? cs.author.email : 'agent@yuma-agent-git';
  return `${name} <${email}> ${Math.floor(cs.created_at / 1000)} +0000`;
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
    yield line(`author ${signature(head)}`);
    yield line(`committer ${signature(head)}`);
    yield dataBlock(head.message);
    for (const op of ops) yield line(op);
    yield line('');
    yield line('done');
    return;
  }

  // full / ranged: first-parent history oldest → newest, incremental fileops
  let history = await firstParentHistory(env, repoId, headCs, maxCommits + 1);
  if (history.length > maxCommits) {
    throw new Error('too-many-commits');
  }
  history = history.reverse();
  if (mode === 'ranged' && opts.from) {
    const index = history.findIndex((cs) => cs.id === opts.from);
    history = index >= 0 ? history.slice(index + 1) : history;
  }

  let parentMark: number | null = null;
  for (const cs of history) {
    yield line('commit refs/heads/main');
    const commitMark = ++mark;
    yield line(`mark :${commitMark}`);
    if (parentMark !== null) yield line(`from :${parentMark}`);
    yield line(`author ${signature(cs)}`);
    yield line(`committer ${signature(cs)}`);
    yield dataBlock(cs.message);
    // changed_files semantics 1:1 — M/D per change, only that commit's files
    for (const change of cs.changed_files) {
      if (change.op === 'del') {
        yield line(`D ${change.path}`);
        continue;
      }
      const blob = await getBlob(env, repoId, change.hash as string);
      if (!blob) continue;
      const blobMark = ++mark;
      yield line('blob');
      yield line(`mark :${blobMark}`);
      yield rawBlock('data ', blob.content);
      yield line(`M 100644 :${blobMark} ${change.path}`);
    }
    yield line('');
    parentMark = commitMark;
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
