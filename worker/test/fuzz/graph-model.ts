/**
 * Pure (no I/O) half of the commit-graph fuzzer (issue #22): seeded PRNG, the
 * operation-log generator, and the brute-force oracles the invariants are
 * checked against. Everything here is a deterministic function of the seed,
 * so a failing run is reproduced by its seed + prefix length alone.
 */

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

/** Fixed default seed — the one the normal `npm test` run exercises. */
export const DEFAULT_SEEDS: readonly number[] = [0x5eed_22];

/**
 * Changesets per seed. 200 is the issue's target and runs in ~6 s, well under the
 * ~20 s budget per seed in the workers pool; override with `VITE_FUZZ_N`.
 */
export const DEFAULT_CHANGESETS = 200;

/**
 * Only `VITE_`-prefixed process env vars reach the workers pool (via vite's
 * `import.meta.env`) — a plain `FUZZ_SEED` is invisible to the test isolate
 * without a miniflare binding. So CI sets `VITE_FUZZ_SEED=1,2,3,4,5`
 * (comma list; decimal or 0x-hex). `FUZZ_SEED` is honoured too in case a
 * future config forwards it.
 */
export function fuzzSettings(): { seeds: number[]; changesets: number } {
  const env =
    (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  const rawSeeds = env.VITE_FUZZ_SEED ?? env.FUZZ_SEED;
  const seeds =
    rawSeeds === undefined || rawSeeds.trim() === ''
      ? [...DEFAULT_SEEDS]
      : rawSeeds.split(',').map((s) => {
          const n = Number(s.trim());
          if (!Number.isInteger(n))
            throw new Error(`bad fuzz seed: ${JSON.stringify(s)}`);
          return n >>> 0;
        });
  const rawN = env.VITE_FUZZ_N ?? env.FUZZ_N;
  const changesets = rawN === undefined ? DEFAULT_CHANGESETS : Number(rawN);
  if (!Number.isInteger(changesets) || changesets < 2) {
    throw new Error(`bad fuzz changeset count: ${JSON.stringify(rawN)}`);
  }
  return { seeds, changesets };
}

// ---------------------------------------------------------------------------
// PRNG
// ---------------------------------------------------------------------------

/** mulberry32 — tiny, fast, good enough for test-case generation. */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  }

  /** Uniform integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)] as T;
  }

  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [out[i], out[j]] = [out[j] as T, out[i] as T];
    }
    return out;
  }
}

/** Derive an independent stream (e.g. query sampling) from a seed. */
export function subSeed(seed: number, salt: number): number {
  return (Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(salt, 0xc2b2ae35)) >>> 0;
}

// ---------------------------------------------------------------------------
// Operation log
// ---------------------------------------------------------------------------

/**
 * 50 file paths, none a directory-prefix of another (so add/del never hit a
 * file/dir conflict) and nested so tree rebuilds and pruning are exercised.
 */
export const PATH_POOL: readonly string[] = [
  '',
  'src',
  'src/lib',
  'docs',
  'test',
].flatMap((dir) =>
  Array.from({ length: 10 }, (_, j) => (dir === '' ? `f${j}.txt` : `${dir}/f${j}.txt`)),
);

export interface OpChange {
  path: string;
  op: 'add' | 'mod' | 'del';
  /** File content after the op (absent for `del`). */
  content?: string;
}

/** One commitChanges call: parents are indices into the op log. */
export interface FuzzOp {
  parent: number | null;
  second: number | null;
  message: string;
  changes: OpChange[];
}

/** Model state per op: full file map + parents, for the oracles. */
export interface GraphModel {
  ops: FuzzOp[];
  files: Map<string, string>[];
}

const ROOT_P = 0.015;
const MERGE_P = 0.1;
const DEL_P = 0.25;

function randomLine(rng: Rng): string {
  // Small vocabulary → repeated lines, so Myers matching has ambiguity to resolve.
  return `line ${rng.int(40)}`;
}

function toLines(content: string): string[] {
  const lines = content.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function fromLines(lines: string[]): string {
  return lines.map((l) => `${l}\n`).join('');
}

function freshContent(rng: Rng): string {
  return fromLines(Array.from({ length: 1 + rng.int(8) }, () => randomLine(rng)));
}

/** 1–3 random line edits; guaranteed to change the content. */
function editContent(rng: Rng, old: string, index: number): string {
  const lines = toLines(old);
  const edits = 1 + rng.int(3);
  for (let e = 0; e < edits; e++) {
    const kind = rng.int(3);
    if (kind === 0 || lines.length <= 1) {
      lines.splice(rng.int(lines.length + 1), 0, randomLine(rng));
    } else if (kind === 1) {
      lines.splice(rng.int(lines.length), 1);
    } else {
      lines[rng.int(lines.length)] = randomLine(rng);
    }
  }
  const next = fromLines(lines);
  return next === old ? `${next}edit ${index}\n` : next;
}

const MAX_TIPS = 8;

/**
 * Branch tips, so first-parent spines get deep (uniform parents give spines
 * of depth ~ln N). Tip 0 is the "mainline" and is extended half the time;
 * ~10% of picks fork from any existing changeset, which opens a new tip.
 */
class Tips {
  private readonly tips: number[] = [];

  /** Choose a first parent; `slot` is the tip it extends (-1 = fork). */
  pick(rng: Rng, count: number): { parent: number; slot: number } {
    if (this.tips.length === 0 || rng.chance(0.1))
      return { parent: rng.int(count), slot: -1 };
    const slot = rng.chance(0.5) ? 0 : rng.int(this.tips.length);
    return { parent: this.tips[slot] as number, slot };
  }

  /** A second parent ≠ `parent`: usually another tip, else anything. */
  other(rng: Rng, count: number, parent: number): number {
    const tips = this.tips.filter((t) => t !== parent);
    if (tips.length > 0 && rng.chance(0.7)) return rng.pick(tips);
    const x = rng.int(count - 1);
    return x >= parent ? x + 1 : x;
  }

  advance(rng: Rng, slot: number, i: number): void {
    if (slot >= 0) {
      this.tips[slot] = i;
      return;
    }
    this.tips.push(i);
    if (this.tips.length > MAX_TIPS) this.tips.splice(1 + rng.int(MAX_TIPS), 1);
  }
}

function applyChanges(
  base: Map<string, string>,
  changes: OpChange[],
): Map<string, string> {
  const files = new Map(base);
  for (const c of changes) {
    if (c.op === 'del') files.delete(c.path);
    else files.set(c.path, c.content as string);
  }
  return files;
}

/** Generate the whole op log (and its model) up front from the seed. */
export function generateOps(seed: number, count: number): GraphModel {
  const rng = new Rng(seed);
  const ops: FuzzOp[] = [];
  const files: Map<string, string>[] = [];
  const tips = new Tips();

  for (let i = 0; i < count; i++) {
    const message = `fuzz ${seed} #${i}`;
    let op: FuzzOp;
    let slot = -1;
    if (i === 0 || rng.chance(ROOT_P)) {
      // extra roots make disjoint histories (merge-base null) possible
      const paths = rng.shuffle(PATH_POOL).slice(0, 1 + rng.int(4));
      op = {
        parent: null,
        second: null,
        message,
        changes: paths.map((path) => ({ path, op: 'add', content: freshContent(rng) })),
      };
    } else if (i >= 2 && rng.chance(MERGE_P)) {
      const pick = tips.pick(rng, i);
      const parent = pick.parent;
      const second = tips.other(rng, i, parent);
      slot = pick.slot;
      // take the second parent's version of up to 4 differing paths
      // (changed_files are relative to the first parent — Scion footnote 1)
      const a = files[parent] as Map<string, string>;
      const b = files[second] as Map<string, string>;
      const differing = [...new Set([...a.keys(), ...b.keys()])]
        .filter((p) => a.get(p) !== b.get(p))
        .sort();
      const changes = rng
        .shuffle(differing)
        .slice(0, rng.int(5))
        .map((path): OpChange => {
          const theirs = b.get(path);
          if (theirs === undefined) return { path, op: 'del' };
          return { path, op: a.has(path) ? 'mod' : 'add', content: theirs };
        });
      op = { parent, second, message, changes };
    } else {
      const pick = tips.pick(rng, i);
      const parent = pick.parent;
      const base = files[parent] as Map<string, string>;
      slot = pick.slot;
      const paths = rng.shuffle(PATH_POOL).slice(0, 1 + rng.int(4));
      op = {
        parent,
        second: null,
        message,
        changes: paths.map((path): OpChange => {
          const old = base.get(path);
          if (old === undefined) return { path, op: 'add', content: freshContent(rng) };
          if (rng.chance(DEL_P)) return { path, op: 'del' };
          return { path, op: 'mod', content: editContent(rng, old, i) };
        }),
      };
    }
    ops.push(op);
    tips.advance(rng, slot, i);
    const base = op.parent === null ? new Map<string, string>() : files[op.parent];
    files.push(applyChanges(base as Map<string, string>, op.changes));
  }
  return { ops, files };
}

/** Compact one-line-per-op rendering for failure messages. */
export function formatOps(ops: readonly FuzzOp[]): string {
  return ops
    .map((op, i) => {
      const parents =
        op.parent === null
          ? 'root'
          : `p=${op.parent}${op.second === null ? '' : ` merge=${op.second}`}`;
      const changes = op.changes.map((c) => `${c.op} ${c.path}`).join(', ');
      return `  #${i} ${parents} [${changes}]`;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Brute-force oracles (over op indices)
// ---------------------------------------------------------------------------

export class Oracle {
  private readonly dagCache = new Map<number, Set<number>>();

  constructor(
    readonly ops: readonly FuzzOp[],
    readonly files: readonly Map<string, string>[],
  ) {}

  /** First-parent spine of `i`, newest first, inclusive. */
  spine(i: number): number[] {
    const out: number[] = [];
    for (let c: number | null = i; c !== null; c = (this.ops[c] as FuzzOp).parent) {
      out.push(c);
    }
    return out;
  }

  /** First-parent reachability (isAncestor semantics), inclusive. */
  isSpineAncestor(a: number, b: number): boolean {
    return this.spine(b).includes(a);
  }

  /** Spines form a forest, so the first-parent LCA is unique (or absent). */
  spineMergeBase(a: number, b: number): number | null {
    const onA = new Set(this.spine(a));
    return this.spine(b).find((x) => onA.has(x)) ?? null;
  }

  /** All ancestors over every parent edge, inclusive. */
  dagAncestors(i: number): Set<number> {
    const cached = this.dagCache.get(i);
    if (cached) return cached;
    const seen = new Set<number>();
    const stack = [i];
    while (stack.length > 0) {
      const c = stack.pop() as number;
      if (seen.has(c)) continue;
      seen.add(c);
      const op = this.ops[c] as FuzzOp;
      if (op.parent !== null) stack.push(op.parent);
      if (op.second !== null) stack.push(op.second);
    }
    this.dagCache.set(i, seen);
    return seen;
  }

  /** Every path touched by any DAG ancestor (the `changed_paths` payload). */
  changedPaths(i: number): string[] {
    const paths = new Set<string>();
    for (const a of this.dagAncestors(i)) {
      for (const c of (this.ops[a] as FuzzOp).changes) paths.add(c.path);
    }
    return [...paths].sort();
  }

  /** Expected tree diff between two snapshots, as sorted `path:kind` keys. */
  treeDiff(from: number | null, to: number, side?: 'from' | 'to'): string[] {
    const a =
      from === null
        ? new Map<string, string>()
        : (this.files[from] as Map<string, string>);
    const b = this.files[to] as Map<string, string>;
    const out: string[] = [];
    for (const path of new Set([...a.keys(), ...b.keys()])) {
      const x = a.get(path);
      const y = b.get(path);
      if (x === y) continue;
      const kind = x === undefined ? 'add' : y === undefined ? 'del' : 'mod';
      out.push(side === undefined ? `${path}:${kind}` : `${path}:${kind}:${side}`);
    }
    return out.sort();
  }
}

export function lineCount(content: string): number {
  return toLines(content).length;
}

export function lineAt(content: string, line1: number): string | undefined {
  return toLines(content)[line1 - 1];
}

export function hasLine(content: string, line: string): boolean {
  return toLines(content).includes(line);
}
