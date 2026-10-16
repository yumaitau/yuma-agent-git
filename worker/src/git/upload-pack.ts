import type { Env } from '../env';
import type { RepoRecord } from '../db/client';
import { listRefs } from '../db/repos';
import { getBlob, hasBlob } from '../core/blobs';
import { getChangeset, type Changeset } from '../core/changesets';
import { continuation, DerivedDeferredError, enqueueDerived } from '../core/derived';
import { ensureGitIds, GIT_IDS } from '../core/derived/gitIds';
import { storeArtifact } from '../ci/artifacts';
import { ObjectCorruptError } from '../core/errors';
import { sha256Hex } from '../core/hashing';
import { AGENT_PREFIX } from '../core/refs';
import { getTree, type TreeEntry } from '../core/trees';
import {
  blobIdsFor,
  changesetForSha1,
  commitIdsForMany,
  gitCommitFor,
  gitTreeEntries,
  resolveSha1,
  treeIdsFor,
} from './mapping';
import { EMPTY_TREE, encodeCommit, encodeTree, type GitIds } from './objects';
import { packChunks, streamOf, type PackObject } from './pack-writer';
import {
  concatBytes,
  DELIM,
  FLUSH,
  GitProtocolError,
  PktReader,
  pktLine,
  pktText,
  sideband,
} from './pktline';

/**
 * Protocol v2 upload-pack (issue #31): `ls-refs` and `fetch` over smart
 * HTTP. Each POST is one stateless command. Packs are built on demand from
 * changesets, R2 trees and blobs and the #30 ID mapping, undeltified.
 *
 * Negotiation: a `have` the repo knows is common; any common have makes the
 * server `ready`. The commit walk stops at haves (and, without `deepen`, at
 * the client's shallow commits). History the client holds but did not name
 * may be sent again; that costs bytes, never correctness.
 */

export const AGENT = 'agent=yuma-agent-git/1';

const ZERO_SHA = '0'.repeat(40);
const SHA_RE = /^[0-9a-f]{40}$/;

/** Branches are short names inside the forge and `refs/heads/` in Git. */
export function gitRefName(name: string): string {
  return name.startsWith('refs/') ? name : `refs/heads/${name}`;
}

/** v2 capability advertisement (the GET `info/refs` body). */
export function advertiseV2(): Uint8Array {
  return concatBytes([
    ...[
      'version 2',
      AGENT,
      'ls-refs=unborn',
      'fetch=shallow filter',
      'object-format=sha1',
    ].map((line) => pktLine(`${line}\n`)),
    FLUSH,
  ]);
}

export interface V2Command {
  command: string;
  args: string[];
}

/** `command=…`, capability lines, an optional delimiter, arguments, flush. */
export function parseCommand(body: Uint8Array): V2Command {
  const reader = new PktReader(body);
  let command: string | null = null;
  let inArgs = false;
  const args: string[] = [];
  for (;;) {
    const pkt = reader.next();
    if (pkt === null) throw new GitProtocolError('request ended before a flush');
    if (pkt.kind === 'flush') break;
    if (pkt.kind === 'end') throw new GitProtocolError('unexpected response-end packet');
    if (pkt.kind === 'delim') {
      if (inArgs) throw new GitProtocolError('unexpected delimiter');
      inArgs = true;
      continue;
    }
    const line = pktText(pkt.data);
    if (inArgs) {
      args.push(line);
    } else if (line.startsWith('command=')) {
      if (command !== null) throw new GitProtocolError('more than one command');
      command = line.slice('command='.length);
    } else if (line.startsWith('object-format=') && line !== 'object-format=sha1') {
      throw new GitProtocolError('only object-format=sha1 is supported');
    }
    // agent=, session-id= and server-option= carry nothing we act on
  }
  if (!reader.done) throw new GitProtocolError('data after the final flush');
  if (command === null) throw new GitProtocolError('missing command');
  return { command, args };
}

/**
 * SHA-1s of changesets, computing missing IDs on demand. A history too long
 * to hash in one request is handed to the derived-data queue and the client
 * is told to retry.
 */
export async function commitShas(
  env: Env,
  repoId: string,
  csIds: string[],
): Promise<Map<string, string>> {
  const known = await commitIdsForMany(env, repoId, csIds);
  for (const id of new Set(csIds)) {
    if (known.has(id)) continue;
    let ids: GitIds | null = null;
    try {
      ids = await ensureGitIds(env, repoId, id);
    } catch (err) {
      if (!(err instanceof DerivedDeferredError)) throw err;
      await enqueueDerived(env, [
        continuation({ repo_id: repoId, kind: GIT_IDS, cs_id: id }, err),
      ]);
    }
    if (ids === null) {
      throw new GitProtocolError(
        'Git object IDs for this repository are still being computed; retry in a minute',
      );
    }
    known.set(id, ids);
  }
  return new Map([...known].map(([id, ids]) => [id, ids.sha1]));
}

// ---------------------------------------------------------------------------
// ls-refs
// ---------------------------------------------------------------------------

export async function lsRefs(
  env: Env,
  repo: RepoRecord,
  args: string[],
): Promise<Uint8Array> {
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg === 'peel')
      continue; // tags are lightweight: nothing to peel
    else if (arg.startsWith('ref-prefix '))
      prefixes.push(arg.slice('ref-prefix '.length));
    else throw new GitProtocolError(`unknown ls-refs argument ${JSON.stringify(arg)}`);
  }
  // Agent work refs stay hidden unless a prefix asks for them by name.
  const agentsAsked = prefixes.some((p) => p.startsWith(AGENT_PREFIX));
  const wanted = (name: string): boolean =>
    (prefixes.length === 0 || prefixes.some((p) => name.startsWith(p))) &&
    (!name.startsWith(AGENT_PREFIX) || agentsAsked);

  const all = (await listRefs(env, repo.id)).map((r) => ({
    name: gitRefName(r.name),
    head: r.head,
    branch: r.name,
  }));
  const refs = all.filter((r) => wanted(r.name));
  // HEAD resolves against every branch, not only the ones a prefix selected
  const head = wanted('HEAD')
    ? all.find((r) => r.branch === repo.default_branch)
    : undefined;
  const shas = await commitShas(
    env,
    repo.id,
    [...refs, ...(head ? [head] : [])].map((r) => r.head),
  );
  const lines: string[] = [];
  if (wanted('HEAD')) {
    const target = symrefs ? ` symref-target:refs/heads/${repo.default_branch}` : '';
    if (head) lines.push(`${shas.get(head.head)} HEAD${target}`);
    else if (unborn) lines.push(`unborn HEAD${target}`);
  }
  for (const ref of refs) lines.push(`${shas.get(ref.head)} ${ref.name}`);
  return concatBytes([...lines.map((l) => pktLine(`${l}\n`)), FLUSH]);
}

// ---------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------

type Filter = 'none' | 'blob:none' | 'tree:0';

export interface FetchRequest {
  wants: string[];
  haves: string[];
  done: boolean;
  shallow: string[];
  depth: number | null;
  filter: Filter;
}

function sha(arg: string, prefix: string): string {
  const value = arg.slice(prefix.length);
  if (!SHA_RE.test(value) || value === ZERO_SHA) {
    throw new GitProtocolError(`invalid object id in ${JSON.stringify(arg)}`);
  }
  return value;
}

export function parseFetchArgs(args: string[]): FetchRequest {
  const req: FetchRequest = {
    wants: [],
    haves: [],
    done: false,
    shallow: [],
    depth: null,
    filter: 'none',
  };
  for (const arg of args) {
    if (arg.startsWith('want ')) req.wants.push(sha(arg, 'want '));
    else if (arg.startsWith('have ')) req.haves.push(sha(arg, 'have '));
    else if (arg.startsWith('shallow ')) req.shallow.push(sha(arg, 'shallow '));
    else if (arg === 'done') req.done = true;
    else if (['thin-pack', 'no-progress', 'include-tag', 'ofs-delta'].includes(arg)) {
      continue; // packs are undeltified and tags lightweight: nothing to change
    } else if (arg.startsWith('deepen ')) {
      const depth = Number(arg.slice('deepen '.length));
      if (!Number.isInteger(depth) || depth < 1) {
        throw new GitProtocolError(`invalid ${JSON.stringify(arg)}`);
      }
      req.depth = depth;
    } else if (arg.startsWith('filter ')) {
      const spec = arg.slice('filter '.length);
      if (spec !== 'blob:none' && spec !== 'tree:0') {
        throw new GitProtocolError(
          `filter ${JSON.stringify(spec)} is not supported; use blob:none or tree:0`,
        );
      }
      req.filter = spec;
    } else if (/^deepen-(relative|since|not)\b/.test(arg)) {
      throw new GitProtocolError(
        `${arg.split(' ')[0]} is not supported; use --depth=<n> or --unshallow`,
      );
    } else {
      throw new GitProtocolError(`unknown fetch argument ${JSON.stringify(arg)}`);
    }
  }
  if (req.wants.length === 0) throw new GitProtocolError('fetch needs at least one want');
  return req;
}

interface CommitPlan {
  /** Changesets to send, keyed by id, in walk order. */
  sent: Map<string, Changeset>;
  shallow: string[];
  unshallow: string[];
}

/** Breadth-first from the wants; `depth` counts the wants as 1. */
async function planCommits(
  env: Env,
  repoId: string,
  wants: string[],
  haves: Set<string>,
  clientShallow: Set<string>,
  depth: number | null,
): Promise<CommitPlan> {
  const plan: CommitPlan = { sent: new Map(), shallow: [], unshallow: [] };
  const queue: [string, number][] = wants.map((id) => [id, 1]);
  const seen = new Set(wants);
  for (let i = 0; i < queue.length; i++) {
    const [id, d] = queue[i] as [string, number];
    // Without deepen the client has these and owns their history.
    if (depth === null && (haves.has(id) || clientShallow.has(id))) continue;
    const cs = await getChangeset(env, repoId, id);
    if (cs === null) throw new Error(`changeset ${id} missing while fetching`);
    if (!haves.has(id)) plan.sent.set(id, cs);
    if (depth !== null && d >= depth) {
      if (cs.parents.length > 0) plan.shallow.push(id);
      continue;
    }
    if (clientShallow.has(id) && cs.parents.length > 0) plan.unshallow.push(id);
    for (const parent of cs.parents) {
      if (seen.has(parent)) continue;
      seen.add(parent);
      queue.push([parent, d + 1]);
    }
  }
  return plan;
}

interface ObjectPlan {
  trees: Map<string, TreeEntry[]>;
  blobs: Set<string>;
}

/**
 * Trees and blobs for the sent commits. A commit whose first parent the
 * client has (or receives) sends only what differs from that parent's tree;
 * otherwise (a root or a shallow boundary) its whole tree.
 */
async function planObjects(
  env: Env,
  repoId: string,
  commits: CommitPlan,
  available: (id: string) => boolean,
  filter: Filter,
  wantedTrees: string[],
  wantedBlobs: string[],
): Promise<ObjectPlan> {
  const plan: ObjectPlan = { trees: new Map(), blobs: new Set(wantedBlobs) };
  const cache = new Map<string, TreeEntry[]>();
  const read = async (hash: string): Promise<TreeEntry[]> => {
    let entries = cache.get(hash);
    if (!entries) {
      const tree = await getTree(env, repoId, hash);
      if (tree === null)
        throw new ObjectCorruptError('tree', hash, 'missing while fetching');
      entries = tree.entries;
      cache.set(hash, entries);
    }
    return entries;
  };
  const add = async (hash: string, base: string | null): Promise<void> => {
    if (hash === base || plan.trees.has(hash)) return;
    const entries = await read(hash);
    plan.trees.set(hash, entries);
    if (filter === 'tree:0') return;
    const baseEntries = new Map((base ? await read(base) : []).map((e) => [e.name, e]));
    for (const entry of entries) {
      const old = baseEntries.get(entry.name);
      if (old && old.kind === entry.kind && old.hash === entry.hash) continue;
      if (entry.kind === 'tree')
        await add(entry.hash, old?.kind === 'tree' ? old.hash : null);
      else if (filter === 'none') plan.blobs.add(entry.hash);
    }
  };

  for (const cs of commits.sent.values()) {
    if (filter === 'tree:0' || cs.root_tree === null) continue;
    let base: string | null = null;
    const parent = cs.first_parent;
    if (parent !== null && available(parent)) {
      const parentCs =
        commits.sent.get(parent) ?? (await getChangeset(env, repoId, parent));
      base = parentCs?.root_tree ?? null;
    }
    await add(cs.root_tree, base);
  }
  for (const hash of wantedTrees) await add(hash, null);
  return plan;
}

/** Clone packs with at least this many objects are kept in R2 (#78). */
export const PACK_CACHE_MIN_OBJECTS = 1000;
export const PACK_CACHE_MAX_BYTES = 2 * 1024 ** 3;
export const PACK_CACHE_PREFIX = 'git/packs/';

/**
 * Where a clone's pack is kept: the wants, depth and filter fix its content,
 * because commits are immutable. An R2 lifecycle rule on `git/packs/` expires
 * old entries (docs/git-http.md).
 */
export async function packCacheKey(
  repoId: string,
  wants: string[],
  depth: number | null,
  filter: Filter,
): Promise<string> {
  const id = await sha256Hex(
    new TextEncoder().encode(JSON.stringify([[...wants].sort(), depth, filter])),
  );
  return `${PACK_CACHE_PREFIX}${repoId}/${id}.pack`;
}

/** Build the fetch response: acknowledgments, shallow-info, then the pack. */
export async function fetchPack(
  env: Env,
  repoId: string,
  args: string[],
): Promise<ReadableStream<Uint8Array>> {
  const req = parseFetchArgs(args);

  const common: string[] = [];
  const haves = new Set<string>();
  for (const have of req.haves) {
    const id = await changesetForSha1(env, repoId, have);
    if (id === null) continue;
    common.push(have);
    haves.add(id);
  }
  const head: Uint8Array[] = [];
  if (!req.done) {
    head.push(pktLine('acknowledgments\n'));
    if (common.length === 0) {
      head.push(pktLine('NAK\n'), FLUSH);
      return streamOf(
        (async function* () {
          yield concatBytes(head);
        })(),
      );
    }
    for (const have of common) head.push(pktLine(`ACK ${have}\n`));
    head.push(pktLine('ready\n'), DELIM);
  }

  const wantCommits: string[] = [];
  const wantTrees: string[] = [];
  const wantBlobs: string[] = [];
  for (const want of req.wants) {
    const ref = await resolveSha1(env, repoId, want);
    if (ref === null) throw new GitProtocolError(`upload-pack: not our ref ${want}`);
    if (ref.type === 'commit') wantCommits.push(ref.id);
    else if (ref.type === 'tree') wantTrees.push(ref.id);
    else wantBlobs.push(ref.id);
  }
  // git_blobs rows are global; the blob must also be stored in this repo
  const present = await hasBlob(env, repoId, wantBlobs);
  if (wantBlobs.some((b) => !present.has(b))) {
    throw new GitProtocolError('upload-pack: not our ref');
  }
  const clientShallow = new Set<string>();
  for (const s of req.shallow) {
    const id = await changesetForSha1(env, repoId, s);
    if (id !== null) clientShallow.add(id);
  }

  // A clone (nothing held) names immutable history: its pack can be reused (#78).
  const cacheKey =
    haves.size === 0 && clientShallow.size === 0
      ? await packCacheKey(repoId, req.wants, req.depth, req.filter)
      : null;
  const cached = cacheKey ? await env.OBJECTS.get(cacheKey) : null;
  if (cached) {
    const shallow = JSON.parse(cached.customMetadata?.shallow ?? '[]') as string[];
    return streamOf(
      (async function* () {
        yield concatBytes(head);
        if (shallow.length > 0)
          yield concatBytes([...shallow.map((l) => pktLine(`${l}\n`)), DELIM]);
        yield pktLine('packfile\n');
        try {
          for await (const chunk of cached.body as unknown as AsyncIterable<Uint8Array>)
            yield concatBytes(sideband(1, chunk));
        } catch (err) {
          console.error('upload-pack: cached pack stream failed', err);
          yield concatBytes(sideband(3, 'error reading pack; retry the fetch\n'));
        }
        yield FLUSH;
      })(),
    );
  }

  const commits = await planCommits(
    env,
    repoId,
    wantCommits,
    haves,
    clientShallow,
    req.depth,
  );
  const objects = await planObjects(
    env,
    repoId,
    commits,
    (id) => commits.sent.has(id) || haves.has(id) || clientShallow.has(id),
    req.filter,
    wantTrees,
    wantBlobs,
  );

  // Git IDs for everything the bodies name, in batched lookups.
  const sentCs = [...commits.sent.values()];
  const commitIds = await commitIdsForMany(env, repoId, [
    ...sentCs.map((cs) => cs.id),
    ...sentCs.flatMap((cs) => cs.parents),
  ]);
  const treeHashes = new Set<string>(objects.trees.keys());
  const blobHashes = new Set<string>(objects.blobs);
  for (const cs of sentCs) if (cs.root_tree !== null) treeHashes.add(cs.root_tree);
  for (const entries of objects.trees.values()) {
    for (const e of entries) (e.kind === 'tree' ? treeHashes : blobHashes).add(e.hash);
  }
  const treeIds = await treeIdsFor(env, repoId, [...treeHashes]);
  const blobIds = await blobIdsFor(env, [...blobHashes]);
  if (
    sentCs.some(
      (cs) => !commitIds.has(cs.id) || cs.parents.some((p) => !commitIds.has(p)),
    ) ||
    treeIds.size !== treeHashes.size ||
    blobIds.size !== blobHashes.size
  ) {
    throw new GitProtocolError(
      'Git object IDs for this repository are still being computed; retry in a minute',
    );
  }

  // One pack entry per Git ID (two of our trees can encode the same Git tree).
  const trees = new Map<string, string>();
  if (sentCs.some((cs) => cs.root_tree === null) && req.filter !== 'tree:0') {
    trees.set(EMPTY_TREE.sha1, '');
  }
  for (const hash of objects.trees.keys()) {
    const id = (treeIds.get(hash) as GitIds).sha1;
    if (!trees.has(id)) trees.set(id, hash);
  }
  const blobs = new Map<string, string>();
  for (const hash of objects.blobs) blobs.set((blobIds.get(hash) as GitIds).sha1, hash);

  const bodies = async function* (): AsyncGenerator<PackObject> {
    for (const cs of sentCs) {
      const tree =
        cs.root_tree === null ? EMPTY_TREE : (treeIds.get(cs.root_tree) as GitIds);
      const parents = cs.parents.map((p) => commitIds.get(p) as GitIds);
      yield {
        type: 'commit',
        body: encodeCommit(gitCommitFor(cs, tree, parents), 'sha1'),
      };
    }
    for (const hash of trees.values()) {
      const entries = hash === '' ? [] : (objects.trees.get(hash) as TreeEntry[]);
      yield {
        type: 'tree',
        body: encodeTree(gitTreeEntries(entries, treeIds, blobIds), 'sha1'),
      };
    }
    for (const hash of blobs.values()) {
      const blob = await getBlob(env, repoId, hash);
      if (blob === null)
        throw new ObjectCorruptError('blob', hash, 'missing while fetching');
      yield { type: 'blob', body: blob.content };
    }
  };
  const count = sentCs.length + trees.size + blobs.size;

  const shallowLines: string[] = [];
  if (req.depth !== null || commits.shallow.length > 0 || commits.unshallow.length > 0) {
    const ids = await commitIdsForMany(env, repoId, [
      ...commits.shallow,
      ...commits.unshallow,
    ]);
    shallowLines.push('shallow-info');
    for (const id of commits.shallow) shallowLines.push(`shallow ${ids.get(id)?.sha1}`);
    for (const id of commits.unshallow)
      shallowLines.push(`unshallow ${ids.get(id)?.sha1}`);
  }

  // Large clone packs are copied to R2 as they stream; the copy is kept only if complete.
  const shallowMeta = JSON.stringify(shallowLines);
  let cache: WritableStreamDefaultWriter<Uint8Array> | null = null;
  let stored: Promise<unknown> = Promise.resolve();
  if (cacheKey && count >= PACK_CACHE_MIN_OBJECTS && shallowMeta.length <= 1024) {
    const pipe = new TransformStream<Uint8Array, Uint8Array>();
    cache = pipe.writable.getWriter();
    stored = storeArtifact(env.OBJECTS, cacheKey, pipe.readable, PACK_CACHE_MAX_BYTES, {
      customMetadata: { shallow: shallowMeta },
    }).catch(() => {
      cache = null;
    });
  }

  return streamOf(
    (async function* () {
      yield concatBytes(head);
      if (shallowLines.length > 0) {
        yield concatBytes([...shallowLines.map((l) => pktLine(`${l}\n`)), DELIM]);
      }
      yield pktLine('packfile\n');
      try {
        for await (const chunk of packChunks(count, bodies())) {
          yield concatBytes(sideband(1, chunk));
          await cache?.write(chunk).catch(() => (cache = null));
        }
        await cache?.close().catch(() => {});
        await stored;
      } catch (err) {
        await cache?.abort(err).catch(() => {});
        console.error('upload-pack: pack stream failed', err);
        yield concatBytes(sideband(3, 'error building pack; retry the fetch\n'));
      }
      yield FLUSH;
    })(),
  );
}
