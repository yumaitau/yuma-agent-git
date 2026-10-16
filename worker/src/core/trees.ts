import { z } from 'zod';
import type { Env } from '../env';
import { r2 } from '../observability/phase';
import { compressBytes, decompressBytes, parseCodec, preferredCodec } from './compress';
import { InvalidTreeError, ObjectCorruptError, ObjectWalkLimitError } from './errors';
import { canonicalJson, sha256Hex } from './hashing';
import { storageId } from './network';

/**
 * Content-addressed trees over R2 (architecture §1.2).
 *
 * Key layout: `repos/{repo_id}/trees/{hash[0:2]}/{hash}` (a fork: its network
 * root's id, core/network.ts)
 * Content = canonical JSON `{entries}` (entries sorted by name), compressed.
 * Tree hash = SHA-256 of that canonical JSON.
 */

export interface TreeEntry {
  name: string;
  kind: 'tree' | 'blob';
  hash: string;
  size?: number;
  mode?: string;
}

export interface Tree {
  entries: TreeEntry[];
}

export function treeKey(repoId: string, hash: string): string {
  return `repos/${storageId(repoId)}/trees/${hash.slice(0, 2)}/${hash}`;
}

const treeEntrySchema = z.object({
  name: z.string().min(1),
  kind: z.enum(['tree', 'blob']),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().optional(),
  mode: z.string().optional(),
});

const treeSchema = z.object({ entries: z.array(treeEntrySchema) });

/** Canonical text form of a tree: entries sorted by name, unique. */
function canonicalTreeText(tree: Tree): string {
  return canonicalJson({ entries: sortEntries(tree.entries) });
}

function sortEntries(entries: TreeEntry[]): TreeEntry[] {
  return [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** SHA-256 of the tree's canonical JSON. */
export function hashTree(tree: Tree): Promise<string> {
  return sha256Hex(new TextEncoder().encode(canonicalTreeText(tree)));
}

function validateTree(tree: Tree): void {
  const names = new Set<string>();
  let prev: string | null = null;
  for (const entry of tree.entries) {
    if (entry.name === '' || entry.name === '.' || entry.name === '..') {
      throw new InvalidTreeError(`invalid entry name: ${JSON.stringify(entry.name)}`);
    }
    if (entry.name.includes('/')) {
      throw new InvalidTreeError(`entry name must not contain '/': ${entry.name}`);
    }
    if (entry.kind !== 'tree' && entry.kind !== 'blob') {
      throw new InvalidTreeError(`invalid entry kind: ${String(entry.kind)}`);
    }
    if (names.has(entry.name)) {
      throw new InvalidTreeError(`duplicate entry name: ${entry.name}`);
    }
    if (prev !== null && entry.name < prev) {
      throw new InvalidTreeError('entries must be sorted by name');
    }
    names.add(entry.name);
    prev = entry.name;
  }
}

export interface PutTreeResult {
  hash: string;
  stored: boolean;
}

/** Validate, hash, and store a tree. Immutable + deduped on hash. */
export async function putTree(
  env: Env,
  repoId: string,
  tree: Tree,
): Promise<PutTreeResult> {
  validateTree(tree);
  const text = canonicalTreeText(tree);
  const hash = await sha256Hex(new TextEncoder().encode(text));
  const key = treeKey(repoId, hash);
  const existing = await r2(env.OBJECTS).head(key);
  if (existing) return { hash, stored: false };
  const codec = preferredCodec();
  await r2(env.OBJECTS).put(
    key,
    await compressBytes(new TextEncoder().encode(text), codec),
    {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { encoding: codec },
    },
  );
  return { hash, stored: true };
}

/** Read + verify a tree, or null when not stored. */
export async function getTree(
  env: Env,
  repoId: string,
  hash: string,
): Promise<Tree | null> {
  const obj = await r2(env.OBJECTS).get(treeKey(repoId, hash));
  if (!obj) return null;
  const stored = new Uint8Array(await obj.arrayBuffer());
  let text: string;
  try {
    text = new TextDecoder().decode(
      await decompressBytes(stored, parseCodec(obj.customMetadata?.encoding)),
    );
  } catch (err) {
    throw new ObjectCorruptError(
      'tree',
      hash,
      err instanceof Error
        ? `decompression failed: ${err.message}`
        : 'decompression failed',
    );
  }
  const actual = await sha256Hex(new TextEncoder().encode(text));
  if (actual !== hash) {
    throw new ObjectCorruptError('tree', hash, `hash mismatch: got ${actual}`);
  }
  let parsed: z.infer<typeof treeSchema>;
  try {
    parsed = treeSchema.parse(JSON.parse(text));
  } catch (err) {
    throw new ObjectCorruptError(
      'tree',
      hash,
      err instanceof Error ? err.message : 'invalid tree JSON',
    );
  }
  const tree: Tree = { entries: parsed.entries };
  validateTree(tree);
  return tree;
}

export interface RecursiveTrees {
  trees: Map<string, Tree>;
}

/**
 * Bounded recursive walk: fetch `rootHash` and every descendant tree.
 * Throws `ObjectWalkLimitError` past `maxObjects` (default 10_000).
 */
export async function getTreeRecursive(
  env: Env,
  repoId: string,
  rootHash: string,
  opts: { maxObjects?: number } = {},
): Promise<Map<string, Tree>> {
  const maxObjects = opts.maxObjects ?? 10_000;
  const trees = new Map<string, Tree>();
  const queue = [rootHash];
  let root = true;
  while (queue.length > 0) {
    const hash = queue.shift();
    if (hash === undefined) break;
    if (trees.has(hash)) continue;
    if (trees.size >= maxObjects) {
      throw new ObjectWalkLimitError(maxObjects);
    }
    const tree = await getTree(env, repoId, hash);
    if (tree === null) {
      if (root) continue; // absent root: empty walk (caller decides)
      // A referenced child tree that does not exist is corruption — content
      // addresses are immutable and committed children always exist.
      throw new ObjectCorruptError('tree', rootHash, `missing tree ${hash}`);
    }
    root = false;
    trees.set(hash, tree);
    for (const entry of tree.entries) {
      if (entry.kind === 'tree' && !trees.has(entry.hash)) {
        queue.push(entry.hash);
      }
    }
  }
  return trees;
}

/**
 * Walk `path` level by level from `rootTreeHash`, returning the entry found
 * (tree or blob) or null when any segment is missing or not a tree.
 */
export async function resolvePath(
  env: Env,
  repoId: string,
  rootTreeHash: string,
  path: string[],
): Promise<TreeEntry | null> {
  let currentHash = rootTreeHash;
  for (let i = 0; i < path.length; i++) {
    const segment = path[i] as string;
    const tree = await getTree(env, repoId, currentHash);
    if (tree === null) return null;
    const entry = tree.entries.find((e) => e.name === segment);
    if (!entry) return null;
    if (i === path.length - 1) return entry;
    if (entry.kind !== 'tree') return null;
    currentHash = entry.hash;
  }
  return { name: '', kind: 'tree', hash: rootTreeHash };
}
