import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../../src/env';
import { cleanDb, seedSchema, sha256 } from '../helpers';
import type { TestEnv } from '../helpers';
import { createRepo } from '../../src/db/repos';
import { commitChanges } from '../../src/core/commit';
import { computeChangesetId, getChangeset } from '../../src/core/changesets';
import {
  ancestorDistance,
  dagMergeBases,
  isAncestor,
  isAncestorDag,
  mergeBase,
} from '../../src/core/ancestry';
import { merge3, threeWay } from '../../src/core/merge';
import { CHANGED_PATHS, getDerived, type ChangedPaths } from '../../src/core/derived';
import { computeBlame } from '../../src/core/derived/blame';
import { diffRevisions } from '../../src/core/diff';
import { getTreeRecursive, type Tree } from '../../src/core/trees';
import {
  Oracle,
  Rng,
  formatOps,
  fuzzSettings,
  generateOps,
  hasLine,
  lineAt,
  lineCount,
  subSeed,
  type FuzzOp,
  type GraphModel,
} from './graph-model';

/**
 * Deterministic commit-graph fuzzer (issue #22). Each seed generates an op log
 * of random changesets (first parent mostly a branch tip so spines reach
 * depth ~100 at N=200, ~10% forks from any changeset, ~10% merges with a
 * random second parent, ~1.5% extra roots for disjoint histories, 1–4
 * touched paths from a 50-path pool), replays it
 * through `commitChanges`, then checks the core against brute-force oracles
 * over the in-memory model (`graph-model.ts`).
 *
 * On failure the log is shrunk by replaying prefixes (binary search on the
 * prefix length) and the minimal failing prefix is reported with the seed.
 *
 * Run more seeds (only VITE_-prefixed vars reach the workers pool):
 *   VITE_FUZZ_SEED=1,2,3,4,5 npx vitest run test/fuzz
 *   VITE_FUZZ_N=500 VITE_FUZZ_SEED=7 npx vitest run test/fuzz
 */

const testEnv = env as unknown as TestEnv;
const dbEnv = testEnv as unknown as Env;
const author = { name: 'Fuzz', email: 'fuzz@example.com' };
const encoder = new TextEncoder();

class InvariantFailure extends Error {
  constructor(
    readonly invariant: string,
    detail: string,
  ) {
    super(`${invariant}: ${detail}`);
  }
}

function check(ok: boolean, invariant: string, detail: () => string): void {
  if (!ok) throw new InvariantFailure(invariant, detail());
}

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

const shaCache = new Map<string, string>();
async function contentHash(content: string): Promise<string> {
  let hash = shaCache.get(content);
  if (hash === undefined) {
    hash = await sha256(encoder.encode(content));
    shaCache.set(content, hash);
  }
  return hash;
}

/** Flatten a recursive tree walk into path → blob hash. */
function flatten(trees: Map<string, Tree>, root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (hash: string, prefix: string): void => {
    for (const e of trees.get(hash)?.entries ?? []) {
      const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
      if (e.kind === 'tree') walk(e.hash, path);
      else out.set(path, e.hash);
    }
  };
  walk(root, '');
  return out;
}

let repoCounter = 0;

/**
 * Replay `ops[0..n)` into a fresh repo and run every invariant. Returns the
 * first violation (or a commit error) instead of throwing, so the shrinker
 * can probe prefixes.
 */
async function runPrefix(
  seed: number,
  model: GraphModel,
  n: number,
): Promise<InvariantFailure | null> {
  const ops = model.ops.slice(0, n);
  const oracle = new Oracle(ops, model.files.slice(0, n));
  const rng = new Rng(subSeed(seed, n));
  const repo = await createRepo(dbEnv, {
    slug: `fuzz/s${seed}-n${n}-${repoCounter++}`,
    visibility: 'public',
  });
  const ids: string[] = [];
  const index = new Map<string, number>();
  const at = (i: number): string => ids[i] as string;
  const name = (id: string | null): string =>
    id === null ? 'null' : index.has(id) ? `#${index.get(id)}` : id;

  const commitOp = (op: FuzzOp) =>
    commitChanges(dbEnv, repo.id, {
      first_parent: op.parent === null ? null : at(op.parent),
      parents: op.second === null ? undefined : [at(op.second)],
      message: op.message,
      author,
      changes: op.changes.map((c) =>
        c.op === 'del'
          ? { path: c.path, op: 'del' as const }
          : { path: c.path, op: c.op, content_b64: btoa(c.content as string) },
      ),
    });

  try {
    for (let i = 0; i < n; i++) {
      let res;
      try {
        res = await commitOp(ops[i] as FuzzOp);
      } catch (err) {
        throw new InvariantFailure('commit', `op #${i} threw: ${String(err)}`);
      }
      check(!res.deduped, 'commit', () => `op #${i} unexpectedly deduped`);
      ids.push(res.changeset.id);
      index.set(res.changeset.id, i);
    }
    const sample = (k: number): number[] => Array.from({ length: k }, () => rng.int(n));
    const spinePair = (): [number, number] => {
      const b = rng.int(n);
      return [rng.pick(oracle.spine(b)), b];
    };

    // 1. content-address integrity: stored fields re-hash to the id, parents
    //    and changed_files are what the op asked for.
    for (let i = 0; i < n; i++) {
      const op = ops[i] as FuzzOp;
      const cs = await getChangeset(dbEnv, repo.id, at(i));
      check(cs !== null, 'integrity', () => `#${i} missing`);
      if (cs === null) continue;
      const recomputed = await computeChangesetId(cs);
      check(recomputed === cs.id, 'integrity', () => `#${i} re-hashes to ${recomputed}`);
      const parents = [op.parent, op.second].filter((p) => p !== null).map(at);
      check(
        cs.first_parent === (op.parent === null ? null : at(op.parent)) &&
          sameList(cs.parents, parents),
        'integrity',
        () => `#${i} parents ${cs.parents.map(name).join(',')}`,
      );
      for (const c of op.changes) {
        const stored = cs.changed_files.find((f) => f.path === c.path);
        const hash = c.op === 'del' ? undefined : await contentHash(c.content as string);
        check(
          stored !== undefined && stored.op === c.op && stored.hash === hash,
          'integrity',
          () => `#${i} ${c.op} ${c.path} stored as ${JSON.stringify(stored)}`,
        );
      }
      check(
        cs.changed_files.length === op.changes.length,
        'integrity',
        () => `#${i} has ${cs.changed_files.length} changed files`,
      );
    }
    // identical requests are idempotent (content-addressed dedupe)
    for (const i of sample(3)) {
      const again = await commitOp(ops[i] as FuzzOp);
      check(
        again.deduped && again.changeset.id === at(i),
        'idempotency',
        () =>
          `re-commit of #${i} → deduped=${again.deduped} id=${name(again.changeset.id)}`,
      );
    }

    // 2. snapshot: root_tree flattens to exactly the model's files
    for (const i of sample(25)) {
      const cs = await getChangeset(dbEnv, repo.id, at(i));
      const root = cs?.root_tree ?? null;
      check(root !== null, 'snapshot', () => `#${i} has no root tree`);
      const actual = flatten(
        await getTreeRecursive(dbEnv, repo.id, root as string),
        root as string,
      );
      const expected = new Map<string, string>();
      for (const [path, content] of oracle.files[i] as Map<string, string>) {
        expected.set(path, await contentHash(content));
      }
      const fmt = (m: Map<string, string>): string[] =>
        [...m].map(([p, h]) => `${p}@${h.slice(0, 8)}`).sort();
      check(
        sameList(fmt(actual), fmt(expected)),
        'snapshot',
        () =>
          `#${i}\n  expected ${fmt(expected).join(' ')}\n  actual   ${fmt(actual).join(' ')}`,
      );
    }

    // 3. isAncestor / ancestorDistance (first-parent) and isAncestorDag (all
    //    parents) vs DFS — random pairs are mostly negative, spine pairs positive.
    const pairs: [number, number][] = [
      ...Array.from({ length: 80 }, (): [number, number] => [rng.int(n), rng.int(n)]),
      ...Array.from({ length: 40 }, spinePair),
    ];
    for (const [a, b] of pairs) {
      const expected = oracle.isSpineAncestor(a, b);
      const actual = await isAncestor(dbEnv, repo.id, at(a), at(b));
      check(
        actual === expected,
        'isAncestor',
        () => `(#${a}, #${b}) = ${actual}, DFS says ${expected}`,
      );
      const dist = await ancestorDistance(dbEnv, repo.id, at(a), at(b));
      const expDist = expected ? oracle.spine(b).indexOf(a) : null;
      check(
        dist === expDist,
        'ancestorDistance',
        () => `(#${a}, #${b}) = ${dist}, expected ${expDist}`,
      );
    }
    for (const [a, b] of pairs.slice(0, 50)) {
      const expected = oracle.dagAncestors(b).has(a);
      const actual = await isAncestorDag(dbEnv, repo.id, at(a), at(b));
      check(
        actual === expected,
        'isAncestorDag',
        () => `(#${a}, #${b}) = ${actual}, DFS says ${expected}`,
      );
    }

    // 4. mergeBase: spines form a forest, so the first-parent LCA is unique —
    //    criss-cross merges cannot produce two "best" bases under spine
    //    semantics; null when the spines reach different roots.
    for (let k = 0; k < 100; k++) {
      const [a, b] = k % 4 === 0 ? spinePair() : [rng.int(n), rng.int(n)];
      const expected = oracle.spineMergeBase(a, b);
      const actual = await mergeBase(dbEnv, repo.id, at(a), at(b));
      check(
        actual === (expected === null ? null : at(expected)),
        'mergeBase',
        () =>
          `(#${a}, #${b}) = ${name(actual)}, brute-force LCA ${expected === null ? 'null' : `#${expected}`}`,
      );
    }

    // 5. changed_paths: every path touched by any DAG ancestor, exactly
    for (const i of sample(40)) {
      const payload = await getDerived<ChangedPaths>(
        dbEnv,
        repo.id,
        CHANGED_PATHS,
        at(i),
      );
      const expected = oracle.changedPaths(i);
      check(
        payload !== null &&
          payload.oversize === undefined &&
          sameList(payload.paths, expected),
        'changed_paths',
        () =>
          `#${i}\n  expected ${expected.join(' ')}\n  actual   ${payload?.paths.join(' ')}`,
      );
    }

    // 6. blame soundness: complete cover of the file, every range attributed
    //    to a spine ancestor that touched the path and contained that line.
    for (const h of [n - 1, rng.int(n), rng.int(n)]) {
      const files = oracle.files[h] as Map<string, string>;
      for (const path of rng.shuffle([...files.keys()].sort()).slice(0, 5)) {
        const content = files.get(path) as string;
        const blame = await computeBlame(dbEnv, repo.id, at(h), path, 10_000);
        const where = `${path} @ #${h}`;
        check(
          blame.found && blame.complete,
          'blame',
          () => `${where}: found=${blame.found} complete=${blame.complete}`,
        );
        check(
          blame.blob_sha256 === (await contentHash(content)),
          'blame',
          () => `${where}: blob ${blame.blob_sha256}`,
        );
        let next = 1;
        for (const r of blame.ranges) {
          check(
            r.start === next && r.end >= r.start,
            'blame',
            () => `${where}: gap/overlap at ${JSON.stringify(r)}`,
          );
          next = r.end + 1;
          const c = index.get(r.cs);
          check(
            c !== undefined && oracle.isSpineAncestor(c, h),
            'blame',
            () => `${where}: ${name(r.cs)} not on spine`,
          );
          const touch = (ops[c as number] as FuzzOp).changes.find((x) => x.path === path);
          check(
            touch !== undefined && touch.op !== 'del',
            'blame',
            () =>
              `${where}: lines ${r.start}-${r.end} blamed on #${c}, which did not write ${path}`,
          );
          const then = (oracle.files[c as number] as Map<string, string>).get(
            path,
          ) as string;
          for (let line = r.start; line <= r.end; line++) {
            const text = lineAt(content, line) as string;
            check(
              hasLine(then, text),
              'blame',
              () => `${where}: line ${line} ${JSON.stringify(text)} absent at #${c}`,
            );
          }
        }
        check(
          next - 1 === lineCount(content),
          'blame',
          () => `${where}: covers ${next - 1}/${lineCount(content)} lines`,
        );
      }
    }

    // 7. diff vs the model's snapshots.
    const keysOf = (files: { path: string; kind: string; side?: string }[]): string[] =>
      files
        .map((f) =>
          f.side === undefined ? `${f.path}:${f.kind}` : `${f.path}:${f.kind}:${f.side}`,
        )
        .sort();
    // (a) spine ancestor → descendant: base is the ancestor, every file is on
    //     the `to` side, and the set is within the union of paths changed
    //     along the first-parent walk — exactly that union when no path is
    //     touched twice (every op is a real content change).
    for (let k = 0; k < 15; k++) {
      const [a, b] = spinePair();
      const diff = await diffRevisions(dbEnv, repo.id, at(a), at(b));
      const actual = keysOf(diff.files);
      const expected = oracle.treeDiff(a, b, 'to');
      const walk = oracle.spine(b).slice(0, oracle.spine(b).indexOf(a));
      const touched = walk.flatMap((x) => (ops[x] as FuzzOp).changes.map((c) => c.path));
      const union = [...new Set(touched)].sort();
      check(
        diff.merge_base === at(a) && sameList(actual, expected),
        'diff(ancestor, desc)',
        () =>
          `(#${a}, #${b}) base ${name(diff.merge_base)}\n  expected ${expected.join(' ')}\n  actual   ${actual.join(' ')}`,
      );
      const paths = diff.files.map((f) => f.path);
      check(
        paths.every((p) => union.includes(p)),
        'diff ⊆ walk',
        () => `(#${a}, #${b}) ${paths.join(' ')} ⊄ ${union.join(' ')}`,
      );
      if (touched.length === union.length) {
        check(
          sameList([...paths].sort(), union),
          'diff = walk',
          () =>
            `(#${a}, #${b})\n  walk union ${union.join(' ')}\n  diff       ${paths.join(' ')}`,
        );
      }
    }
    // (b) arbitrary pairs, three-dot: base per diffRevisions' rule (DAG
    //     ancestor shortcut, else spine merge base), files = both sides vs base.
    for (let k = 0; k < 15; k++) {
      const [a, b] = [rng.int(n), rng.int(n)];
      const base = oracle.dagAncestors(b).has(a)
        ? a
        : oracle.dagAncestors(a).has(b)
          ? b
          : oracle.spineMergeBase(a, b);
      const diff = await diffRevisions(dbEnv, repo.id, at(a), at(b));
      const expected = [
        ...oracle.treeDiff(base, a, 'from'),
        ...oracle.treeDiff(base, b, 'to'),
      ].sort();
      const actual = keysOf(diff.files);
      check(
        diff.merge_base === (base === null ? null : at(base)) &&
          sameList(actual, expected),
        'diff(three-dot)',
        () =>
          `(#${a}, #${b}) base ${name(diff.merge_base)} expected base ${base === null ? 'null' : `#${base}`}\n  expected ${expected.join(' ')}\n  actual   ${actual.join(' ')}`,
      );
    }
    // (c) arbitrary pairs, two-dot: direct snapshot difference.
    for (let k = 0; k < 15; k++) {
      const [a, b] = [rng.int(n), rng.int(n)];
      const diff = await diffRevisions(dbEnv, repo.id, at(a), at(b), { mode: 'direct' });
      const expected = oracle.treeDiff(a, b);
      const actual = keysOf(diff.files);
      check(
        sameList(actual, expected),
        'diff(direct)',
        () =>
          `(#${a}, #${b})\n  expected ${expected.join(' ')}\n  actual   ${actual.join(' ')}`,
      );
    }

    // 8. merges (#42): DAG merge bases are the brute-force best common
    //    ancestors, and with one base the merged tree is the union of the
    //    non-conflicting changes. A path one side changed takes that side; a
    //    path both changed differently is a conflict or the diff3 merge of
    //    both contents; nothing else conflicts.
    for (let k = 0; k < 20; k++) {
      const [a, b] = [rng.int(n), rng.int(n)];
      const bases = oracle.mergeBases(a, b);
      const walk = await dagMergeBases(dbEnv, repo.id, at(a), at(b));
      const pair = `(#${a}, #${b})`;
      check(
        sameList([...walk.bases].sort(), bases.map(at).sort()),
        'mergeBases',
        () =>
          `${pair} = ${walk.bases.map(name).join(',')}, expected #${bases.join(',#')}`,
      );
      const onlyB = [...oracle.dagAncestors(b)].filter(
        (x) => !oracle.dagAncestors(a).has(x),
      );
      check(
        sameList(walk.onlyB.map((cs) => cs.id).sort(), onlyB.map(at).sort()),
        'mergeBases a..b',
        () => `${pair} a..b = ${walk.onlyB.map((cs) => name(cs.id)).join(',')}`,
      );
      if (bases.length > 1) continue;
      const [ours, theirs] = await Promise.all([
        getChangeset(dbEnv, repo.id, at(a)),
        getChangeset(dbEnv, repo.id, at(b)),
      ]);
      const merged = await threeWay(dbEnv, repo.id, ours!, theirs!, { store: false });
      const B = bases.length === 0 ? new Map<string, string>() : oracle.files[bases[0]!]!;
      const O = oracle.files[a]!;
      const T = oracle.files[b]!;
      const conflicted = new Set(merged.conflicts.map((c) => c.path));
      const result = new Map<string, string>();
      for (const [path, content] of O) result.set(path, await contentHash(content));
      for (const c of merged.changes) {
        if (c.op === 'del') result.delete(c.path);
        else if ('blob_sha256' in c) result.set(c.path, c.blob_sha256);
      }
      for (const path of new Set([...B.keys(), ...O.keys(), ...T.keys()])) {
        const [bx, ox, tx] = [B.get(path), O.get(path), T.get(path)];
        const both = ox !== tx && bx !== ox && bx !== tx;
        if (conflicted.has(path)) {
          check(
            both,
            'merge conflicts',
            () => `${pair} ${path} conflicts but one side kept it`,
          );
          continue;
        }
        let expected: string | undefined;
        if (!both) expected = bx === ox ? tx : ox;
        else {
          check(
            ox !== undefined && tx !== undefined,
            'merge conflicts',
            () => `${pair} ${path}: modify/delete merged without a conflict`,
          );
          const text = merge3(bx ?? '', ox ?? '', tx ?? '');
          check(
            text.hunks.length === 0,
            'merge union',
            () => `${pair} ${path} unreported hunks`,
          );
          expected = text.text;
        }
        if (merged.conflicts.length > 0) continue;
        const actual = result.get(path);
        check(
          actual === (expected === undefined ? undefined : await contentHash(expected)),
          'merge union',
          () =>
            `${pair} ${path}: merged ${actual?.slice(0, 8)}, expected ${JSON.stringify(expected)}`,
        );
      }
    }
  } catch (err) {
    if (err instanceof InvariantFailure) return err;
    return new InvariantFailure(
      'exception',
      err instanceof Error ? (err.stack ?? err.message) : String(err),
    );
  }
  return null;
}

/**
 * Binary-search the shortest failing prefix (`hi` always fails, `lo` passes).
 * Failures need not be monotone in the prefix, so this finds *a* locally
 * minimal prefix, which is what a reproduction needs.
 */
async function shrink(
  seed: number,
  model: GraphModel,
  failing: InvariantFailure,
): Promise<{ n: number; failure: InvariantFailure }> {
  let lo = 0;
  let hi = model.ops.length;
  let failure = failing;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const f = await runPrefix(seed, model, mid);
    if (f === null) {
      lo = mid;
    } else {
      hi = mid;
      failure = f;
    }
  }
  return { n: hi, failure };
}

const { seeds, changesets } = fuzzSettings();

describe('commit-graph fuzzer (issue #22)', () => {
  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
  });

  for (const seed of seeds) {
    it(
      `seed ${seed}: ${changesets} changesets hold every graph invariant`,
      async () => {
        const model = generateOps(seed, changesets);
        const failure = await runPrefix(seed, model, changesets);
        if (failure !== null) {
          const min = await shrink(seed, model, failure);
          throw new Error(
            `fuzz invariant violated — seed ${seed}, minimal failing prefix ${min.n}/${changesets} ops\n` +
              `${min.failure.message}\n` +
              `reproduce: VITE_FUZZ_SEED=${seed} VITE_FUZZ_N=${min.n} npx vitest run test/fuzz\n` +
              `op log:\n${formatOps(model.ops.slice(0, min.n))}`,
          );
        }
        expect(failure).toBeNull();
      },
      // shrinking replays ~log2(N) prefixes on failure
      Math.max(120_000, changesets * 1_500),
    );
  }
});
