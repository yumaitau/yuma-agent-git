import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { cleanDb, makeViewerApp, seedSchema } from './helpers';
import type { TestEnv } from './helpers';
import { createRepo } from '../src/db/repos';
import { commitChanges } from '../src/core/commit';
import type { Changeset } from '../src/core/changesets';
import { PATH_HISTORY, pathHistoryAt } from '../src/core/derived/pathHistory';
import { derivedQueue } from '../src/queues/derived';
import type { DerivedMessage } from '../src/core/derived';

const testEnv = env as unknown as TestEnv;
const dbEnv = testEnv as unknown as Env;
const author = { name: 'Ada', email: 'ada@example.com' };
const b64 = (t: string): string => btoa(t);

async function get(path: string): Promise<Response> {
  return makeViewerApp(testEnv)(new Request(`http://x/api/v1/repos${path}`));
}

function mockBatch(bodies: Array<{ body: DerivedMessage; attempts: number }>): {
  batch: MessageBatch<DerivedMessage>;
  acked: number[];
} {
  const acked: number[] = [];
  const messages = bodies.map((entry, i) => ({
    ...entry,
    id: `m${i}`,
    timestamp: new Date(),
    ack: (): void => {
      acked.push(i);
    },
    retry: (): void => {},
  }));
  return {
    batch: {
      queue: 'derived-data',
      messages,
      ackAll: (): void => {},
      retryAll: (): void => {},
    } as unknown as MessageBatch<DerivedMessage>,
    acked,
  };
}

/**
 * 5 commits with overlapping paths (linear):
 *   c1: add a/b/x.txt + y.txt
 *   c2: mod a/b/x.txt
 *   c3: touch z.txt (unrelated)
 *   c4: add a/b/c.txt
 *   c5: mod y.txt
 */
async function seedOverlapping(slug: string): Promise<{
  repoId: string;
  cs: Changeset[];
}> {
  const repo = await createRepo(dbEnv, { slug, visibility: 'public' });
  const cs: Changeset[] = [];
  let parent: string | null = null;
  const steps = [
    [
      { path: 'a/b/x.txt', op: 'add' as const, content_b64: b64('x1\n') },
      { path: 'y.txt', op: 'add' as const, content_b64: b64('y1\n') },
    ],
    [{ path: 'a/b/x.txt', op: 'mod' as const, content_b64: b64('x2\n') }],
    [{ path: 'z.txt', op: 'add' as const, content_b64: b64('z\n') }],
    [{ path: 'a/b/c.txt', op: 'add' as const, content_b64: b64('c\n') }],
    [{ path: 'y.txt', op: 'mod' as const, content_b64: b64('y2\n') }],
  ];
  for (let i = 0; i < steps.length; i++) {
    const res = await commitChanges(dbEnv, repo.id, {
      first_parent: parent,
      message: `c${i + 1}`,
      author,
      changes: steps[i] as never,
    });
    cs.push(res.changeset);
    parent = res.changeset.id;
  }
  return { repoId: repo.id, cs };
}

describe('path_history', () => {
  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
  });

  it('history(path) is exact, newest first, with limit + resume cursor', async () => {
    const { repoId, cs } = await seedOverlapping('acme/paths');
    const [c1, c2, c3, c4, c5] = cs as [
      Changeset,
      Changeset,
      Changeset,
      Changeset,
      Changeset,
    ];
    void c3;

    // exact path
    const exact = await pathHistoryAt(dbEnv, repoId, c5.id, 'a/b/x.txt', 50);
    expect(exact.commits).toEqual([c2.id, c1.id]);

    // directory query unions everything under it, still newest first
    const dir = await pathHistoryAt(dbEnv, repoId, c5.id, 'a/b', 50);
    expect(dir.commits).toEqual([c4.id, c2.id, c1.id]);

    // limit + resume: nothing repeated, nothing skipped
    const page1 = await pathHistoryAt(dbEnv, repoId, c5.id, 'a/b', 2);
    expect(page1.commits).toEqual([c4.id, c2.id]);
    expect(page1.complete).toBe(false);
    const page2 = await pathHistoryAt(dbEnv, repoId, page1.next as string, 'a/b', 2);
    expect(page2.commits).toEqual([c1.id]);
    expect(page2.complete).toBe(true);

    // unrelated path
    const unrelated = await pathHistoryAt(dbEnv, repoId, c5.id, 'z.txt', 50);
    expect(unrelated.commits).toEqual([c3.id]);
  });

  it('walks payload chains across non-touching changesets', async () => {
    const { repoId, cs } = await seedOverlapping('acme/chains');
    const [c1, c2, , , c5] = cs as [
      Changeset,
      Changeset,
      Changeset,
      Changeset,
      Changeset,
    ];
    // c5 never touched a/b/x.txt — the walk must skip c5/c4/c3 gaps and still
    // find c2 → c1 through the payload chain
    const result = await pathHistoryAt(dbEnv, repoId, c5.id, 'a/b/x.txt', 50);
    expect(result.commits).toEqual([c2.id, c1.id]);
  });

  it('cold + background=1 answers 202 and the queue warms it', async () => {
    const { repoId, cs } = await seedOverlapping('acme/bg');
    const c5 = cs[4] as Changeset;

    const cold = await get(`/acme/bg/history?cs=${c5.id}&path=a/b/x.txt&background=1`);
    expect(cold.status).toBe(202);
    expect(((await cold.json()) as { status: string }).status).toBe('computing');

    const { batch, acked } = mockBatch([
      {
        body: { repo_id: repoId, kind: PATH_HISTORY, cs_id: c5.id },
        attempts: 1,
      },
    ]);
    await derivedQueue(batch, dbEnv);
    expect(acked).toEqual([0]);

    const warm = await get(`/acme/bg/history?cs=${c5.id}&path=a/b/x.txt`);
    expect(warm.status).toBe(200);
    const body = (await warm.json()) as {
      changesets: { id: string }[];
      complete: boolean;
    };
    expect(body.changesets.map((c) => c.id)).toEqual([
      (cs[1] as Changeset).id,
      (cs[0] as Changeset).id,
    ]);
    expect(body.complete).toBe(true);
    expect(warm.headers.get('x-yag-provisional')).toBeNull();
  });
});
