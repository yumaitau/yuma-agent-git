import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { cleanDb, instrumentDb, makeApp, seedSchema } from './helpers';
import type { TestEnv } from './helpers';
import { C, T } from '../src/db/schema';
import { q, run } from '../src/db/client';
import { createRepo, setRef } from '../src/db/repos';
import { commitChanges } from '../src/core/commit';
import { getChangeset } from '../src/core/changesets';
import {
  ancestorDistance,
  computeSkipList,
  getSkipListEntry,
  isAncestor,
  isAncestorDag,
  mergeBase,
  skipListPayloadHash,
} from '../src/core/ancestry';

const testEnv = env as unknown as TestEnv;
const dbEnv = testEnv as unknown as Env;
const author = { name: 'Ada', email: 'ada@example.com' };

const b64 = (t: string): string => btoa(t);

async function get(path: string): Promise<Response> {
  return makeApp(testEnv)(new Request(`http://x/api/v1/repos${path}`));
}

/** Linear chain of `count` changesets (root + count-1 children) via the core API. */
async function chain(repoId: string, count: number): Promise<string[]> {
  const ids: string[] = [];
  let parent: string | null = null;
  for (let i = 0; i < count; i++) {
    const res = await commitChanges(dbEnv, repoId, {
      first_parent: parent,
      message: `cs${i}`,
      author,
      changes: [{ path: `f${i}.txt`, op: 'add', content_b64: b64(`c${i}`) }],
    });
    ids.push(res.changeset.id);
    parent = res.changeset.id;
  }
  return ids;
}

describe('skip-list ancestry', () => {
  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
  });

  it('linear chain: isAncestor pairs, exact distances, merge-base = min(i,j)', async () => {
    const repo = await createRepo(dbEnv, { slug: 'acme/linear', visibility: 'public' });
    const ids = await chain(repo.id, 100);

    for (const [a, b] of [
      [0, 99],
      [7, 8],
      [50, 50],
      [3, 60],
    ] as const) {
      expect(await isAncestor(dbEnv, repo.id, ids[a] as string, ids[b] as string)).toBe(
        a <= b,
      );
      expect(
        await ancestorDistance(dbEnv, repo.id, ids[a] as string, ids[b] as string),
      ).toBe(a <= b ? b - a : null);
    }
    for (const [a, b] of [
      [10, 20],
      [20, 10],
      [0, 99],
      [42, 42],
    ] as const) {
      expect(await mergeBase(dbEnv, repo.id, ids[a] as string, ids[b] as string)).toBe(
        ids[Math.min(a, b)],
      );
    }
    // non-ancestors on the chain point backwards
    expect(await isAncestor(dbEnv, repo.id, ids[90] as string, ids[10] as string)).toBe(
      false,
    );
  });

  it('branching DAG: merge-base at the fork, cross-branch isAncestor false', async () => {
    const repo = await createRepo(dbEnv, { slug: 'acme/dag', visibility: 'public' });
    const ids = await chain(repo.id, 51); // cs0..cs50
    const fork = ids[50] as string;

    let aParent = fork;
    const aIds: string[] = [];
    for (let i = 0; i < 20; i++) {
      const res = await commitChanges(dbEnv, repo.id, {
        first_parent: aParent,
        message: `a${i}`,
        author,
        changes: [{ path: `a${i}.txt`, op: 'add', content_b64: b64(`a${i}`) }],
      });
      aIds.push(res.changeset.id);
      aParent = res.changeset.id;
    }
    let bParent = fork;
    const bIds: string[] = [];
    for (let i = 0; i < 20; i++) {
      const res = await commitChanges(dbEnv, repo.id, {
        first_parent: bParent,
        message: `b${i}`,
        author,
        changes: [{ path: `b${i}.txt`, op: 'add', content_b64: b64(`b${i}`) }],
      });
      bIds.push(res.changeset.id);
      bParent = res.changeset.id;
    }

    expect(await mergeBase(dbEnv, repo.id, aIds[19] as string, bIds[19] as string)).toBe(
      fork,
    );
    expect(await isAncestor(dbEnv, repo.id, fork, aIds[5] as string)).toBe(true);
    expect(await isAncestor(dbEnv, repo.id, bIds[5] as string, aIds[5] as string)).toBe(
      false,
    );
    expect(await isAncestor(dbEnv, repo.id, aIds[0] as string, bIds[19] as string)).toBe(
      false,
    );
  });

  it('deep chain: O(log n) — merge-base stays ≤ 40 D1 reads on 1000 changesets', async () => {
    const repo = await createRepo(dbEnv, { slug: 'acme/deep', visibility: 'public' });

    // bulk-seed 1000 changeset rows with direct D1 inserts (no HTTP)
    const mkRow = (i: number): unknown[] => [
      `cs${String(i).padStart(4, '0')}`,
      repo.id,
      i === 0 ? null : `cs${String(i - 1).padStart(4, '0')}`,
      JSON.stringify(i === 0 ? [] : [`cs${String(i - 1).padStart(4, '0')}`]),
      JSON.stringify(author),
      `m${i}`,
      1_700_000_000_000 + i,
      JSON.stringify([]),
      null,
    ];
    for (let batch = 0; batch < 10; batch++) {
      const stmts = [];
      for (let j = 0; j < 100; j++) {
        const i = batch * 100 + j;
        stmts.push(
          testEnv.DB.prepare(
            `INSERT INTO ${T.changesets} (${C.changesets.id}, ${C.changesets.repoId}, ${C.changesets.firstParent}, ${C.changesets.parents}, ${C.changesets.author}, ${C.changesets.message}, ${C.changesets.createdAt}, ${C.changesets.changedFiles}, ${C.changesets.rootTree}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(...(mkRow(i) as unknown[])),
        );
      }
      await testEnv.DB.batch(stmts);
    }

    // one deep compute: walks the whole spine once, then stores every entry
    const tip = await getChangeset(dbEnv, repo.id, 'cs0999');
    const entry = await computeSkipList(dbEnv, repo.id, tip as NonNullable<typeof tip>);
    expect(entry.depth).toBe(999);
    expect(entry.levels).toBe(10); // floor(log2(999)) + 1

    // measure the QUERY cost with fresh instrumentation
    const probe = instrumentDb(testEnv);
    const base = await mergeBase(probe.env, repo.id, 'cs0500', 'cs0900');
    const anc = await isAncestor(probe.env, repo.id, 'cs0100', 'cs0999');
    const notAnc = await isAncestor(probe.env, repo.id, 'cs0900', 'cs0500');
    const dist = await ancestorDistance(probe.env, repo.id, 'cs0500', 'cs0900');
    expect(base).toBe('cs0500');
    expect(anc).toBe(true);
    expect(notAnc).toBe(false);
    expect(dist).toBe(400);
    expect(probe.prepares.length).toBeLessThanOrEqual(40);
  });

  it('computes entries lazily when rows were seeded without derived data', async () => {
    const repo = await createRepo(dbEnv, { slug: 'acme/lazy', visibility: 'public' });
    const ids = await chain(repo.id, 6);
    // wipe derived data to simulate pre-framework rows
    await run(dbEnv, `DELETE FROM ${T.derivedData}`);
    expect(await q(dbEnv, `SELECT * FROM ${T.derivedData}`)).toHaveLength(0);
    // queries self-heal: entries are computed and stored on demand
    expect(await isAncestor(dbEnv, repo.id, ids[1] as string, ids[5] as string)).toBe(
      true,
    );
    expect(await mergeBase(dbEnv, repo.id, ids[2] as string, ids[4] as string)).toBe(
      ids[2],
    );
    expect((await q(dbEnv, `SELECT * FROM ${T.derivedData}`)).length).toBeGreaterThan(0);
  });

  it('is deterministic: recomputation yields identical payloads', async () => {
    const repo = await createRepo(dbEnv, {
      slug: 'acme/determinism',
      visibility: 'public',
    });
    const ids = await chain(repo.id, 5);
    const cs4 = await getChangeset(dbEnv, repo.id, ids[4] as string);
    const before = await getSkipListEntry(dbEnv, repo.id, ids[4] as string);
    const hashBefore = await skipListPayloadHash(before as NonNullable<typeof before>);
    await run(dbEnv, `DELETE FROM ${T.derivedData}`);
    const after = await computeSkipList(dbEnv, repo.id, cs4 as NonNullable<typeof cs4>);
    expect(await skipListPayloadHash(after)).toBe(hashBefore);
  });

  it('isAncestorDag covers merge second-parents that the spine cannot', async () => {
    const repo = await createRepo(dbEnv, { slug: 'acme/mergeff', visibility: 'public' });
    const ids = await chain(repo.id, 1);
    const root = ids[0] as string;
    const a = (
      await commitChanges(dbEnv, repo.id, {
        first_parent: root,
        message: 'a',
        author,
        changes: [{ path: 'a.txt', op: 'add', content_b64: b64('a') }],
      })
    ).changeset;
    const b = (
      await commitChanges(dbEnv, repo.id, {
        first_parent: root,
        message: 'b',
        author,
        changes: [{ path: 'b.txt', op: 'add', content_b64: b64('b') }],
      })
    ).changeset;
    const merge = await commitChanges(dbEnv, repo.id, {
      first_parent: a.id,
      parents: [b.id],
      message: 'merge',
      author,
      changes: [],
    });
    // spine semantics (Scion footnote 1): the merge's spine is root→a→merge
    expect(await isAncestor(dbEnv, repo.id, b.id, merge.changeset.id)).toBe(false);
    // …but it IS a descendant over all parents (fast-forward semantics)
    expect(await isAncestorDag(dbEnv, repo.id, b.id, merge.changeset.id)).toBe(true);
    expect(await isAncestorDag(dbEnv, repo.id, root, merge.changeset.id)).toBe(true);
  });
});

describe('ancestry routes', () => {
  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
  });

  it('serves merge-base / is-ancestor with real (non-provisional) answers', async () => {
    const repo = await createRepo(dbEnv, { slug: 'acme/routes', visibility: 'public' });
    const ids = await chain(repo.id, 3);
    await setRef(dbEnv, repo.id, 'main', ids[2] as string);

    const mb = await get(`/acme/routes/merge-base?a=${ids[0]}&b=${ids[2]}`);
    expect(mb.status).toBe(200);
    expect(mb.headers.get('x-yag-provisional')).toBeNull();
    // both revs content-addressed + public → immutable
    expect(mb.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await mb.json()).toEqual({ merge_base: ids[0], provisional: false });

    const is = await get(`/acme/routes/is-ancestor?a=${ids[0]}&b=ref:main`);
    expect(is.status).toBe(200);
    // ref-addressed rev → mutable URL → short TTL
    expect(is.headers.get('cache-control')).toBe('public, max-age=10');
    expect(await is.json()).toEqual({ is_ancestor: true });

    const distance = await get(`/acme/routes/ancestor-distance?a=${ids[0]}&b=${ids[2]}`);
    expect(await distance.json()).toEqual({ distance: 2 });
  });

  it('validates params and revisions', async () => {
    const repo = await createRepo(dbEnv, { slug: 'acme/bad', visibility: 'public' });
    const ids = await chain(repo.id, 1);

    expect((await get('/acme/bad/merge-base')).status).toBe(400);
    expect(
      (await get(`/acme/bad/merge-base?a=${ids[0]}&b=${'0'.repeat(64)}`)).status,
    ).toBe(404);
    expect((await get('/acme/nope/is-ancestor?a=x&b=y')).status).toBe(404);
  });
});
