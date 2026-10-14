import { z } from 'zod';
import type { Env } from '../../env';
import { getChangeset, type Changeset } from '../changesets';
import { getBlob } from '../blobs';
import { NotFoundError } from '../errors';
import { diffOps, splitLines } from '../xdiff';
import {
  enqueueDerived,
  isSentinel,
  peekDerived,
  registerKind,
  storeRaw,
  type DerivedKind,
} from '../derived';

/**
 * `blame` derived kind (architecture §1.5, issue #10) — per (changeset, file)
 * line attribution, the other query that forced full local clones.
 *
 * **Key convention:** the derived_data `cs_id` is `${csId}:${path}` (the kind
 * column disambiguates) — blame is per file, not per changeset. Payload:
 * `{path, blob_sha256, ranges: [{start, end, cs}]}` — 1-based inclusive line
 * ranges covering every line of the file at that revision.
 *
 * Recursion: `add` attributes every line to itself; `mod` re-matches lines
 * against the previous blame using the Myers edit script (issue #7) — matched
 * lines inherit their range, inserted lines attribute to the modifying
 * changeset. v1 does not track renames: a moved file blames wholly to its add
 * at the new path.
 */

export const BLAME = 'blame';
/** Range marker for lines whose origin is beyond the computed window. */
export const BLAME_TRUNCATED_CS = '…';
export const BLAME_MAX_BYTES = 4 * 1024 * 1024;

export interface BlameRange {
  start: number;
  end: number;
  cs: string;
}

export interface BlamePayload {
  path: string;
  blob_sha256: string;
  ranges: BlameRange[];
}

const payloadSchema = z.object({
  path: z.string(),
  blob_sha256: z.string(),
  ranges: z.array(z.object({ start: z.number(), end: z.number(), cs: z.string() })),
});

export const blameKind: DerivedKind<BlamePayload> = {
  name: BLAME,
  eager: false,
  maxPayloadBytes: BLAME_MAX_BYTES,
  changesetOfKey: (key) => key.slice(0, key.indexOf(':')),
  async compute(env, repoId, _cs, ctx) {
    const key = ctx.key;
    const path = key.slice(key.indexOf(':') + 1);
    const csId = key.slice(0, key.indexOf(':'));
    const computed = await computeBlame(env, repoId, csId, path, 10_000);
    if (!computed.found) {
      throw new NotFoundError('path_not_found', `no blame target ${key}`);
    }
    return { path, blob_sha256: computed.blob_sha256, ranges: computed.ranges };
  },
  parse(payload) {
    return payloadSchema.parse(JSON.parse(payload));
  },
};

registerKind(blameKind);

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

interface ChainLink {
  cs: Changeset;
  op: 'add' | 'mod';
  hash: string;
}

export interface BlameCompute {
  found: boolean;
  ranges: BlameRange[];
  blob_sha256: string;
  /** False when the chain hit the generation budget or history gaps. */
  complete: boolean;
}

/**
 * Compute blame for `path` at `csId`: resolve the toucher chain (newest first)
 * along the first-parent spine, bounded by `maxGenerations`, then fold line
 * attribution forward from the oldest readable generation.
 */
export async function computeBlame(
  env: Env,
  repoId: string,
  csId: string,
  path: string,
  maxGenerations: number,
): Promise<BlameCompute> {
  const chain: ChainLink[] = [];
  let cursor: string | null = csId;
  let budgetCut = false;

  while (chain.length < maxGenerations) {
    const cs = await getChangeset(env, repoId, cursor);
    if (cs === null)
      return { found: chain.length === 0, ranges: [], blob_sha256: '', complete: false };
    const touch = cs.changed_files.find((f) => f.path === path);
    if (touch) {
      if (touch.op === 'del') {
        // Deleted at/below the query revision: no file to blame.
        if (chain.length === 0) {
          return { found: false, ranges: [], blob_sha256: '', complete: true };
        }
        return {
          found: true,
          ranges: [],
          blob_sha256: chain[0]?.hash ?? '',
          complete: false,
        };
      }
      chain.push({ cs, op: touch.op, hash: touch.hash as string });
      if (touch.op === 'add') break;
    }
    if (cs.first_parent === null) {
      budgetCut = true;
      break;
    }
    cursor = cs.first_parent;
  }
  if (chain.length >= maxGenerations && chain[chain.length - 1]?.op !== 'add') {
    budgetCut = true;
  }
  if (chain.length === 0) {
    return { found: false, ranges: [], blob_sha256: '', complete: true };
  }

  // Read every generation's content, tolerant of corrupt/missing blobs:
  // attribution falls back to the EARLIEST READABLE generation (logged), and
  // never fails the request. chain[0] is the newest generation.
  const decoder = new TextDecoder();
  const contents: (string | null)[] = [];
  for (const link of chain) {
    try {
      const blob = await getBlob(env, repoId, link.hash);
      contents.push(blob ? decoder.decode(blob.content) : null);
    } catch (err) {
      console.warn(`blame: unreadable blob ${link.hash} for ${path}`, err);
      contents.push(null);
    }
  }

  // Base = the OLDEST readable generation (last non-null; chain is newest-first).
  let baseIndex = -1;
  for (let i = contents.length - 1; i >= 0; i--) {
    if (contents[i] !== null) {
      baseIndex = i;
      break;
    }
  }
  if (baseIndex < 0) {
    return {
      found: true,
      ranges: [],
      blob_sha256: chain[0]?.hash ?? '',
      complete: false,
    };
  }

  const baseLink = chain[baseIndex] as ChainLink;
  const baseLines = splitLines(contents[baseIndex] as string);
  const originReached =
    baseIndex === chain.length - 1 && baseLink.op === 'add' && !budgetCut;
  const baseCs = originReached
    ? baseLink.cs.id // the file's origin — everything traces to it
    : baseIndex < chain.length - 1
      ? baseLink.cs.id // corrupt fallback: earliest readable generation
      : BLAME_TRUNCATED_CS; // budget cut: origin is somewhere above
  let ranges: BlameRange[] = coalesce(baseLines.map(() => baseCs));
  let blobSha = baseLink.hash;

  // Fold forward: oldest -> newest, one Myers edit script per generation.
  let prevText = contents[baseIndex] as string;
  for (let i = baseIndex - 1; i >= 0; i--) {
    const link = chain[i] as ChainLink;
    const newText = contents[i];
    if (newText === null) continue; // unreadable generation: skip gracefully
    ranges = applyEditScript(
      link.cs.id,
      splitLines(prevText),
      splitLines(newText),
      ranges,
    );
    prevText = newText;
    blobSha = link.hash;
  }

  return {
    found: true,
    ranges,
    blob_sha256: blobSha,
    // Complete = the chain reached the file's ORIGIN (not just: no markers —
    // a full fold can legitimately replace every truncated range).
    complete: !budgetCut && !ranges.some((r) => r.cs === BLAME_TRUNCATED_CS),
  };
}

/** Map the Myers edit script onto blame ranges: matched lines inherit. */
function applyEditScript(
  newCs: string,
  oldLines: string[],
  newLines: string[],
  oldRanges: BlameRange[],
): BlameRange[] {
  const perLine: string[] = new Array<string>(newLines.length).fill(newCs);
  for (const op of diffOps(oldLines, newLines)) {
    if (op.type === 'ins') {
      perLine[op.b] = newCs;
    } else if (op.type === 'eq') {
      perLine[op.b] = csAt(oldRanges, op.a);
    }
  }
  return coalesce(perLine);
}

function csAt(ranges: BlameRange[], lineIndex0: number): string {
  const line = lineIndex0 + 1;
  for (const range of ranges) {
    if (line >= range.start && line <= range.end) return range.cs;
  }
  return BLAME_TRUNCATED_CS;
}

function coalesce(perLine: string[]): BlameRange[] {
  const ranges: BlameRange[] = [];
  for (let i = 0; i < perLine.length; i++) {
    const cs = perLine[i] as string;
    const last = ranges[ranges.length - 1];
    if (last && last.cs === cs && last.end === i) {
      last.end = i + 1;
    } else {
      ranges.push({ start: i + 1, end: i + 1, cs });
    }
  }
  return ranges;
}

// ---------------------------------------------------------------------------
// Route-facing entry point
// ---------------------------------------------------------------------------

export type BlameOutcome =
  | {
      status: 'ok';
      path: string;
      cs: string;
      ranges: BlameRange[];
      complete: boolean;
      /** False → serve with `X-YAG-Blame: uncached` (oversize fallback). */
      cached: boolean;
    }
  | {
      status: 'computing';
      /** Partial attribution available (truncated ranges), if computed. */
      ranges?: BlameRange[];
    };

/**
 * Blame a file at a revision with the bounded/202 semantics (issue #10):
 * cache hit → serve; cold + `background` → 202 + queue; otherwise compute
 * inline (bounded by `maxGenerations`, default 100) and 202 + enqueue when the
 * chain outgrows the budget. Oversize payloads fall back to uncached
 * on-the-fly attribution.
 */
export async function blameFile(
  env: Env,
  repoId: string,
  csId: string,
  path: string,
  opts: { background?: boolean; maxGenerations?: number } = {},
): Promise<BlameOutcome> {
  const key = `${csId}:${path}`;

  const stored = await peekDerived(env, repoId, BLAME, key);
  if (stored !== null) {
    const raw = JSON.parse(stored) as unknown;
    if (isSentinel(raw)) {
      // Oversize sentinel: on-the-fly attribution, never cached.
      const computed = await computeBlame(env, repoId, csId, path, 10_000);
      return {
        status: 'ok',
        path,
        cs: csId,
        ranges: computed.ranges,
        complete: computed.complete,
        cached: false,
      };
    }
    const payload = blameKind.parse(stored);
    return {
      status: 'ok',
      path,
      cs: csId,
      ranges: payload.ranges,
      complete: !payload.ranges.some((r) => r.cs === BLAME_TRUNCATED_CS),
      cached: true,
    };
  }

  if (opts.background) {
    await enqueueDerived(env, [{ repo_id: repoId, kind: BLAME, cs_id: key }]);
    return { status: 'computing' };
  }

  const computed = await computeBlame(
    env,
    repoId,
    csId,
    path,
    opts.maxGenerations ?? 100,
  );
  if (!computed.found) {
    throw new NotFoundError('path_not_found', `no file ${path} at ${csId}`, { path });
  }
  if (!computed.complete) {
    // Over budget or history gap: partial attribution now, full answer via the
    // queue.
    await enqueueDerived(env, [{ repo_id: repoId, kind: BLAME, cs_id: key }]);
    return { status: 'computing', ranges: computed.ranges };
  }

  const payload: BlamePayload = {
    path,
    blob_sha256: computed.blob_sha256,
    ranges: computed.ranges,
  };
  const text = JSON.stringify(payload);
  if (text.length > BLAME_MAX_BYTES) {
    await storeRaw(env, repoId, BLAME, key, { oversize: true });
    return {
      status: 'ok',
      path,
      cs: csId,
      ranges: payload.ranges,
      complete: true,
      cached: false,
    };
  }
  await storeRaw(env, repoId, BLAME, key, payload);
  return {
    status: 'ok',
    path,
    cs: csId,
    ranges: payload.ranges,
    complete: true,
    cached: true,
  };
}
