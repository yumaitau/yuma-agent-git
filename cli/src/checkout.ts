import { createHash } from 'node:crypto';
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as zlib from 'node:zlib';
import { inflateRawSync } from 'node:zlib';
import type { TreeObject, YagApi } from './api.js';
import { ObjectCache } from './cache.js';
import { saveState, type YagState } from './config.js';

const MAX_BATCH = 100;
const MAX_PARALLEL = 8;

export interface CheckoutOptions {
  dir: string;
  rev: string;
  /** Sparse prefixes — empty means the whole tree. */
  prefixes: string[];
  api: YagApi;
  cache: ObjectCache;
  onProgress?: (message: string) => void;
}

export interface CheckoutFile {
  path: string;
  blob_hash: string;
  mtime: number;
}

export interface CheckoutResult {
  cs: string;
  root_tree: string;
  files: CheckoutFile[];
}

/** Sparse match: exact, under the prefix, or an ancestor of the prefix. */
export function pathMatches(path: string, prefixes: string[]): boolean {
  if (prefixes.length === 0) return true;
  return prefixes.some(
    (p) => path === p || path.startsWith(`${p}/`) || p.startsWith(`${path}/`),
  );
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Decode + verify a blob's content address in one step: a decode failure is a
 * verification failure (corrupt bytes are corrupt bytes).
 */
export function decodeVerified(
  raw: Buffer,
  encoding: string,
  hash: string,
): Buffer | null {
  try {
    const decoded = decodeBlob(raw, encoding);
    return sha256Hex(decoded) === hash ? decoded : null;
  } catch {
    return null;
  }
}

/** Decompress stored object bytes according to the server-declared codec. */
export function decodeBlob(data: Buffer, encoding: string): Buffer {
  if (encoding === 'identity') return data;
  if (encoding === 'deflate-raw') return inflateRawSync(data);
  if (encoding === 'zstd') {
    const zstd = (zlib as unknown as Record<string, unknown>).zstdDecompressSync;
    if (typeof zstd !== 'function') {
      throw new Error('this Node runtime cannot decompress zstd object bytes');
    }
    return (zstd as (b: Buffer) => Buffer)(data);
  }
  throw new Error(`unknown object encoding: ${encoding}`);
}

/** Run `fn` over `items` in batches of `size`, at most `parallel` at a time. */
async function batched<T, R>(
  items: T[],
  size: number,
  parallel: number,
  fn: (chunk: T[]) => Promise<R>,
): Promise<R[]> {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  const out: R[] = [];
  for (let i = 0; i < chunks.length; i += parallel) {
    out.push(...(await Promise.all(chunks.slice(i, i + parallel).map(fn))));
  }
  return out;
}

/**
 * Scion-style recursive fetch (architecture §2.4): the client starts from the
 * root tree and asks only for what it wants — **never sends "haves"**, never
 * negotiates state. Resumable: every verified object lands in the LRU cache
 * before the working copy is written, and hash mismatches get exactly one
 * re-fetch before failing hard.
 */
export async function checkout(opts: CheckoutOptions): Promise<CheckoutResult> {
  const progress = opts.onProgress ?? ((): void => {});
  const info = await opts.api.checkoutInfo(opts.rev);
  progress(`revision ${info.cs} — ~${info.size_estimate.blobs} blobs`);

  // ---- trees: BFS, sparse, cache-aware, batched -------------------------
  const trees = new Map<string, TreeObject>();
  const ensureTrees = async (hashes: string[]): Promise<void> => {
    const missing: string[] = [];
    for (const hash of new Set(hashes)) {
      if (trees.has(hash)) continue;
      const cached = await opts.cache.get(hash);
      if (cached && cached.encoding === 'json') {
        trees.set(hash, JSON.parse(cached.bytes.toString('utf8')) as TreeObject);
      } else {
        missing.push(hash);
      }
    }
    if (missing.length === 0) return;
    progress(`fetching ${missing.length} trees`);
    const results = await batched(missing, MAX_BATCH, MAX_PARALLEL, (chunk) =>
      opts.api.fetchObjects({ trees: chunk }),
    );
    for (const result of results) {
      for (const tree of result.trees) {
        const bytes = Buffer.from(tree.payload_b64, 'base64');
        await opts.cache.put(tree.hash, bytes, 'json');
        trees.set(tree.hash, JSON.parse(bytes.toString('utf8')) as TreeObject);
      }
      if (result.missing.length > 0) {
        throw new Error(`server is missing trees: ${result.missing.join(', ')}`);
      }
    }
  };

  let frontier: { hash: string; path: string }[] = [{ hash: info.root_tree, path: '' }];
  const wanted: { path: string; hash: string; size: number }[] = [];
  while (frontier.length > 0) {
    await ensureTrees(frontier.map((f) => f.hash));
    const next: { hash: string; path: string }[] = [];
    for (const frame of frontier) {
      const tree = trees.get(frame.hash);
      if (!tree) throw new Error(`tree ${frame.hash} missing after fetch`);
      for (const entry of tree.entries) {
        const path = frame.path === '' ? entry.name : `${frame.path}/${entry.name}`;
        if (!pathMatches(path, opts.prefixes)) continue;
        if (entry.kind === 'tree') next.push({ hash: entry.hash, path });
        else wanted.push({ path, hash: entry.hash, size: entry.size ?? 0 });
      }
    }
    frontier = next;
  }
  progress(
    `${wanted.length} files match ${opts.prefixes.join(', ') || '(full checkout)'}`,
  );

  // ---- blobs: want-only, hash-verified, cache-first ---------------------
  const content = new Map<string, Buffer>();
  const pending = new Set<string>();
  for (const file of wanted) {
    if (content.has(file.hash) || pending.has(file.hash)) continue;
    const cached = await opts.cache.get(file.hash);
    if (cached && cached.encoding !== 'json') {
      const decoded = decodeVerified(cached.bytes, cached.encoding, file.hash);
      if (decoded) {
        content.set(file.hash, decoded);
        continue;
      }
      // corrupt cache entry: fall through to a fetch
    }
    pending.add(file.hash);
  }

  // Exactly ONE re-fetch after a failed verification, then a hard error.
  const refetchOnce = async (hash: string): Promise<Buffer> => {
    const result = await opts.api.fetchObjects({ blobs: [hash] });
    const blob = result.blobs.find((b) => b.hash === hash);
    if (!blob) throw new Error(`server is missing blob ${hash}`);
    const raw = Buffer.from(blob.data_b64, 'base64');
    const decoded = decodeVerified(raw, blob.encoding, hash);
    if (!decoded) {
      throw new Error(`blob ${hash} failed hash verification after re-fetch`);
    }
    await opts.cache.put(hash, raw, blob.encoding);
    return decoded;
  };

  if (pending.size > 0) {
    progress(`fetching ${pending.size} blobs`);
    const results = await batched([...pending], MAX_BATCH, MAX_PARALLEL, (chunk) =>
      opts.api.fetchObjects({ blobs: chunk }),
    );
    for (const result of results) {
      for (const blob of result.blobs) {
        const raw = Buffer.from(blob.data_b64, 'base64');
        const decoded = decodeVerified(raw, blob.encoding, blob.hash);
        if (decoded) {
          await opts.cache.put(blob.hash, raw, blob.encoding);
          content.set(blob.hash, decoded);
        } else {
          content.set(blob.hash, await refetchOnce(blob.hash)); // single retry, then hard error
        }
      }
      for (const hash of result.missing) {
        throw new Error(`server is missing blob ${hash}`);
      }
    }
  }

  // ---- working copy: atomic writes -------------------------------------
  const files: CheckoutFile[] = [];
  for (const file of wanted) {
    const bytes = content.get(file.hash);
    if (!bytes) throw new Error(`blob ${file.hash} not materialized`);
    const target = join(opts.dir, file.path);
    await mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.yag-tmp`;
    await writeFile(tmp, bytes);
    await rename(tmp, target);
    const st = await stat(target);
    files.push({ path: file.path, blob_hash: file.hash, mtime: Math.floor(st.mtimeMs) });
  }

  const state: YagState = {
    cs: info.cs,
    root_tree: info.root_tree,
    entries: files,
    sparse_prefixes: opts.prefixes,
  };
  await saveState(opts.dir, state);
  progress(`checked out ${files.length} files at ${info.cs}`);
  return { cs: info.cs, root_tree: info.root_tree, files };
}
