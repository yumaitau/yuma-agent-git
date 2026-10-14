import { z } from 'zod';
import type { Env } from '../env';
import { authorSchema, type FileChange } from '../db/client';
import { hasBlob, putBlob, statBlob } from './blobs';
import {
  computeChangesetId,
  createChangeset,
  getChangeset,
  pathSchema,
  type Changeset,
  type ChangesetFields,
} from './changesets';
import { PayloadTooLargeError, RequestValidationError } from './errors';
import { computeSkipList } from './ancestry';
import { sha256Hex } from './hashing';
import { lookupRev } from './read';
import { getTree, putTree, resolvePath, type Tree, type TreeEntry } from './trees';

/** Max inline content per file in a commit request (route maps to 413). */
export const MAX_INLINE_BYTES = 4 * 1024 * 1024;

const inlineChangeSchema = z.object({
  path: pathSchema,
  op: z.enum(['add', 'mod']),
  content_b64: z.string(),
});

const preuploadedChangeSchema = z.object({
  path: pathSchema,
  op: z.enum(['add', 'mod']),
  blob_sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

const deleteChangeSchema = z.object({
  path: pathSchema,
  op: z.literal('del'),
});

export const changeSchema = z.union([
  inlineChangeSchema,
  preuploadedChangeSchema,
  deleteChangeSchema,
]);
export type Change = z.infer<typeof changeSchema>;

export const commitRequestSchema = z.object({
  /** `null` = root changeset; `ref:main` resolves the current head. */
  first_parent: z.union([z.string().min(1), z.null()]),
  /** Extra parents for merges (duplicates of first_parent are ignored). */
  parents: z.array(z.string().min(1)).optional(),
  message: z.string().min(1).max(65536),
  author: authorSchema,
  changes: z.array(changeSchema).max(5000),
});
export type CommitRequest = z.infer<typeof commitRequestSchema>;

export interface CommitResult {
  changeset: Changeset;
  blobs: { hash: string; size: number }[];
  /** True when an identical changeset already existed (content-addressed). */
  deduped: boolean;
}

/**
 * The transactional write path (architecture §2.1) — lock-free and
 * incremental: cost scales with the change, not the repo.
 *
 * 1. normalize + resolve `first_parent` (cs id or `ref:<name>`, read-only —
 *    refs are never moved here)
 * 2. resolve every change to a content address (inline hashes computed, never
 *    uploaded yet) and validate op semantics against the **base** tree:
 *    `add` ⇔ absent, `mod`/`del` ⇔ present file — no file/dir type conflicts,
 *    no nested paths (see `validateChanges`)
 * 3. content-addressed idempotency: an identical changeset returns here with
 *    **zero** R2 writes
 * 4. upload/dedupe blobs; rebuild trees **only along touched paths**
 *    (deepest-first, empty trees pruned git-style)
 * 5. insert the changeset (idempotent) with its root_tree, then run the eager
 *    derived-data hook (issue #9)
 */
export async function commitChanges(
  env: Env,
  repoId: string,
  rawReq: CommitRequest,
): Promise<CommitResult> {
  // Normalize for every caller (NFC paths, schema bounds) — not just the route.
  const req = commitRequestSchema.parse(rawReq);

  // --- 1. parents ---------------------------------------------------------
  let firstParent: string | null = null;
  let baseRoot: string | null = null;
  if (req.first_parent !== null) {
    const resolved = await lookupRev(env, repoId, req.first_parent);
    if (!resolved) {
      throw new RequestValidationError(
        `unknown parent revision: ${req.first_parent}`,
        { first_parent: req.first_parent },
        'unknown_parent',
      );
    }
    firstParent = resolved.id;
    baseRoot = resolved.root_tree;
    if (baseRoot === null) {
      throw new RequestValidationError(
        `parent changeset ${resolved.id} has no root tree`,
        { parent: resolved.id },
        'unknown_parent',
      );
    }
  }
  const extraParents = (req.parents ?? []).filter((p) => p !== firstParent);
  const parents = firstParent === null ? [] : [firstParent, ...extraParents];

  // --- 2. resolve changes (hash only — no writes yet) ---------------------
  assertNoNestedPaths(req.changes.map((c) => c.path));
  const seen = new Set<string>();
  const blobStats: { hash: string; size: number }[] = [];
  const resolvedChanges: FileChange[] = [];
  for (const change of req.changes) {
    if (seen.has(change.path)) {
      throw new RequestValidationError(`duplicate path in changes: ${change.path}`, {
        path: change.path,
      });
    }
    seen.add(change.path);

    if (change.op === 'del') {
      resolvedChanges.push({ path: change.path, op: 'del' });
      continue;
    }

    let hash: string;
    let size: number;
    if ('content_b64' in change) {
      const bytes = decodeB64(change.content_b64);
      if (bytes.byteLength > MAX_INLINE_BYTES) {
        throw new PayloadTooLargeError(
          `inline content for ${change.path} exceeds ${MAX_INLINE_BYTES} bytes; pre-upload the blob instead`,
          'inline_too_large',
          { path: change.path, limit: MAX_INLINE_BYTES },
        );
      }
      hash = await sha256Hex(bytes);
      size = bytes.byteLength;
    } else {
      hash = change.blob_sha256;
      const present = await hasBlob(env, repoId, [hash]);
      if (!present.has(hash)) {
        throw new RequestValidationError(
          `pre-uploaded blob not found: ${hash}`,
          { blob: hash },
          'missing_blob',
        );
      }
      const measured = await statBlob(env, repoId, hash);
      if (measured === null) {
        throw new RequestValidationError(
          `pre-uploaded blob ${hash} is missing size metadata`,
          { blob: hash },
          'missing_blob',
        );
      }
      size = measured;
    }
    blobStats.push({ hash, size });
    resolvedChanges.push({ path: change.path, op: change.op, hash, size });
  }

  // --- 3. content-addressed idempotency (before ANY R2 write) -------------
  const fields: ChangesetFields = {
    repo_id: repoId,
    first_parent: firstParent,
    parents,
    author: req.author,
    message: req.message,
    changed_files: resolvedChanges,
  };
  const id = await computeChangesetId(fields);
  const existing = await getChangeset(env, repoId, id);
  if (existing) {
    return { changeset: existing, blobs: blobStats, deduped: true };
  }

  // --- 4. validate op semantics against the base tree ---------------------
  await validateChanges(env, repoId, baseRoot, resolvedChanges);

  // --- 5. upload blobs, rebuild trees along touched paths, insert --------
  for (const change of req.changes) {
    if (change.op === 'del') continue;
    if ('content_b64' in change) {
      await putBlob(env, repoId, decodeB64(change.content_b64));
    }
    // pre-uploaded blobs are already in R2 by definition
  }
  const rootTreeHash = await rebuildTrees(env, repoId, baseRoot, resolvedChanges);

  const changeset = await createChangeset(env, repoId, {
    ...fields,
    root_tree: rootTreeHash,
  });

  await onChangesetCreated(env, repoId, changeset);

  return { changeset, blobs: blobStats, deduped: false };
}

/**
 * Eager derived data, computed inside the commit path: the `skip_list`
 * (issue #8) is cheap — one parent read + one write. The generic framework
 * (issue #9) wraps this hook and adds the remaining eager kinds.
 */
export async function onChangesetCreated(
  env: Env,
  repoId: string,
  cs: Changeset,
): Promise<void> {
  await computeSkipList(env, repoId, cs);
  // TODO(issue #9): computeEager(env, repoId, cs) for the other kinds
}

// ---------------------------------------------------------------------------
// Input + base-state validation
// ---------------------------------------------------------------------------

/** No change path may be a strict prefix of another (file/dir collision). */
function assertNoNestedPaths(paths: string[]): void {
  const sorted = [...paths].sort();
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1] as string;
    const cur = sorted[i] as string;
    if (cur.startsWith(`${prev}/`)) {
      throw new RequestValidationError(
        `conflicting change paths: ${JSON.stringify(prev)} and ${JSON.stringify(cur)}`,
        { paths: [prev, cur] },
        'invalid_change',
      );
    }
  }
}

interface PathLookup {
  /** Entry at the path, or null when absent (all ancestors were trees). */
  entry: TreeEntry | null;
  /** Set when an ancestor segment exists but is a file (kind conflict). */
  blobAncestor: string | null;
}

/**
 * Enforce file-level op semantics against the base tree — these checks are
 * what stop a bogus request from silently destroying data (e.g. a `del` of a
 * path nested under an existing *file* must not prune that file):
 *   add ⇔ path absent            mod ⇔ path present as file
 *   del ⇔ path present as file   (directories are not first-class in v1 ops)
 */
async function validateChanges(
  env: Env,
  repoId: string,
  baseRoot: string | null,
  changes: FileChange[],
): Promise<void> {
  const treeCache = new Map<string, Tree>();
  const readTree = async (hash: string): Promise<Tree | null> => {
    const cached = treeCache.get(hash);
    if (cached) return cached;
    const tree = await getTree(env, repoId, hash);
    if (tree) treeCache.set(hash, tree);
    return tree;
  };
  const lookup = async (path: string): Promise<PathLookup> => {
    if (baseRoot === null) return { entry: null, blobAncestor: null };
    let hash = baseRoot;
    const segments = path.split('/');
    for (let i = 0; i < segments.length; i++) {
      const tree = await readTree(hash);
      if (!tree) return { entry: null, blobAncestor: null };
      const entry = tree.entries.find((e) => e.name === (segments[i] as string));
      if (!entry) return { entry: null, blobAncestor: null };
      if (i === segments.length - 1) return { entry, blobAncestor: null };
      if (entry.kind !== 'tree') {
        return {
          entry: null,
          blobAncestor: segments.slice(0, i + 1).join('/'),
        };
      }
      hash = entry.hash;
    }
    return { entry: null, blobAncestor: null };
  };

  for (const change of changes) {
    const { entry, blobAncestor } = await lookup(change.path);
    if (blobAncestor !== null) {
      throw new RequestValidationError(
        `cannot touch ${JSON.stringify(change.path)}: ${JSON.stringify(blobAncestor)} is a file, not a directory`,
        { path: change.path, conflicts_with: blobAncestor },
        'invalid_change',
      );
    }
    if (change.op === 'add' && entry !== null) {
      throw new RequestValidationError(
        `cannot add ${JSON.stringify(change.path)}: it already exists`,
        { path: change.path },
        'invalid_change',
      );
    }
    if (change.op === 'mod' && (entry === null || entry.kind !== 'blob')) {
      throw new RequestValidationError(
        `cannot modify ${JSON.stringify(change.path)}: it is not an existing file`,
        { path: change.path },
        'invalid_change',
      );
    }
    if (change.op === 'del' && (entry === null || entry.kind !== 'blob')) {
      throw new RequestValidationError(
        `cannot delete ${JSON.stringify(change.path)}: it is not an existing file`,
        { path: change.path },
        'invalid_change',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Incremental tree rebuild
// ---------------------------------------------------------------------------

interface EntryUpdate {
  kind: 'blob' | 'tree';
  op: 'add' | 'mod' | 'del';
  hash?: string;
  size?: number;
}

function depth(dirPath: string): number {
  return dirPath === '' ? 0 : dirPath.split('/').length;
}

/**
 * Rebuild only the trees along touched paths (deepest first). Untouched
 * directories keep their exact tree hashes and are never rewritten; putTree
 * dedupes identical trees, so repeated content writes nothing.
 */
async function rebuildTrees(
  env: Env,
  repoId: string,
  baseRoot: string | null,
  changes: FileChange[],
): Promise<string> {
  const updates = new Map<string, Map<string, EntryUpdate>>();
  const putUpdate = (dirPath: string, name: string, upd: EntryUpdate): void => {
    let map = updates.get(dirPath);
    if (!map) {
      map = new Map();
      updates.set(dirPath, map);
    }
    map.set(name, upd);
  };

  for (const change of changes) {
    const segments = change.path.split('/');
    const name = segments[segments.length - 1] as string;
    const dirPath = segments.slice(0, -1).join('/');
    if (change.op === 'del') {
      putUpdate(dirPath, name, { kind: 'blob', op: 'del' });
    } else {
      putUpdate(dirPath, name, {
        kind: 'blob',
        op: change.op,
        hash: change.hash,
        size: change.size,
      });
    }
  }

  // Every touched dir plus its ancestors up to the root.
  const dirs = new Set<string>(updates.keys());
  dirs.add('');
  for (const dirPath of [...updates.keys()]) {
    let p = dirPath;
    while (p !== '') {
      p = p.split('/').slice(0, -1).join('/');
      dirs.add(p);
    }
  }
  const ordered = [...dirs].sort((a, b) => depth(b) - depth(a));

  const treeCache = new Map<string, Tree>();
  const readTree = async (hash: string): Promise<Tree> => {
    let tree = treeCache.get(hash);
    if (!tree) {
      tree = (await getTree(env, repoId, hash)) ?? { entries: [] };
      treeCache.set(hash, tree);
    }
    return tree;
  };
  const baseEntriesAt = async (dirPath: string): Promise<TreeEntry[]> => {
    if (baseRoot === null) return [];
    if (dirPath === '') return (await readTree(baseRoot)).entries;
    const entry = await resolvePath(env, repoId, baseRoot, dirPath.split('/'));
    if (!entry || entry.kind !== 'tree') return [];
    return (await readTree(entry.hash)).entries;
  };

  for (const dirPath of ordered) {
    const entries = [...(await baseEntriesAt(dirPath))];
    const map = updates.get(dirPath);
    if (map) {
      for (const [name, upd] of map) {
        const idx = entries.findIndex((e) => e.name === name);
        if (upd.op === 'del') {
          if (idx >= 0) entries.splice(idx, 1);
        } else {
          const entry: TreeEntry =
            upd.kind === 'blob'
              ? {
                  name,
                  kind: 'blob',
                  hash: upd.hash as string,
                  size: upd.size,
                  mode: '100644',
                }
              : { name, kind: 'tree', hash: upd.hash as string };
          if (idx >= 0) entries[idx] = entry;
          else entries.push(entry);
        }
      }
    }

    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    if (entries.length === 0 && dirPath !== '') {
      // Git-style: empty trees don't exist — drop this dir from its parent.
      const segments = dirPath.split('/');
      const name = segments.pop() as string;
      putUpdate(segments.join('/'), name, { kind: 'tree', op: 'del' });
      continue;
    }

    const { hash } = await putTree(env, repoId, { entries });
    if (dirPath === '') return hash;
    const segments = dirPath.split('/');
    const name = segments.pop() as string;
    putUpdate(segments.join('/'), name, { kind: 'tree', op: 'mod', hash });
  }

  // Unreachable: the root dir is always processed and returns.
  throw new Error('rebuildTrees: root tree not produced');
}

// ---------------------------------------------------------------------------

function decodeB64(b64: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(b64);
  } catch {
    throw new RequestValidationError('content_b64 is not valid base64');
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}
