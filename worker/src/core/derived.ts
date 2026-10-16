import { z } from 'zod';
import type { Env } from '../env';
import { C, T } from '../db/schema';
import { q1, run, tx } from '../db/client';
import { storageId } from './network';
import { getChangeset, type Changeset } from './changesets';

/**
 * Generic derived-data framework (architecture §1.5): **one** mechanism, each
 * kind defined recursively (its value for a changeset is computed from values
 * for its parents), each kind independently eager or deferred. Payloads are
 * private to the server — clients only ever see derived *answers*.
 *
 * - eager kinds run in the commit path (`computeEager`, one D1 batch)
 * - deferred kinds compute cache-aside on first read (`getDerived`) or in the
 *   `derived-data` queue consumer
 * - payload guards keep rows bounded; oversized payloads store an
 *   `{oversize:true}` sentinel and enqueue a kind-specific compaction message
 *
 * Kinds are registered at module load in this file (no cross-module registry
 * cycles): `skip_list` (issue #8) and `changed_paths` live here; issues #10+,
 */

// ---------------------------------------------------------------------------
// Kind contract
// ---------------------------------------------------------------------------

export interface DerivedCtx {
  /** parentId → { kindName: payload } for registered kinds. */
  parents: Record<string, Record<string, unknown>>;
  /**
   * The derived_data key being computed. Composite-key kinds (blame:
   * `csId:path`) parse their subkey from this.
   */
  key: string;
  getBlobContent?: (hash: string) => Promise<Uint8Array | null>;
  signal?: AbortSignal;
}

export interface DerivedKind<P = unknown> {
  name: string;
  /** Computed in the commit path; otherwise deferred (cache-aside / queue). */
  eager: boolean;
  /**
   * Composite keys: map a derived_data `cs_id` key to the changeset it derives
   * from (blame uses `csId:path`). Default: the key is the changeset id.
   */
  changesetOfKey?(key: string): string;
  compute(env: Env, repoId: string, cs: Changeset, ctx: DerivedCtx): Promise<P>;
  parse(payload: string): P;
  /** Row size guard; default 1 MiB. */
  maxPayloadBytes?: number;
  /**
   * Reads its parents from its own tables (git_ids): it gets an empty
   * `ctx.parents` and is never loaded into another kind's parent context.
   */
  isolated?: boolean;
}

/**
 * A computation saved partial progress and needs another invocation (a CPU
 * or hashing bound). The queue consumer re-enqueues instead of retrying.
 * `first` names a key that must be computed before this one can finish.
 */
export class DerivedDeferredError extends Error {
  constructor(
    message: string,
    readonly first?: string,
  ) {
    super(message);
    this.name = 'DerivedDeferredError';
  }
}

/** The message that continues `msg` after it deferred (see `resume`). */
export function continuation(
  msg: DerivedMessage,
  err: DerivedDeferredError,
): DerivedMessage {
  if (err.first === undefined) return msg;
  return { ...msg, cs_id: err.first, resume: [msg.cs_id, ...(msg.resume ?? [])] };
}

const derivedKinds = new Map<string, DerivedKind>();

export function registerKind<P>(kind: DerivedKind<P>): void {
  derivedKinds.set(kind.name, kind as DerivedKind);
}

export function getKind(name: string): DerivedKind | undefined {
  return derivedKinds.get(name);
}

export function registeredKinds(): DerivedKind[] {
  return [...derivedKinds.values()];
}

const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024;

// ---------------------------------------------------------------------------
// Storage (derived_data rows; internals stay server-side)
// ---------------------------------------------------------------------------

export const OVERSIZE_SENTINEL = { oversize: true } as const;
export const FAILED_SENTINEL = { failed: true } as const;

/** Sentinel rows ({oversize}|{failed}) are terminal answers, not payloads. */
export function isSentinel(payload: unknown): boolean {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    ('oversize' in payload || 'failed' in payload)
  );
}

/** Parse a stored row: sentinels pass through, payloads go through the kind. */
export function parseStored<P>(kind: DerivedKind<P>, text: string): P {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = null;
  }
  if (isSentinel(raw)) return raw as P;
  return kind.parse(text);
}

async function readRaw(
  env: Env,
  repoId: string,
  kind: string,
  csId: string,
): Promise<string | null> {
  const row = await q1(
    env,
    `SELECT ${C.derivedData.payload} FROM ${T.derivedData}
      WHERE ${C.derivedData.repoId} = ? AND ${C.derivedData.kind} = ? AND ${C.derivedData.csId} = ?`,
    [storageId(repoId), kind, csId],
  );
  if (!row) return null;
  return String((row as Record<string, unknown>)[C.derivedData.payload]);
}

/** Read a stored payload without computing (null when absent). */
export async function peekDerived(
  env: Env,
  repoId: string,
  kindName: string,
  key: string,
): Promise<string | null> {
  return readRaw(env, repoId, kindName, key);
}

/** Idempotent row write — concurrent computations settle on one row. */
export async function storeRaw(
  env: Env,
  repoId: string,
  kind: string,
  csId: string,
  payload: unknown,
): Promise<void> {
  await run(
    env,
    `INSERT INTO ${T.derivedData}
       (${C.derivedData.repoId}, ${C.derivedData.kind}, ${C.derivedData.csId},
        ${C.derivedData.payload}, ${C.derivedData.computedAt})
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (${C.derivedData.repoId}, ${C.derivedData.kind}, ${C.derivedData.csId})
     DO NOTHING`,
    [storageId(repoId), kind, csId, JSON.stringify(payload), Date.now()],
  );
}

// ---------------------------------------------------------------------------
// Cache-aside reads and eager computation
// ---------------------------------------------------------------------------

/**
 * Cache-aside read: row → parse; on miss, compute (self-healing — covers both
 * deferred kinds and eager rows that predate the framework), store, return.
 */
export async function getDerived<P = unknown>(
  env: Env,
  repoId: string,
  kindName: string,
  key: string,
): Promise<P | null> {
  const kind = derivedKinds.get(kindName) as DerivedKind<P> | undefined;
  if (!kind) throw new Error(`unknown derived kind: ${kindName}`);
  const existing = await readRaw(env, repoId, kindName, key);
  if (existing !== null) return parseStored(kind, existing);

  const csId = kind.changesetOfKey?.(key) ?? key;
  const cs = await getChangeset(env, repoId, csId);
  if (cs === null) return null;
  const value = await computeDerived(env, repoId, kind, cs, key);
  await writeKindRow(env, repoId, kind, key, value);
  // Re-read so concurrent losers converge on the surviving row.
  const stored = await readRaw(env, repoId, kindName, key);
  return stored === null ? (value as P) : parseStored(kind, stored);
}

/** Compute a kind's value with a memoized per-call parent context. */
export async function computeDerived<P>(
  env: Env,
  repoId: string,
  kind: DerivedKind<P>,
  cs: Changeset,
  key: string = cs.id,
): Promise<P> {
  const ctx: DerivedCtx = { parents: {}, key };
  for (const parentId of kind.isolated ? [] : cs.parents) {
    const payloads: Record<string, unknown> = {};
    for (const other of derivedKinds.values()) {
      if (other.isolated) continue;
      const value = await getDerived(env, repoId, other.name, parentId);
      if (value !== null) payloads[other.name] = value;
    }
    ctx.parents[parentId] = payloads;
  }
  return kind.compute(env, repoId, cs, ctx);
}

async function writeKindRow(
  env: Env,
  repoId: string,
  kind: DerivedKind,
  csId: string,
  value: unknown,
): Promise<void> {
  const maxBytes = kind.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  const text = JSON.stringify(value);
  if (text.length > maxBytes) {
    // Oversize: store the sentinel and ask the kind (via the queue) to
    // compact — blame chunks by file, path kinds collapse (issue #10).
    await storeRaw(env, repoId, kind.name, csId, OVERSIZE_SENTINEL);
    await enqueueDerived(env, [
      { repo_id: repoId, kind: kind.name, cs_id: csId, compaction: true },
    ]);
    return;
  }
  await storeRaw(env, repoId, kind.name, csId, value);
}

/**
 * Run every eager kind for a freshly created changeset and write the rows in
 * one D1 batch. Called from the commit hook (`onChangesetCreated`).
 */
export async function computeEager(
  env: Env,
  repoId: string,
  cs: Changeset,
): Promise<void> {
  const statements: { sql: string; params: unknown[] }[] = [];
  for (const kind of derivedKinds.values()) {
    if (!kind.eager) continue;
    const value = await computeDerived(env, repoId, kind, cs);
    const maxBytes = kind.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    const text = JSON.stringify(value);
    if (text.length > maxBytes) {
      await storeRaw(env, repoId, kind.name, cs.id, OVERSIZE_SENTINEL);
      await enqueueDerived(env, [
        { repo_id: repoId, kind: kind.name, cs_id: cs.id, compaction: true },
      ]);
      continue;
    }
    statements.push({
      sql: `INSERT INTO ${T.derivedData}
              (${C.derivedData.repoId}, ${C.derivedData.kind}, ${C.derivedData.csId},
               ${C.derivedData.payload}, ${C.derivedData.computedAt})
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (${C.derivedData.repoId}, ${C.derivedData.kind}, ${C.derivedData.csId})
            DO NOTHING`,
      params: [storageId(repoId), kind.name, cs.id, text, Date.now()],
    });
  }
  if (statements.length > 0) {
    await tx(env, (t) => {
      for (const s of statements) t.q(s.sql, s.params);
    });
  }
}

// ---------------------------------------------------------------------------
// Deferred queue plumbing
// ---------------------------------------------------------------------------

export interface DerivedMessage {
  repo_id: string;
  kind: string;
  cs_id: string;
  /** Oversize-payload compaction request (kind-specific). */
  compaction?: boolean;
  /** Keys of the same kind to compute next, in order, once this one is done. */
  resume?: string[];
}

export async function enqueueDerived(
  env: Env,
  messages: DerivedMessage[],
): Promise<void> {
  for (const message of messages) {
    await env.DERIVED_QUEUE.send(message);
  }
}

// ---------------------------------------------------------------------------
// Kind: skip_list (eager) — architecture §1.5 / issue #8
// ---------------------------------------------------------------------------

export interface SkipListEntry {
  depth: number;
  levels: number;
  pointers: string[][];
}

const skipListPayloadSchema = z.object({
  depth: z.number(),
  levels: z.number(),
  pointers: z.array(z.array(z.string())),
});

const MAX_LEVELS = 20;

/**
 * `pointers[k]` = the 2^k-th first-parent ancestor (Scion footnote 1: derived
 * ancestry follows the first-parent spine). Note the recursive definition
 * `pointers[k] = entry(pointers[k-1]).pointers[k-1]` needs entries of
 * ancestors at power-of-two distances — `entryOf` memoizes those lookups.
 */
async function entryOf(
  env: Env,
  repoId: string,
  byId: Map<string, SkipListEntry>,
  id: string,
  guard = { depth: 0 },
): Promise<SkipListEntry | null> {
  const local = byId.get(id);
  if (local) return local;
  const existing = await readRaw(env, repoId, SKIP_LIST, id);
  if (existing !== null) {
    const parsed = skipListPayloadSchema.safeParse(JSON.parse(existing));
    if (parsed.success) {
      byId.set(id, parsed.data);
      return parsed.data;
    }
  }
  if (guard.depth > 20) return null;
  const cs = await getChangeset(env, repoId, id);
  if (cs === null) return null;
  guard.depth++;
  const computed = await computeSkipListEntry(env, repoId, cs, byId);
  guard.depth--;
  byId.set(id, computed);
  await storeRaw(env, repoId, SKIP_LIST, id, computed);
  return computed;
}

/**
 * Compute the entry for `cs`, storing entries for any missing spine
 * ancestors on the way (self-healing; iterative, no deep recursion).
 */
export async function computeSkipListEntry(
  env: Env,
  repoId: string,
  cs: Changeset,
  memo = new Map<string, SkipListEntry>(),
): Promise<SkipListEntry> {
  // Collect the tip→oldest chain of changesets missing entries.
  const chain: Changeset[] = [];
  let cursor: Changeset | null = cs;
  let ancestorEntry: SkipListEntry | null = null;
  while (cursor !== null) {
    const stored = await readRaw(env, repoId, SKIP_LIST, cursor.id);
    if (stored !== null) {
      const parsed = skipListPayloadSchema.safeParse(JSON.parse(stored));
      if (parsed.success) {
        ancestorEntry = parsed.data;
        break;
      }
    }
    chain.push(cursor);
    cursor =
      cursor.first_parent === null
        ? null
        : await getChangeset(env, repoId, cursor.first_parent);
  }
  if (chain.length === 0) return ancestorEntry as SkipListEntry;

  const byId = memo;
  if (ancestorEntry !== null) {
    const oldest = chain[chain.length - 1] as Changeset;
    byId.set(oldest.first_parent as string, ancestorEntry);
  }

  let result: SkipListEntry | null = null;
  for (let i = chain.length - 1; i >= 0; i--) {
    const node = chain[i] as Changeset;
    const parentEntry =
      node.first_parent === null ? null : (byId.get(node.first_parent) ?? null);
    const entry = await computeSkipEntry(env, repoId, node, parentEntry, byId);
    byId.set(node.id, entry);
    await storeRaw(env, repoId, SKIP_LIST, node.id, entry);
    result = entry;
  }
  return result as SkipListEntry;
}

async function computeSkipEntry(
  env: Env,
  repoId: string,
  cs: Changeset,
  parentEntry: SkipListEntry | null,
  byId: Map<string, SkipListEntry>,
): Promise<SkipListEntry> {
  if (parentEntry === null || cs.first_parent === null) {
    return { depth: 0, levels: 0, pointers: [] };
  }
  const pointers: string[][] = [[cs.first_parent]];
  for (let k = 1; k < MAX_LEVELS; k++) {
    const prevAncestor = (pointers[k - 1] as string[])[0];
    if (prevAncestor === undefined) break;
    const prevEntry = await entryOf(env, repoId, byId, prevAncestor);
    const jump = prevEntry?.pointers[k - 1]?.[0];
    if (jump === undefined) break;
    pointers.push([jump]);
  }
  const depth = parentEntry.depth + 1;
  const levels = Math.min(Math.floor(Math.log2(depth)) + 1, MAX_LEVELS);
  return { depth, levels, pointers };
}

export const SKIP_LIST = 'skip_list';

export const skipListKind: DerivedKind<SkipListEntry> = {
  name: SKIP_LIST,
  eager: true,
  async compute(env, repoId, cs) {
    return computeSkipListEntry(env, repoId, cs);
  },
  parse(payload) {
    return skipListPayloadSchema.parse(JSON.parse(payload));
  },
};

// ---------------------------------------------------------------------------
// Kind: changed_paths (eager)
// ---------------------------------------------------------------------------

export const CHANGED_PATHS = 'changed_paths';

export interface ChangedPaths {
  paths: string[];
  /** True when the path set exceeded the cap and was collapsed/truncated. */
  oversize?: boolean;
}

const CHANGED_PATHS_CAP = 50_000;

/** Prefix-collapse: `a/b` + `a/b/c` → `a/b` (a dir covers everything under it). */
export function collapsePrefix(paths: Iterable<string>): string[] {
  const sorted = [...new Set(paths)].sort();
  const out: string[] = [];
  for (const path of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && path.startsWith(`${last}/`)) continue;
    out.push(path);
  }
  return out;
}

/** Collapse one level toward directories. */
function collapseToDirs(paths: string[]): string[] {
  return collapsePrefix(
    paths.map((p) => {
      const i = p.lastIndexOf('/');
      return i < 0 ? p : p.slice(0, i);
    }),
  );
}

/**
 * Prefix-collapse, then cap at `max` entries by collapsing toward the
 * nearest directories (git-style directory containment); if paths cannot
 * collapse further, truncate and flag `oversize`.
 */
export function collapsePaths(
  paths: Iterable<string>,
  max: number = CHANGED_PATHS_CAP,
): ChangedPaths {
  let current = collapsePrefix(paths);
  let oversize = false;
  while (current.length > max) {
    // over the cap: collapse toward the nearest directories (the collapsed
    // entries still cover their subtrees — consumers must treat them as
    // prefixes, hence `oversize`)
    oversize = true;
    const next = collapseToDirs(current);
    if (next.length >= current.length) {
      current = current.slice(0, max);
      break;
    }
    current = next;
  }
  return oversize ? { paths: current, oversize: true } : { paths: current };
}

export const changedPathsKind: DerivedKind<ChangedPaths> = {
  name: CHANGED_PATHS,
  eager: true,
  async compute(_env, _repoId, cs, ctx) {
    const all: string[] = cs.changed_files.map((f) => f.path);
    for (const payloads of Object.values(ctx.parents)) {
      const parent = payloads[CHANGED_PATHS] as ChangedPaths | undefined;
      if (parent && Array.isArray(parent.paths)) all.push(...parent.paths);
    }
    return collapsePaths(all);
  },
  parse(payload) {
    return z
      .object({ paths: z.array(z.string()), oversize: z.boolean().optional() })
      .parse(JSON.parse(payload));
  },
};

registerKind(skipListKind);
registerKind(changedPathsKind);
