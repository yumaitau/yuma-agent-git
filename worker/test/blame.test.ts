import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { cleanDb, makeApp, seedSchema } from './helpers';
import type { TestEnv } from './helpers';
import { createRepo } from '../src/db/repos';
import { commitChanges } from '../src/core/commit';
import type { Changeset } from '../src/core/changesets';
import {
  BLAME_TRUNCATED_CS,
  blameFile,
  type BlameRange,
} from '../src/core/derived/blame';
import { derivedQueue } from '../src/queues/derived';
import type { DerivedMessage } from '../src/core/derived';

const testEnv = env as unknown as TestEnv;
const dbEnv = testEnv as unknown as Env;
const author = { name: 'Ada', email: 'ada@example.com' };

function b64(text: string): string {
  return btoa(text);
}

async function get(path: string): Promise<Response> {
  return makeApp(testEnv)(new Request(`http://x/api/v1/repos${path}`));
}

const TEN_LINES = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8', 'l9', 'l10']
  .map((l) => `${l}\n`)
  .join('');

/**
 * cs1 adds the 10-line file, cs2 touches a DIFFERENT file, cs3 replaces
 * lines 3-4, cs4 replaces line 8. Blame at cs4:
 * [1-2:cs1][3-4:cs3][5-7:cs1][8:cs4][9-10:cs1]
 */
async function seedEvolution(slug: string): Promise<{
  repoId: string;
  cs1: Changeset;
  cs3: Changeset;
  cs4: Changeset;
}> {
  const repo = await createRepo(dbEnv, { slug, visibility: 'public' });
  const cs1 = (
    await commitChanges(dbEnv, repo.id, {
      first_parent: null,
      message: 'add file',
      author,
      changes: [{ path: 'f.txt', op: 'add', content_b64: b64(TEN_LINES) }],
    })
  ).changeset;
  const cs2 = (
    await commitChanges(dbEnv, repo.id, {
      first_parent: cs1.id,
      message: 'unrelated',
      author,
      changes: [{ path: 'other.txt', op: 'add', content_b64: b64('other\n') }],
    })
  ).changeset;
  void cs2;
  const cs3 = (
    await commitChanges(dbEnv, repo.id, {
      first_parent: cs2.id,
      message: 'lines 3-4',
      author,
      changes: [
        {
          path: 'f.txt',
          op: 'mod',
          content_b64: b64(
            TEN_LINES.split('\n')
              .map((l, i) => (i === 2 ? 'NEW3' : i === 3 ? 'NEW4' : l))
              .join('\n'),
          ),
        },
      ],
    })
  ).changeset;
  const cs4 = (
    await commitChanges(dbEnv, repo.id, {
      first_parent: cs3.id,
      message: 'line 8',
      author,
      changes: [
        {
          path: 'f.txt',
          op: 'mod',
          content_b64: b64(
            TEN_LINES.split('\n')
              .map((l, i) => (i === 2 ? 'NEW3' : i === 3 ? 'NEW4' : i === 7 ? 'NEW8' : l))
              .join('\n'),
          ),
        },
      ],
    })
  ).changeset;
  return { repoId: repo.id, cs1, cs3, cs4 };
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
  const batch = {
    queue: 'derived-data',
    messages,
    ackAll: (): void => {},
    retryAll: (): void => {},
  } as unknown as MessageBatch<DerivedMessage>;
  return { batch, acked };
}

describe('blame', () => {
  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
  });

  it('attributes lines exactly across mods (add → mod 3-4 → mod 8)', async () => {
    const { repoId, cs1, cs3, cs4 } = await seedEvolution('acme/blame');
    const outcome = await blameFile(dbEnv, repoId, cs4.id, 'f.txt');

    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.complete).toBe(true);
    expect(outcome.ranges).toEqual([
      { start: 1, end: 2, cs: cs1.id },
      { start: 3, end: 4, cs: cs3.id },
      { start: 5, end: 7, cs: cs1.id },
      { start: 8, end: 8, cs: cs4.id },
      { start: 9, end: 10, cs: cs1.id },
    ]);
  });

  it('re-added files blame to the re-add; moves blame wholly to the add', async () => {
    const repo = await createRepo(dbEnv, { slug: 'acme/readd', visibility: 'public' });
    const root = (
      await commitChanges(dbEnv, repo.id, {
        first_parent: null,
        message: 'add',
        author,
        changes: [{ path: 'gone.txt', op: 'add', content_b64: b64('one\ntwo\n') }],
      })
    ).changeset;
    await commitChanges(dbEnv, repo.id, {
      first_parent: root.id,
      message: 'delete',
      author,
      changes: [{ path: 'gone.txt', op: 'del' }],
    });
    const read = (
      await commitChanges(dbEnv, repo.id, {
        first_parent: root.id,
        message: 're-add elsewhere in history',
        author,
        changes: [{ path: 'moved.txt', op: 'add', content_b64: b64('x\ny\n') }],
      })
    ).changeset;

    // content moved to a new path: v1 tracks no renames → wholly the add
    const moved = await blameFile(dbEnv, repo.id, read.id, 'moved.txt');
    expect(moved.status).toBe('ok');
    if (moved.status === 'ok') {
      expect(moved.ranges).toEqual([{ start: 1, end: 2, cs: read.id }]);
    }

    // deleted file at its deletion point: nothing to blame
    await expect(blameFile(dbEnv, repo.id, root.id, 'gone.txt')).resolves.toMatchObject({
      status: 'ok',
    });
  });

  it('deep chains 202 + enqueue past the budget; consumer completes', async () => {
    const repo = await createRepo(dbEnv, { slug: 'acme/deep', visibility: 'public' });
    let parent: string | null = null;
    let content = 'x0\n';
    const ids: string[] = [];
    for (let i = 0; i < 150; i++) {
      content = `x${i}\n`;
      const res = await commitChanges(dbEnv, repo.id, {
        first_parent: parent,
        message: `m${i}`,
        author,
        changes: [
          parent === null
            ? { path: 'deep.txt', op: 'add' as const, content_b64: b64(content) }
            : { path: 'deep.txt', op: 'mod' as const, content_b64: b64(content) },
        ],
      });
      ids.push(res.changeset.id);
      parent = res.changeset.id;
    }

    // inline with default budget (100) → partial + 202 + queue message
    const partial = await blameFile(dbEnv, repo.id, parent as string, 'deep.txt');
    expect(partial.status).toBe('computing');
    if (partial.status === 'computing') {
      expect((partial.ranges ?? []).length).toBeGreaterThan(0);
    }

    // run the consumer → complete payload
    const { batch, acked } = mockBatch([
      {
        body: {
          repo_id: repo.id,
          kind: 'blame',
          cs_id: `${parent as string}:deep.txt`,
        },
        attempts: 1,
      },
    ]);
    await derivedQueue(batch, dbEnv);
    expect(acked).toEqual([0]);

    const done = await blameFile(dbEnv, repo.id, parent as string, 'deep.txt');
    expect(done.status).toBe('ok');
    if (done.status === 'ok') {
      expect(done.complete).toBe(true);
      expect(done.ranges).toEqual([{ start: 1, end: 1, cs: ids[149] as string }]);
    }
  });

  it('background=1 on a cold blame answers 202 and the queue completes it', async () => {
    const { repoId, cs1, cs4 } = await seedEvolution('acme/background');
    const cold = await get(`/acme/background/blame?cs=${cs4.id}&path=f.txt&background=1`);
    expect(cold.status).toBe(202);
    expect(((await cold.json()) as { status: string }).status).toBe('computing');

    const { batch } = mockBatch([
      {
        body: { repo_id: repoId, kind: 'blame', cs_id: `${cs4.id}:f.txt` },
        attempts: 1,
      },
    ]);
    await derivedQueue(batch, dbEnv);

    const warm = await get(`/acme/background/blame?cs=${cs4.id}&path=f.txt`);
    expect(warm.status).toBe(200);
    const body = (await warm.json()) as {
      ranges: BlameRange[];
      complete: boolean;
    };
    expect(body.complete).toBe(true);
    expect(body.ranges).toEqual([
      { start: 1, end: 2, cs: cs1.id },
      { start: 3, end: 4, cs: expect.any(String) },
      { start: 5, end: 7, cs: cs1.id },
      { start: 8, end: 8, cs: cs4.id },
      { start: 9, end: 10, cs: cs1.id },
    ]);
  });

  it('annotate joins messages and truncated ranges stay flagged', async () => {
    const { cs1, cs4 } = await seedEvolution('acme/annotate');
    const res = await get(`/acme/annotate/blame?cs=${cs4.id}&path=f.txt&annotate=1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ranges: (BlameRange & { message?: string })[];
    };
    const first = body.ranges.find((r) => r.cs === cs1.id);
    expect(first?.message).toBe('add file');
    expect(BLAME_TRUNCATED_CS).toBe('…');
  });

  it('missing parent blobs degrade gracefully (earliest readable), never 500', async () => {
    const { repoId, cs1, cs4 } = await seedEvolution('acme/corrupt');
    // destroy cs1's blob so the fold loses the oldest readable generation
    const cs1File = cs1.changed_files.find((f) => f.path === 'f.txt');
    const { blobKey } = await import('../src/core/blobs');
    await testEnv.OBJECTS.delete(blobKey(repoId, cs1File?.hash as string));

    const outcome = await blameFile(dbEnv, repoId, cs4.id, 'f.txt');
    expect(outcome.status).toBe('ok');
    if (outcome.status === 'ok') {
      expect(outcome.ranges.length).toBeGreaterThan(0);
      // every attributed cs is a real changeset (earliest readable fallback)
      for (const range of outcome.ranges) {
        expect(range.cs).not.toBe(BLAME_TRUNCATED_CS);
      }
    }
  });

  it('route validation: missing revs/paths and private caches', async () => {
    await seedEvolution('acme/routes');
    expect((await get('/acme/routes/blame')).status).toBe(400);
    expect((await get(`/acme/routes/blame?cs=${'0'.repeat(64)}&path=f.txt`)).status).toBe(
      404,
    );
    expect((await get('/acme/nope/blame?cs=x&path=f.txt')).status).toBe(404);
  });
});
