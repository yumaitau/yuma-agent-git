import type { Env } from '../env';
import type { Author, Committer } from '../db/client';
import type { ConflictHunk, MergeConflict } from '../../shared/collaboration';
import { dagMergeBases } from './ancestry';
import { getBlob, putBlob } from './blobs';
import { getChangeset, type Changeset } from './changesets';
import { commitChanges, type Change } from './commit';
import { ConflictError } from './errors';
import { sha256Hex } from './hashing';
import { getTree, type TreeEntry } from './trees';
import { diffOps, splitLines } from './xdiff';

/**
 * Server-side three-way merge (issue #42), file level over trees and line
 * level (diff3) inside files changed on both sides. Never guesses: anything it
 * cannot merge exactly is reported as a conflict and produces no changes.
 * Renames are a delete plus an add.
 */

export type { MergeConflict };

/** Bounded work per request: bigger files are reported, never merged. */
export const MAX_MERGE_BYTES = 1024 * 1024;
export const MAX_MERGE_LINES = 10_000;

/** Modes a commit request can write (gitlinks cannot be merged here). */
const MODES = new Set(['100644', '100755', '120000']);

export interface TextMerge {
  text: string;
  hunks: ConflictHunk[];
}

/** For each `base` line, its index in `other` when the diff keeps it, else -1. */
function matches(base: string[], other: string[]): Int32Array {
  const out = new Int32Array(base.length).fill(-1);
  for (const op of diffOps(base, other)) if (op.type === 'eq') out[op.a] = op.b;
  return out;
}

function same(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

/**
 * diff3: walk the base lines both sides keep, and between two of them take
 * the side that changed. Both sides changing the same region differently
 * (adjacent edits included, as in Git) is a conflict hunk. Identical changes
 * on both sides merge cleanly. Lines keep their terminators.
 */
export function merge3(base: string, ours: string, theirs: string): TextMerge {
  const b = splitLines(base);
  const x = splitLines(ours);
  const y = splitLines(theirs);
  const mx = matches(b, x);
  const my = matches(b, y);
  const out: string[] = [];
  const hunks: ConflictHunk[] = [];
  let i = 0;
  let ix = 0;
  let iy = 0;
  for (;;) {
    if (i < b.length && mx[i] === ix && my[i] === iy) {
      out.push(b[i] as string);
      i++;
      ix++;
      iy++;
      continue;
    }
    let j = i;
    while (j < b.length && (mx[j] === -1 || my[j] === -1)) j++;
    const ex = j < b.length ? (mx[j] as number) : x.length;
    const ey = j < b.length ? (my[j] as number) : y.length;
    if (j === i && ex === ix && ey === iy) break;
    const bc = b.slice(i, j);
    const xc = x.slice(ix, ex);
    const yc = y.slice(iy, ey);
    if (same(xc, bc)) out.push(...yc);
    else if (same(yc, bc) || same(xc, yc)) out.push(...xc);
    else
      hunks.push({
        base: { start: i + 1, lines: bc },
        ours: { start: ix + 1, lines: xc },
        theirs: { start: iy + 1, lines: yc },
      });
    i = j;
    ix = ex;
    iy = ey;
  }
  return { text: out.join(''), hunks };
}

// Bytes travel through merge3 as one char per byte, so any encoding survives.
function toBinary(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 8192)
    out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return out;
}

function fromBinary(text: string): Uint8Array {
  return Uint8Array.from(text, (ch) => ch.charCodeAt(0));
}

const utf8 = new TextDecoder();

/** Hunk lines as UTF-8 text for the conflict report. */
function readable(hunk: ConflictHunk): ConflictHunk {
  const side = (s: ConflictHunk['base']): ConflictHunk['base'] => ({
    start: s.start,
    lines: s.lines.map((line) => utf8.decode(fromBinary(line))),
  });
  return { base: side(hunk.base), ours: side(hunk.ours), theirs: side(hunk.theirs) };
}

/** Git's heuristic: a NUL in the first 8000 bytes means binary. */
function isBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, 8000).includes(0);
}

export interface TreeMerge {
  /** File changes that turn `ours` into the merged tree (none when conflicted). */
  changes: Change[];
  conflicts: MergeConflict[];
}

type Entry = TreeEntry | null;

function sameEntry(a: Entry, b: Entry): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.kind === b.kind &&
    a.hash === b.hash &&
    (a.kind === 'tree' || (a.mode ?? '100644') === (b.mode ?? '100644'))
  );
}

const treeOf = (e: Entry): string | null => (e?.kind === 'tree' ? e.hash : null);
const join = (dir: string, name: string): string =>
  dir === '' ? name : `${dir}/${name}`;

/**
 * Merge `theirs` into `ours` against `base` (root tree hashes; null is the
 * empty tree). Recurses only into directories both sides changed; merged file
 * content is stored as blobs so `changes` can go straight to `commitChanges`
 * (`store: false` only checks).
 */
export async function mergeTrees(
  env: Env,
  repoId: string,
  base: string | null,
  ours: string | null,
  theirs: string | null,
  { store = true }: { store?: boolean } = {},
): Promise<TreeMerge> {
  const changes: Change[] = [];
  const conflicts: MergeConflict[] = [];
  const entries = async (hash: string | null): Promise<TreeEntry[]> =>
    hash === null ? [] : ((await getTree(env, repoId, hash))?.entries ?? []);

  const blobChange = (path: string, op: 'add' | 'mod', e: TreeEntry): void => {
    const mode = e.mode ?? '100644';
    if (!MODES.has(mode)) {
      conflicts.push({ path, kind: 'unsupported' });
      return;
    }
    changes.push({
      path,
      op,
      blob_sha256: e.hash,
      mode: mode as '100644' | '100755' | '120000',
    });
  };

  // ours → theirs for a path only theirs changed
  const adopt = async (path: string, o: Entry, t: Entry): Promise<void> => {
    if (sameEntry(o, t)) return;
    if (o?.kind === 'blob' && t?.kind === 'blob') return blobChange(path, 'mod', t);
    if (o?.kind === 'blob') changes.push({ path, op: 'del' });
    if (t?.kind === 'blob') blobChange(path, 'add', t);
    const [oe, te] = await Promise.all([entries(treeOf(o)), entries(treeOf(t))]);
    for (const name of new Set([...oe, ...te].map((e) => e.name)))
      await adopt(
        join(path, name),
        oe.find((e) => e.name === name) ?? null,
        te.find((e) => e.name === name) ?? null,
      );
  };

  const mergeFile = async (
    path: string,
    b: TreeEntry | null,
    o: TreeEntry,
    t: TreeEntry,
  ): Promise<void> => {
    const [bm, om, tm] = [b?.mode, o.mode, t.mode].map((m) => m ?? '100644');
    const mode = om === tm ? om : b && om === bm ? tm : b && tm === bm ? om : null;
    if (mode === null) {
      conflicts.push({ path, kind: 'mode' });
      return;
    }
    let hash: string;
    if (o.hash === t.hash) hash = o.hash;
    else if (b?.hash === o.hash) hash = t.hash;
    else if (b?.hash === t.hash) hash = o.hash;
    else {
      const sides = [b, o, t].filter((e): e is TreeEntry => e !== null);
      if (sides.some((e) => (e.size ?? 0) > MAX_MERGE_BYTES)) {
        conflicts.push({ path, kind: 'too_large' });
        return;
      }
      const blobs = await Promise.all(
        sides.map((e) => getBlob(env, repoId, e.hash).then((blob) => blob?.content)),
      );
      if (blobs.some((bytes) => bytes === undefined))
        throw new Error(`merge: blob missing under ${path}`);
      const bytes = blobs as Uint8Array[];
      if (bytes.some((x) => x.byteLength > MAX_MERGE_BYTES)) {
        conflicts.push({ path, kind: 'too_large' });
        return;
      }
      if (bytes.some(isBinary)) {
        conflicts.push({ path, kind: 'binary' });
        return;
      }
      const texts = bytes.map(toBinary);
      if (b === null) texts.unshift('');
      if (texts.some((text) => splitLines(text).length > MAX_MERGE_LINES)) {
        conflicts.push({ path, kind: 'too_large' });
        return;
      }
      const merged = merge3(texts[0] as string, texts[1] as string, texts[2] as string);
      if (merged.hunks.length > 0) {
        conflicts.push({
          path,
          kind: b === null ? 'add_add' : 'content',
          hunks: merged.hunks.map(readable),
        });
        return;
      }
      const content = fromBinary(merged.text);
      hash = store
        ? (await putBlob(env, repoId, content)).hash
        : await sha256Hex(content);
    }
    if (hash !== o.hash || mode !== om)
      blobChange(path, 'mod', { name: o.name, kind: 'blob', hash, mode });
  };

  const mergeDir = async (
    path: string,
    b: string | null,
    o: string | null,
    t: string | null,
  ): Promise<void> => {
    const [be, oe, te] = await Promise.all([entries(b), entries(o), entries(t)]);
    const names = [...new Set([...be, ...oe, ...te].map((e) => e.name))].sort();
    for (const name of names) {
      const p = join(path, name);
      const bx = be.find((e) => e.name === name) ?? null;
      const ox = oe.find((e) => e.name === name) ?? null;
      const tx = te.find((e) => e.name === name) ?? null;
      if (sameEntry(ox, tx) || sameEntry(bx, tx)) continue; // ours already has it
      if (sameEntry(bx, ox)) {
        await adopt(p, ox, tx);
        continue;
      }
      // both sides changed this name, differently
      if (ox?.kind !== 'blob' && tx?.kind !== 'blob' && bx?.kind !== 'blob')
        await mergeDir(p, treeOf(bx), treeOf(ox), treeOf(tx));
      else if (ox?.kind === 'blob' && tx?.kind === 'blob')
        await mergeFile(p, bx?.kind === 'blob' ? bx : null, ox, tx);
      else if (ox === null || tx === null)
        conflicts.push({ path: p, kind: 'modify_delete' });
      else conflicts.push({ path: p, kind: 'file_directory' });
    }
  };

  if (ours !== theirs && base !== theirs) {
    if (base === ours) await adopt('', treeEntry(ours), treeEntry(theirs));
    else await mergeDir('', base, ours, theirs);
  }
  return conflicts.length > 0 ? { changes: [], conflicts } : { changes, conflicts };
}

function treeEntry(hash: string | null): Entry {
  return hash === null ? null : { name: '', kind: 'tree', hash };
}

export interface ThreeWay extends TreeMerge {
  /** The merge base used (null for unrelated histories: the empty tree). */
  base: string | null;
}

/** Merge changeset `theirs` into `ours` against their merge base. */
export async function threeWay(
  env: Env,
  repoId: string,
  ours: Changeset,
  theirs: Changeset,
  opts: { store?: boolean } = {},
): Promise<ThreeWay> {
  const { bases } = await dagMergeBases(env, repoId, ours.id, theirs.id);
  if (bases.length > 1)
    return {
      base: null,
      changes: [],
      conflicts: [{ path: '', kind: 'multiple_merge_bases' }],
    };
  const base = bases[0] ?? null;
  const baseRoot =
    base === null ? null : ((await getChangeset(env, repoId, base))?.root_tree ?? null);
  return {
    base,
    ...(await mergeTrees(env, repoId, baseRoot, ours.root_tree, theirs.root_tree, opts)),
  };
}

/** Most conflicts one error lists; `conflict_count` has the total. */
const MAX_REPORTED = 100;

/** `409 merge_conflict` with the machine-readable list. No ref has moved. */
export function conflictError(
  conflicts: MergeConflict[],
  extra: Record<string, unknown> = {},
): ConflictError {
  const n = conflicts.length;
  return new ConflictError(
    'merge_conflict',
    `${n} path${n === 1 ? '' : 's'} could not be merged automatically. Commit a resolution and try again.`,
    { conflicts: conflicts.slice(0, MAX_REPORTED), conflict_count: n, ...extra },
  );
}

/** Author, message and optional committer and time of a server-made commit. */
export interface CommitMeta {
  author: Author;
  message: string;
  created_at?: number;
  committer?: Committer;
}

/**
 * Merge `theirs` into `ours` as `git merge --no-ff` would: parents
 * `[ours, theirs]`, the merged tree, changes relative to `ours`.
 */
export async function mergeCommit(
  env: Env,
  repoId: string,
  ours: Changeset,
  theirs: Changeset,
  meta: CommitMeta,
): Promise<Changeset> {
  return landMerged(env, repoId, ours, theirs, meta, [theirs.id]);
}

/** One commit on `ours` with the tree a merge of `theirs` would have. */
export async function squashCommit(
  env: Env,
  repoId: string,
  ours: Changeset,
  theirs: Changeset,
  meta: CommitMeta,
): Promise<Changeset> {
  return landMerged(env, repoId, ours, theirs, meta, []);
}

async function landMerged(
  env: Env,
  repoId: string,
  ours: Changeset,
  theirs: Changeset,
  meta: CommitMeta,
  parents: string[],
): Promise<Changeset> {
  const merged = await threeWay(env, repoId, ours, theirs);
  if (merged.conflicts.length > 0)
    throw conflictError(merged.conflicts, { merge_base: merged.base });
  const result = await commitChanges(env, repoId, {
    first_parent: ours.id,
    parents,
    message: meta.message,
    author: meta.author,
    created_at: meta.created_at,
    changes: merged.changes,
    ...(meta.committer ? { committer: meta.committer } : {}),
  });
  return result.changeset;
}
