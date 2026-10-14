import type { Env } from '../env';
import { getBlob } from './blobs';
import { getChangeset } from './changesets';
import { isAncestorDag, mergeBase } from './ancestry';
import { NotFoundError, ObjectCorruptError, ObjectNotFoundError } from './errors';
import { getTree, type TreeEntry } from './trees';
import { unifiedDiff } from './xdiff';

/**
 * Server-side diff (architecture §2.2): both sides' trees are server-side, so
 * a diff is a tree walk between two revisions — recursing **only** into
 * subtrees whose hashes differ. Cost scales with the change, not the repo.
 *
 * Semantics (issue #7):
 *  - `mode: 'merge-base'` (default, three-dot): the result is the union of
 *    `merge-base → from` and `merge-base → to` — each `FileDiff`/`TextDiff`
 *    is tagged with the `side` that changed relative to the base. When one
 *    revision is an ancestor of the other the base is that revision itself.
 *  - `mode: 'direct'` (two-dot): `from` vs `to` trees compared directly;
 *    no `side` tagging.
 */

export interface FileDiff {
  path: string;
  kind: 'add' | 'del' | 'mod';
  old_hash?: string;
  new_hash?: string;
  old_size?: number;
  new_size?: number;
  size_delta?: number;
  /** Three-dot mode: which side changed vs the merge base. */
  side?: 'from' | 'to';
}

export interface TextDiff {
  path: string;
  unified: string;
  side?: 'from' | 'to';
}

export interface DiffResult {
  from: string;
  to: string;
  merge_base: string | null;
  files: FileDiff[];
  truncated: boolean;
}

export interface DiffOptions {
  /** Precomputed merge base (skips ancestry lookups). `null` = empty base. */
  mergeBase?: string | null;
  maxFiles?: number;
  includeText?: boolean;
  maxTextFileSize?: number;
  mode?: 'merge-base' | 'direct';
}

const DEFAULT_MAX_FILES = 2_000;
const DEFAULT_MAX_TEXT_BYTES = 512 * 1024;

export async function diffRevisions(
  env: Env,
  repoId: string,
  fromCs: string,
  toCs: string,
  opts: DiffOptions = {},
): Promise<DiffResult & { texts?: TextDiff[] }> {
  const from = await getChangeset(env, repoId, fromCs);
  const to = await getChangeset(env, repoId, toCs);
  if (!from || !to) {
    throw new NotFoundError('revision_not_found', `no revision ${!from ? fromCs : toCs}`);
  }

  const mode = opts.mode ?? 'merge-base';
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const files: FileDiff[] = [];
  let truncated = false;
  let base: string | null = null;

  if (mode === 'direct') {
    truncated = await walkSide(
      env,
      repoId,
      from.root_tree,
      to.root_tree,
      undefined,
      files,
      maxFiles,
    );
  } else {
    if (opts.mergeBase !== undefined) {
      base = opts.mergeBase;
    } else if (await isAncestorDag(env, repoId, from.id, to.id)) {
      base = from.id;
    } else if (await isAncestorDag(env, repoId, to.id, from.id)) {
      base = to.id;
    } else {
      // Real skip-list merge base (issue #8) over first-parent spines.
      base = await mergeBase(env, repoId, from.id, to.id);
    }
    const baseTree =
      base === null ? null : ((await getChangeset(env, repoId, base))?.root_tree ?? null);
    truncated =
      (await walkSide(env, repoId, baseTree, from.root_tree, 'from', files, maxFiles)) ||
      truncated;
    truncated =
      (await walkSide(env, repoId, baseTree, to.root_tree, 'to', files, maxFiles)) ||
      truncated;
  }

  // Deterministic order: path, then side.
  files.sort((a, b) =>
    a.path === b.path
      ? (a.side ?? '').localeCompare(b.side ?? '')
      : a.path.localeCompare(b.path),
  );

  const result: DiffResult & { texts?: TextDiff[] } = {
    from: from.id,
    to: to.id,
    merge_base: base,
    files,
    truncated,
  };
  if (opts.includeText) {
    result.texts = await collectTexts(env, repoId, files, opts.maxTextFileSize);
  }
  return result;
}

// ---------------------------------------------------------------------------

async function walkSide(
  env: Env,
  repoId: string,
  baseHash: string | null,
  otherHash: string | null,
  side: 'from' | 'to' | undefined,
  files: FileDiff[],
  maxFiles: number,
): Promise<boolean> {
  const stack: { base: string | null; other: string | null; path: string }[] = [
    { base: baseHash, other: otherHash, path: '' },
  ];
  while (stack.length > 0) {
    const frame = stack.pop() as {
      base: string | null;
      other: string | null;
      path: string;
    };
    if (frame.base !== null && frame.base === frame.other) continue; // pruned by hash
    const baseEntries =
      frame.base === null ? [] : await mustTree(env, repoId, frame.base);
    const otherEntries =
      frame.other === null ? [] : await mustTree(env, repoId, frame.other);

    const baseMap = new Map(baseEntries.map((e) => [e.name, e]));
    const otherMap = new Map(otherEntries.map((e) => [e.name, e]));
    const names = [...new Set([...baseMap.keys(), ...otherMap.keys()])].sort();

    for (const name of names) {
      const b = baseMap.get(name);
      const o = otherMap.get(name);
      if (b && o && b.hash === o.hash) continue;
      const path = frame.path === '' ? name : `${frame.path}/${name}`;

      if (b && !o) {
        if (b.kind === 'blob') {
          if (files.length >= maxFiles) return true;
          files.push({
            path,
            kind: 'del',
            old_hash: b.hash,
            old_size: b.size,
            size_delta: -(b.size ?? 0),
            side,
          });
        } else {
          stack.push({ base: b.hash, other: null, path });
        }
      } else if (!b && o) {
        if (o.kind === 'blob') {
          if (files.length >= maxFiles) return true;
          files.push({
            path,
            kind: 'add',
            new_hash: o.hash,
            new_size: o.size,
            size_delta: o.size ?? 0,
            side,
          });
        } else {
          stack.push({ base: null, other: o.hash, path });
        }
      } else if (b && o) {
        if (b.kind === 'tree' && o.kind === 'tree') {
          stack.push({ base: b.hash, other: o.hash, path });
        } else if (b.kind === 'blob' && o.kind === 'blob') {
          if (files.length >= maxFiles) return true;
          files.push({
            path,
            kind: 'mod',
            old_hash: b.hash,
            new_hash: o.hash,
            old_size: b.size,
            new_size: o.size,
            size_delta: (o.size ?? 0) - (b.size ?? 0),
            side,
          });
        } else {
          // file ↔ directory kind change: surfaced at this path
          if (files.length >= maxFiles) return true;
          files.push({
            path,
            kind: 'mod',
            old_hash: b.hash,
            new_hash: o.hash,
            old_size: b.size,
            new_size: o.size,
            size_delta: (o.size ?? 0) - (b.size ?? 0),
            side,
          });
        }
      }
    }
  }
  return false;
}

async function mustTree(env: Env, repoId: string, hash: string): Promise<TreeEntry[]> {
  const tree = await getTree(env, repoId, hash);
  if (tree === null) {
    throw new ObjectCorruptError('tree', hash, 'tree referenced by changeset is missing');
  }
  return tree.entries;
}

// ---------------------------------------------------------------------------
// Text diffs
// ---------------------------------------------------------------------------

const TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'json',
  'js',
  'mjs',
  'cjs',
  'jsx',
  'ts',
  'mts',
  'tsx',
  'css',
  'html',
  'htm',
  'xml',
  'yaml',
  'yml',
  'toml',
  'csv',
  'svg',
  'sh',
  'py',
  'go',
  'rs',
  'java',
  'rb',
  'php',
  'c',
  'h',
  'cpp',
  'hpp',
  'sql',
  'lock',
  'cfg',
  'ini',
  'env',
  'gitignore',
]);

function looksText(path: string, head: Uint8Array): boolean {
  const dot = path.lastIndexOf('.');
  const ext = dot < 0 ? '' : path.slice(dot + 1).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return true;
  const n = Math.min(head.byteLength, 8192);
  for (let i = 0; i < n; i++) {
    if (head[i] === 0) return false;
  }
  return true;
}

/**
 * Unified text diffs for the changed files: bounded by count/size/binary
 * heuristics (issue #7) — files over `maxTextFileSize`, and binaries (NUL in
 * the first 8 KiB with no known text extension), are skipped.
 */
export async function collectTexts(
  env: Env,
  repoId: string,
  files: FileDiff[],
  maxTextFileSize = DEFAULT_MAX_TEXT_BYTES,
): Promise<TextDiff[]> {
  const texts: TextDiff[] = [];
  for (const file of files) {
    if (
      (file.old_size ?? 0) > maxTextFileSize ||
      (file.new_size ?? 0) > maxTextFileSize
    ) {
      continue;
    }
    const oldBlob = file.old_hash ? await getBlob(env, repoId, file.old_hash) : null;
    const newBlob = file.new_hash ? await getBlob(env, repoId, file.new_hash) : null;
    if ((file.old_hash && !oldBlob) || (file.new_hash && !newBlob)) {
      throw new ObjectNotFoundError('blob', (file.old_hash ?? file.new_hash) as string);
    }
    const probe = newBlob?.content ?? oldBlob?.content ?? new Uint8Array();
    if (!looksText(file.path, probe)) continue;
    const oldText = oldBlob ? new TextDecoder().decode(oldBlob.content) : '';
    const newText = newBlob ? new TextDecoder().decode(newBlob.content) : '';
    const unified = unifiedDiff(oldText, newText);
    if (unified === '') continue;
    texts.push({ path: file.path, unified, side: file.side });
  }
  return texts;
}
