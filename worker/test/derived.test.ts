import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { cleanDb, seedSchema } from './helpers';
import type { TestEnv } from './helpers';
import { q, run } from '../src/db/client';
import { C, T } from '../src/db/schema';
import { createRepo } from '../src/db/repos';
import { commitChanges } from '../src/core/commit';
import {
  CHANGED_PATHS,
  OVERSIZE_SENTINEL,
  SKIP_LIST,
  collapsePaths,
  collapsePrefix,
  getDerived,
  registerKind,
  type ChangedPaths,
  type DerivedKind,
  type SkipListEntry,
} from '../src/core/derived';
import { derivedQueue } from '../src/queues/derived';
import { GIT_IDS } from '../src/core/derived/gitIds';
import { CODE_SEARCH } from '../src/core/derived/codeSearch';
import type { DerivedMessage } from '../src/core/derived';

const testEnv = env as unknown as TestEnv;
const dbEnv = testEnv as unknown as Env;
const author = { name: 'Ada', email: 'ada@example.com' };
const b64 = (t: string): string => btoa(t);

interface CountPayload {
  count: number;
}

/** Recursive test kind: value = first parent's value + 1. */
const countKind: DerivedKind<CountPayload> = {
  name: 'test_count',
  eager: false,
  async compute(_env, _repoId, _cs, ctx) {
    const parentPayloads = Object.values(ctx.parents);
    const parentCount =
      parentPayloads.length > 0
        ? ((parentPayloads[0]?.['test_count'] as CountPayload | undefined)?.count ?? 0)
        : 0;
    return { count: parentCount + 1 };
  },
  parse(payload) {
    return JSON.parse(payload) as CountPayload;
  },
};
registerKind(countKind);

interface TinyPayload {
  text: string;
}
const tinyKind: DerivedKind<TinyPayload> = {
  name: 'test_tiny',
  eager: false,
  maxPayloadBytes: 16,
  async compute() {
    return { text: 'x'.repeat(200) };
  },
  parse(payload) {
    return JSON.parse(payload) as TinyPayload;
  },
};
registerKind(tinyKind);

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

function mockBatch(bodies: Array<{ body: DerivedMessage; attempts: number }>): {
  batch: MessageBatch<DerivedMessage>;
  acked: number[];
  retried: number[];
  state: { retryAll: boolean };
} {
  const acked: number[] = [];
  const retried: number[] = [];
  const state = { retryAll: false };
  const messages = bodies.map((entry, i) => ({
    ...entry,
    id: `m${i}`,
    timestamp: new Date(),
    ack: (): void => {
      acked.push(i);
    },
    retry: (): void => {
      retried.push(i);
    },
  }));
  const batch = {
    queue: 'derived-data',
    messages,
    ackAll: (): void => {
      acked.push(-1);
    },
    retryAll: (): void => {
      state.retryAll = true;
    },
  } as unknown as MessageBatch<DerivedMessage>;
  return { batch, acked, retried, state };
}

describe('derived-data framework', () => {
  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
  });

  it('recursive kinds compute from parent values and self-heal', async () => {
    const repo = await createRepo(dbEnv, {
      slug: 'acme/recursion',
      visibility: 'public',
    });
    const ids = await chain(repo.id, 5);

    const tip = await getDerived<CountPayload>(
      dbEnv,
      repo.id,
      'test_count',
      ids[4] as string,
    );
    expect(tip?.count).toBe(5); // root = 1, +1 per generation

    // self-healing: wipe rows, recompute from scratch on demand
    await run(dbEnv, `DELETE FROM ${T.derivedData} WHERE ${C.derivedData.kind} = ?`, [
      'test_count',
    ]);
    expect(
      await q(dbEnv, `SELECT * FROM ${T.derivedData} WHERE kind = 'test_count'`),
    ).toHaveLength(0);
    const healed = await getDerived<CountPayload>(
      dbEnv,
      repo.id,
      'test_count',
      ids[4] as string,
    );
    expect(healed?.count).toBe(5);
  });

  it('eager kinds are written by the commit hook in one batch', async () => {
    const repo = await createRepo(dbEnv, { slug: 'acme/eager', visibility: 'public' });
    const root = await commitChanges(dbEnv, repo.id, {
      first_parent: null,
      message: 'root',
      author,
      changes: [
        { path: 'a/b.txt', op: 'add', content_b64: b64('1') },
        { path: 'a/b/c.txt', op: 'add', content_b64: b64('2') },
        { path: 'x.txt', op: 'add', content_b64: b64('3') },
      ],
    });
    // (a/b.txt and a/b/c.txt are siblings — `b.txt` vs dir `b` — not nested)

    const skip = await getDerived<SkipListEntry>(
      dbEnv,
      repo.id,
      SKIP_LIST,
      root.changeset.id,
    );
    expect(skip).toEqual({ depth: 0, levels: 0, pointers: [] });

    const changed = await getDerived<ChangedPaths>(
      dbEnv,
      repo.id,
      CHANGED_PATHS,
      root.changeset.id,
    );
    // no prefix relation among these three leaves — all survive
    expect(changed?.paths).toEqual(['a/b.txt', 'a/b/c.txt', 'x.txt']);

    // both rows landed (computeEager writes them in a single D1 batch)
    const rows = await q(
      dbEnv,
      `SELECT ${C.derivedData.kind} AS kind FROM ${T.derivedData} WHERE ${C.derivedData.csId} = ?`,
      [root.changeset.id],
    );
    // (+ git_ids and code_search, which the commit hook computes for small
    // changes, issues #30 and #45)
    expect(rows.map((r) => (r as { kind: string }).kind).sort()).toEqual([
      CHANGED_PATHS,
      CODE_SEARCH,
      GIT_IDS,
      SKIP_LIST,
    ]);
  });

  it('changed_paths unions parent payloads with prefix collapse', () => {
    expect(collapsePrefix(['a/b', 'a/b/c', 'x'])).toEqual(['a/b', 'x']);
    expect(collapsePaths(['a/b', 'a/b/c', 'x']).paths).toEqual(['a/b', 'x']);

    // 60k synthetic paths: collapse toward dirs, never exceed the cap
    const many: string[] = [];
    for (let i = 0; i < 60_000; i++) {
      many.push(`d${Math.floor(i / 10)}/f${i}.txt`);
    }
    const capped = collapsePaths(many);
    expect(capped.oversize).toBe(true);
    expect(capped.paths.length).toBeLessThanOrEqual(50_000);
    // collapsed to directory level, not arbitrary truncation
    expect(capped.paths.every((p) => !p.includes('/') || !p.endsWith('.txt'))).toBe(true);
  });

  it('queue consumer writes rows; poison messages are terminally acked', async () => {
    const repo = await createRepo(dbEnv, { slug: 'acme/queue', visibility: 'public' });
    const ids = await chain(repo.id, 2);

    // happy path: message for a deferred kind computes + stores the row
    const { batch, acked, state } = mockBatch([
      {
        body: { repo_id: repo.id, kind: 'test_count', cs_id: ids[1] as string },
        attempts: 1,
      },
    ]);
    await derivedQueue(batch, dbEnv);
    expect(acked).toEqual([0]);
    expect(state.retryAll).toBe(false);
    expect(
      await getDerived<CountPayload>(dbEnv, repo.id, 'test_count', ids[1] as string),
    ).toEqual({
      count: 2,
    });

    // poison: unknown kind is a permanent failure → {failed:true} + ack
    const poison = mockBatch([
      {
        body: { repo_id: repo.id, kind: 'no_such_kind', cs_id: ids[0] as string },
        attempts: 1,
      },
    ]);
    await derivedQueue(poison.batch, dbEnv);
    expect(poison.acked).toEqual([0]);
    const failedRow = await q1Payload(repo.id, 'no_such_kind', ids[0] as string);
    expect(JSON.parse(failedRow ?? 'null')).toEqual({ failed: true });

    // transient exhaustion: attempts >= 3 is treated as poison too
    const exhausted = mockBatch([
      {
        body: { repo_id: repo.id, kind: 'test_count', cs_id: 'does-not-exist' },
        attempts: 3,
      },
    ]);
    await derivedQueue(exhausted.batch, dbEnv);
    expect(exhausted.acked).toEqual([0]);

    // genuinely transient (attempts < 3) retries the batch instead of acking
    // (fresh target — the previous case's {failed:true} row is a terminal answer)
    const transient = mockBatch([
      {
        body: { repo_id: repo.id, kind: 'test_count', cs_id: 'not-visible-yet' },
        attempts: 1,
      },
    ]);
    await derivedQueue(transient.batch, dbEnv);
    expect(transient.acked).toEqual([]);
    expect(transient.state.retryAll).toBe(true);
  });

  it('payload guard stores the oversize sentinel for huge payloads', async () => {
    const repo = await createRepo(dbEnv, { slug: 'acme/oversize', visibility: 'public' });
    const ids = await chain(repo.id, 1);
    await getDerived<TinyPayload>(dbEnv, repo.id, 'test_tiny', ids[0] as string);

    const row = await q1Payload(repo.id, 'test_tiny', ids[0] as string);
    expect(JSON.parse(row ?? 'null')).toEqual(OVERSIZE_SENTINEL);
  });

  it('concurrent cache-aside misses settle on a single row', async () => {
    const repo = await createRepo(dbEnv, {
      slug: 'acme/concurrent',
      visibility: 'public',
    });
    const ids = await chain(repo.id, 2);
    const target = ids[1] as string;
    await run(dbEnv, `DELETE FROM ${T.derivedData} WHERE ${C.derivedData.kind} = ?`, [
      'test_count',
    ]);

    const [a, b] = await Promise.all([
      getDerived<CountPayload>(dbEnv, repo.id, 'test_count', target),
      getDerived<CountPayload>(dbEnv, repo.id, 'test_count', target),
    ]);
    expect(a?.count).toBe(2);
    expect(b?.count).toBe(2);
    const rows = await q(
      dbEnv,
      `SELECT * FROM ${T.derivedData} WHERE ${C.derivedData.kind} = ? AND ${C.derivedData.csId} = ?`,
      ['test_count', target],
    );
    expect(rows).toHaveLength(1);
  });
});

async function q1Payload(
  repoId: string,
  kind: string,
  csId: string,
): Promise<string | null> {
  const rows = await q(
    dbEnv,
    `SELECT ${C.derivedData.payload} AS payload FROM ${T.derivedData}
      WHERE ${C.derivedData.repoId} = ? AND ${C.derivedData.kind} = ? AND ${C.derivedData.csId} = ?`,
    [repoId, kind, csId],
  );
  return rows.length > 0 ? String((rows[0] as { payload: string }).payload) : null;
}
