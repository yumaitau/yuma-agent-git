import { z } from 'zod';
import type { Env } from '../../env';
import { q, q1, tx } from '../../db/client';
import { getRef } from '../../db/repos';
import { getBlob } from '../blobs';
import { getChangeset, type Changeset } from '../changesets';
import {
  continuation,
  DerivedDeferredError,
  enqueueDerived,
  getDerived,
  registerKind,
  type DerivedKind,
} from '../derived';
import { diffRevisions } from '../diff';
import { ObjectCorruptError, ObjectWalkLimitError } from '../errors';
import { getTreeRecursive, type Tree } from '../trees';

/**
 * Code search index (issue #45, ADR 0004): trigram postings in D1, built as
 * derived data.
 *
 * - `code_search` kind, key `<csId>`: index the blobs a changeset added or
 *   changed that no earlier changeset indexed (a one-file change reads and
 *   indexes one blob). Small changes run in the commit path, larger ones in
 *   the derived-data queue, continuing past the byte budget.
 * - key `full:<csId>`: index every unindexed blob in the tree at the
 *   changeset (backfill for history from before the index existed).
 * - The default-branch file list (`search_files`) follows the branch head by
 *   tree diff, so a move costs the change, not the repo. Blobs that leave
 *   every file list are compacted out of the postings.
 */

export const CODE_SEARCH = 'code_search';
const FULL_PREFIX = 'full:';

/** Blobs larger than this are listed by the file finder but not indexed. */
export const MAX_INDEX_BYTES = 1024 * 1024;
/** Bytes one invocation reads before deferring (queue continues). */
export const INDEX_BUDGET_BYTES = 32 * 1024 * 1024;
/** Commit-path bound: larger changes index in the queue. */
export const EAGER_MAX_FILES = 8;
export const EAGER_MAX_BYTES = 256 * 1024;
/** Tree-diff size past which a branch move rebuilds the file list. */
export const MAX_DELTA_FILES = 2_000;
/** Largest file list kept per repo (the rest is reported as skipped). */
export const MAX_SNAPSHOT_FILES = 100_000;

const GRAM_CHUNK = 4_000;
const ROW_CHUNK = 2_000;
/** Git modes with no searchable text (symlink targets, submodules). */
const SKIP_MODES = new Set(['120000', '160000']);

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/** ASCII lower-casing: keeps string length, matches JS `i` regex folding. */
export function foldAscii(text: string): string {
  return text.replace(/[A-Z]+/g, (s) => s.toLowerCase());
}

/** Distinct trigrams of `text` (ASCII-folded), never spanning a newline. */
export function trigrams(text: string): Set<string> {
  const folded = foldAscii(text);
  const out = new Set<string>();
  for (let i = 0; i + 3 <= folded.length; i++) {
    const gram = folded.slice(i, i + 3);
    if (!gram.includes('\n')) out.add(gram);
  }
  return out;
}

/** NUL in the first 8 KiB marks a binary file (Git's heuristic). */
export function isBinary(content: Uint8Array): boolean {
  return content.subarray(0, 8192).includes(0);
}

const LANGS: Record<string, string> = {
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  go: 'go',
  html: 'html',
  java: 'java',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  json: 'json',
  kt: 'kotlin',
  md: 'markdown',
  php: 'php',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  scala: 'scala',
  sh: 'shell',
  bash: 'shell',
  sql: 'sql',
  swift: 'swift',
  toml: 'toml',
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  yaml: 'yaml',
  yml: 'yaml',
};

/** Language by file extension (`Dockerfile` and `Makefile` by name), or null. */
export function languageOf(path: string): string | null {
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (name === 'Dockerfile') return 'dockerfile';
  if (name === 'Makefile') return 'make';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  return LANGS[name.slice(dot + 1).toLowerCase()] ?? null;
}

// ---------------------------------------------------------------------------
// Blob indexing
// ---------------------------------------------------------------------------

export interface IndexItem {
  hash: string;
  size?: number;
}

export interface IndexResult {
  /** Blobs this run indexed (text, binary or too large). */
  indexed: number;
  /** Blobs an earlier run had already indexed. */
  known: number;
}

/** Hashes among `hashes` that already have a `search_blobs` row. */
export async function indexedHashes(env: Env, hashes: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < hashes.length; i += ROW_CHUNK) {
    const rows = await q<{ blob_hash: string }>(
      env,
      `SELECT blob_hash FROM search_blobs
        WHERE blob_hash IN (SELECT value FROM json_each(?))`,
      [JSON.stringify(hashes.slice(i, i + ROW_CHUNK))],
    );
    for (const row of rows) out.add(row.blob_hash);
  }
  return out;
}

async function storeBlob(
  env: Env,
  hash: string,
  status: 'indexed' | 'binary' | 'too_large',
  size: number,
  grams: string[],
): Promise<void> {
  // one batch: a blob row never exists without all of its postings
  await tx(env, (t) => {
    for (let i = 0; i < grams.length; i += GRAM_CHUNK) {
      t.q(
        `INSERT OR IGNORE INTO search_trigrams (gram, blob_hash)
         SELECT value, ? FROM json_each(?)`,
        [hash, JSON.stringify(grams.slice(i, i + GRAM_CHUNK))],
      );
    }
    t.q(
      `INSERT OR IGNORE INTO search_blobs (blob_hash, status, size, grams, indexed_at)
       VALUES (?, ?, ?, ?, ?)`,
      [hash, status, size, grams.length, Date.now()],
    );
  });
}

/**
 * Index the blobs no earlier run indexed. Reads at most `budgetBytes`, then
 * throws `DerivedDeferredError` with the finished blobs stored, so the next
 * run continues where this one stopped.
 */
export async function indexBlobs(
  env: Env,
  repoId: string,
  items: IndexItem[],
  budgetBytes = INDEX_BUDGET_BYTES,
): Promise<IndexResult> {
  const unique = [...new Map(items.map((i) => [i.hash, i])).values()];
  const known = await indexedHashes(
    env,
    unique.map((i) => i.hash),
  );
  let spent = 0;
  let indexed = 0;
  for (const item of unique) {
    if (known.has(item.hash)) continue;
    if (item.size !== undefined && item.size > MAX_INDEX_BYTES) {
      await storeBlob(env, item.hash, 'too_large', item.size, []);
      indexed++;
      continue;
    }
    if (spent > 0 && spent + (item.size ?? 0) > budgetBytes) {
      throw new DerivedDeferredError(`code_search: byte budget spent at ${item.hash}`);
    }
    const blob = await getBlob(env, repoId, item.hash);
    if (blob === null) {
      throw new ObjectCorruptError('blob', item.hash, 'missing while indexing');
    }
    spent += blob.size;
    if (blob.size > MAX_INDEX_BYTES) {
      await storeBlob(env, item.hash, 'too_large', blob.size, []);
    } else if (isBinary(blob.content)) {
      await storeBlob(env, item.hash, 'binary', blob.size, []);
    } else {
      const text = new TextDecoder().decode(blob.content);
      await storeBlob(env, item.hash, 'indexed', blob.size, [...trigrams(text)]);
    }
    indexed++;
  }
  return { indexed, known: unique.length - indexed };
}

// ---------------------------------------------------------------------------
// Tree listing
// ---------------------------------------------------------------------------

export interface FileRow {
  path: string;
  hash: string;
  size: number;
  lang: string | null;
}

/** Every searchable file in a tree (bounded by the tree walk and the cap). */
export async function listFiles(
  env: Env,
  repoId: string,
  rootTree: string | null,
): Promise<FileRow[]> {
  if (rootTree === null) return [];
  const trees = await getTreeRecursive(env, repoId, rootTree);
  const out: FileRow[] = [];
  const walk = (tree: Tree | undefined, prefix: string): void => {
    for (const entry of tree?.entries ?? []) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.kind === 'tree') {
        walk(trees.get(entry.hash), path);
        continue;
      }
      if (entry.mode !== undefined && SKIP_MODES.has(entry.mode)) continue;
      if (out.length >= MAX_SNAPSHOT_FILES) throw new SnapshotTooLargeError();
      out.push({ path, hash: entry.hash, size: entry.size ?? 0, lang: languageOf(path) });
    }
  };
  walk(trees.get(rootTree), '');
  return out;
}

export class SnapshotTooLargeError extends Error {
  constructor() {
    super(`code_search: more than ${MAX_SNAPSHOT_FILES} files`);
    this.name = 'SnapshotTooLargeError';
  }
}

// ---------------------------------------------------------------------------
// Derived kind
// ---------------------------------------------------------------------------

const resultSchema = z.object({ indexed: z.number(), known: z.number() });

/** Blobs a changeset added or changed relative to its first parent. */
function changedItems(cs: Changeset): IndexItem[] {
  return cs.changed_files
    .filter(
      (f) =>
        f.op !== 'del' &&
        f.hash !== undefined &&
        (f.mode === undefined || !SKIP_MODES.has(f.mode)),
    )
    .map((f) => ({ hash: f.hash as string, size: f.size }));
}

export const codeSearchKind: DerivedKind<IndexResult> = {
  name: CODE_SEARCH,
  eager: false,
  isolated: true,
  changesetOfKey(key) {
    return key.startsWith(FULL_PREFIX) ? key.slice(FULL_PREFIX.length) : key;
  },
  async compute(env, repoId, cs, ctx) {
    if (!ctx.key.startsWith(FULL_PREFIX)) {
      return indexBlobs(env, repoId, changedItems(cs));
    }
    const files = await listFiles(env, repoId, cs.root_tree);
    return indexBlobs(env, repoId, files);
  },
  parse(payload) {
    return resultSchema.parse(JSON.parse(payload));
  },
};

registerKind(codeSearchKind);

/**
 * Commit hook: index a small change now, a larger one in the derived-data
 * queue. Indexing never fails a commit.
 */
export async function scheduleCodeSearch(
  env: Env,
  repoId: string,
  cs: Changeset,
): Promise<void> {
  const message = { repo_id: repoId, kind: CODE_SEARCH, cs_id: cs.id };
  const items = changedItems(cs);
  if (items.length === 0) return;
  const bytes = items.reduce((sum, i) => sum + (i.size ?? 0), 0);
  if (items.length <= EAGER_MAX_FILES && bytes <= EAGER_MAX_BYTES) {
    try {
      await getDerived(env, repoId, CODE_SEARCH, cs.id);
      return;
    } catch (err) {
      if (err instanceof DerivedDeferredError) {
        await enqueueDerived(env, [continuation(message, err)]);
        return;
      }
      console.error('code_search: eager index failed, deferring', cs.id, err);
    }
  }
  await enqueueDerived(env, [message]);
}

// ---------------------------------------------------------------------------
// Default-branch file list
// ---------------------------------------------------------------------------

export interface Snapshot {
  /** Changeset the file list is at, or null for a repo with no default branch. */
  cs_id: string | null;
  /** Set when the file list could not be built (`too_large`). */
  skipped?: string;
}

interface Delta {
  full: boolean;
  upserts: FileRow[];
  deletes: string[];
  /** Blob hashes the change removes from the list (compaction candidates). */
  dropped: string[];
}

async function deltaBetween(
  env: Env,
  repoId: string,
  from: string | null,
  to: Changeset,
): Promise<Delta> {
  if (from !== null) {
    const diff = await diffRevisions(env, repoId, from, to.id, {
      mode: 'direct',
      maxFiles: MAX_DELTA_FILES,
    }).catch(() => null);
    if (diff !== null && !diff.truncated) {
      const upserts: FileRow[] = [];
      const deletes: string[] = [];
      const dropped: string[] = [];
      for (const f of diff.files) {
        if (f.old_hash !== undefined) dropped.push(f.old_hash);
        if (f.kind === 'del') deletes.push(f.path);
        else if (f.new_hash !== undefined)
          upserts.push({
            path: f.path,
            hash: f.new_hash,
            size: f.new_size ?? 0,
            lang: languageOf(f.path),
          });
      }
      return { full: false, upserts, deletes, dropped };
    }
  }
  const files = await listFiles(env, repoId, to.root_tree);
  return { full: true, upserts: files, deletes: [], dropped: [] };
}

/**
 * Bring the repo's file list to its default-branch head. Every write is
 * guarded by the list's current changeset (compare-and-swap in one batch), so
 * racing syncs cannot interleave two deltas.
 */
export async function syncSnapshot(
  env: Env,
  repo: { id: string; default_branch: string },
  known?: { head: string | null; cs_id: string | null },
): Promise<Snapshot> {
  const head = known
    ? known.head
    : ((await getRef(env, repo.id, repo.default_branch))?.head ?? null);
  const current = known
    ? known.cs_id
    : ((
        await q1<{ cs_id: string }>(
          env,
          'SELECT cs_id FROM search_repos WHERE repo_id = ?',
          [repo.id],
        )
      )?.cs_id ?? null);
  if (head === null) return { cs_id: current };
  if (current === head) return { cs_id: head };
  const target = await getChangeset(env, repo.id, head);
  if (target === null) return { cs_id: current };

  let delta: Delta;
  try {
    delta = await deltaBetween(env, repo.id, current, target);
  } catch (err) {
    if (err instanceof SnapshotTooLargeError || err instanceof ObjectWalkLimitError)
      return { cs_id: current, skipped: 'too_large' };
    throw err;
  }

  const guard = '(SELECT cs_id FROM search_repos WHERE repo_id = ?) IS ?';
  const g = [repo.id, current];
  await tx(env, (t) => {
    if (delta.full)
      t.q(`DELETE FROM search_files WHERE repo_id = ? AND ${guard}`, [repo.id, ...g]);
    for (let i = 0; i < delta.deletes.length; i += ROW_CHUNK) {
      t.q(
        `DELETE FROM search_files WHERE repo_id = ?
           AND path IN (SELECT value FROM json_each(?)) AND ${guard}`,
        [repo.id, JSON.stringify(delta.deletes.slice(i, i + ROW_CHUNK)), ...g],
      );
    }
    for (let i = 0; i < delta.upserts.length; i += ROW_CHUNK) {
      const rows = delta.upserts
        .slice(i, i + ROW_CHUNK)
        .map((f) => [f.path, f.hash, f.size, f.lang]);
      t.q(
        `INSERT OR REPLACE INTO search_files (repo_id, path, blob_hash, size, lang)
         SELECT ?, json_extract(value, '$[0]'), json_extract(value, '$[1]'),
                json_extract(value, '$[2]'), json_extract(value, '$[3]')
           FROM json_each(?) WHERE ${guard}`,
        [repo.id, JSON.stringify(rows), ...g],
      );
    }
    t.q(
      `INSERT INTO search_repos (repo_id, cs_id, files, bytes, updated_at)
       SELECT ?, ?,
              (SELECT COUNT(*) FROM search_files WHERE repo_id = ?),
              (SELECT COALESCE(SUM(size), 0) FROM search_files WHERE repo_id = ?),
              ?
        WHERE ${guard}
       ON CONFLICT (repo_id) DO UPDATE SET cs_id = excluded.cs_id,
         files = excluded.files, bytes = excluded.bytes, updated_at = excluded.updated_at`,
      [repo.id, head, repo.id, repo.id, Date.now(), ...g],
    );
  });
  await compact(env, delta.dropped);

  // history from before the index (or a queue backlog): backfill in the queue
  const unindexed = await q1(
    env,
    `SELECT 1 AS x FROM search_files f
       LEFT JOIN search_blobs b ON b.blob_hash = f.blob_hash
      WHERE f.repo_id = ? AND b.blob_hash IS NULL LIMIT 1`,
    [repo.id],
  );
  if (unindexed !== null) {
    await enqueueDerived(env, [
      { repo_id: repo.id, kind: CODE_SEARCH, cs_id: `${FULL_PREFIX}${head}` },
    ]);
  }
  return { cs_id: head };
}

/**
 * Compaction: drop the postings of blobs no file list references any more.
 * Searches at older revisions still find them by reading the blob.
 */
export async function compact(env: Env, hashes: string[]): Promise<void> {
  for (let i = 0; i < hashes.length; i += ROW_CHUNK) {
    const list = JSON.stringify(hashes.slice(i, i + ROW_CHUNK));
    const orphan = `blob_hash IN (SELECT value FROM json_each(?))
       AND blob_hash NOT IN (SELECT blob_hash FROM search_files
                              WHERE blob_hash IN (SELECT value FROM json_each(?)))`;
    await tx(env, (t) => {
      t.q(`DELETE FROM search_trigrams WHERE ${orphan}`, [list, list]);
      t.q(`DELETE FROM search_blobs WHERE ${orphan}`, [list, list]);
    });
  }
}
