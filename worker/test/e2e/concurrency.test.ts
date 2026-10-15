import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../../src/env';
import { cleanDb, loginAs, makeApp, seedSchema } from '../helpers';
import type { TestEnv } from '../helpers';
import { C, T } from '../../src/db/schema';
import { q } from '../../src/db/client';
import { createRepo } from '../../src/db/repos';
import { isAncestorDag } from '../../src/core/ancestry';

/**
 * Concurrent writers (issue #22): N clients commit off the same head and race
 * the ref CAS over HTTP. Every move either lands (200) or loses with
 * `ref_stale` (409); losers merge their changeset onto the new head and retry
 * until everyone lands. Nothing may be lost — every writer's original
 * changeset ends up reachable from main and the shared file holds every line.
 */

const testEnv = env as unknown as TestEnv;
const dbEnv = testEnv as unknown as Env;
const SLUG = 'acme/race';
const WRITERS = 10;
const author = { name: 'Ada', email: 'ada@example.com' };

let auth: Awaited<ReturnType<typeof loginAs>>;

async function api(method: string, path: string, body?: unknown): Promise<Response> {
  return makeApp(testEnv)(
    new Request(`https://x/api/v1/repos/${SLUG}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...auth.headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

async function json<B>(res: Response, expected: number): Promise<B> {
  const text = await res.text();
  expect(res.status, text).toBe(expected);
  return JSON.parse(text) as B;
}

async function readHead(): Promise<string> {
  const body = await json<{ head: string }>(await api('GET', '/refs/main'), 200);
  return body.head;
}

async function readShared(cs: string): Promise<string> {
  const body = await json<{ content_b64: string }>(
    await api('GET', `/file?cs=${cs}&path=shared.txt`),
    200,
  );
  return atob(body.content_b64);
}

async function commit(input: {
  first_parent: string | null;
  parents?: string[];
  message: string;
  changes: unknown[];
}): Promise<string> {
  const res = await api('POST', '/changesets', { ...input, author });
  return (await json<{ changeset: { id: string } }>(res, 201)).changeset.id;
}

describe('concurrent writers converge through ref CAS', () => {
  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
    auth = await loginAs(testEnv, 1, 'ada');
  });

  it(`${WRITERS} racing writers: CAS lands or 409s; merge-and-retry loses nothing`, async () => {
    const repo = await createRepo(dbEnv, {
      slug: SLUG,
      visibility: 'private',
      createdBy: auth.userId,
    });
    const root = await commit({
      first_parent: null,
      message: 'root',
      changes: [{ path: 'shared.txt', op: 'add', content_b64: btoa('base\n') }],
    });
    await json(await api('PUT', '/refs/main', { from: null, to: root }), 200);

    const line = (w: number): string => `writer ${w}\n`;
    const own = (w: number) => ({
      path: `writers/w${w}.txt`,
      op: 'add',
      content_b64: btoa(`w${w}`),
    });

    // round 0: every writer commits off the same head (distinct file + the
    // shared file), then all race the CAS at once
    const originals = await Promise.all(
      Array.from({ length: WRITERS }, (_, w) =>
        commit({
          first_parent: root,
          message: `writer ${w}`,
          changes: [
            own(w),
            { path: 'shared.txt', op: 'mod', content_b64: btoa(`base\n${line(w)}`) },
          ],
        }),
      ),
    );
    expect(new Set(originals).size).toBe(WRITERS);

    const outcomes: { status: number; code?: string }[] = [];
    let roundOneWins = 0;

    const writer = async (w: number): Promise<number> => {
      let from = root;
      let to = originals[w] as string;
      for (let attempt = 1; attempt <= WRITERS * 2; attempt++) {
        const res = await api('PUT', '/refs/main', { from, to });
        const body = (await res.json()) as { error?: { code: string; actual: string } };
        outcomes.push({ status: res.status, code: body.error?.code });
        if (res.status === 200) {
          if (attempt === 1) roundOneWins++;
          return attempt;
        }
        // lost the race: merge our original changeset onto the new head
        // (first parent = landed head keeps main's first-parent chain linear;
        // the second parent keeps the writer's changeset in history)
        const head = body.error?.actual as string;
        const shared = await readShared(head);
        to = await commit({
          first_parent: head,
          parents: [originals[w] as string],
          message: `merge writer ${w} onto ${head.slice(0, 8)}`,
          changes: [
            own(w),
            { path: 'shared.txt', op: 'mod', content_b64: btoa(shared + line(w)) },
          ],
        });
        from = head;
      }
      throw new Error(`writer ${w} never landed`);
    };

    const attempts = await Promise.all(
      Array.from({ length: WRITERS }, (_, w) => writer(w)),
    );

    // every CAS either landed or lost with ref_stale — no other failure mode
    for (const outcome of outcomes) {
      expect(
        outcome.status === 200 ||
          (outcome.status === 409 && outcome.code === 'ref_stale'),
        JSON.stringify(outcome),
      ).toBe(true);
    }
    expect(outcomes.filter((o) => o.status === 200)).toHaveLength(WRITERS);
    expect(roundOneWins).toBe(1); // exactly one writer wins the first race
    expect(Math.max(...attempts)).toBeGreaterThan(1);

    // nothing lost: every original changeset is reachable from main…
    const head = await readHead();
    for (const cs of originals) {
      expect(await isAncestorDag(dbEnv, repo.id, cs, head)).toBe(true);
    }
    // …the shared file carries every writer's line exactly once…
    const shared = await readShared(head);
    const lines = shared.trim().split('\n');
    expect(lines[0]).toBe('base');
    expect(lines.slice(1).sort()).toEqual(
      Array.from({ length: WRITERS }, (_, w) => line(w).trim()).sort(),
    );
    // …and every distinct file is in the final tree
    const tree = await json<{ entries: { name: string }[] }>(
      await api('GET', `/tree?cs=${head}&path=writers`),
      200,
    );
    expect(tree.entries.map((e) => e.name).sort()).toEqual(
      Array.from({ length: WRITERS }, (_, w) => `w${w}.txt`).sort(),
    );

    // main's first-parent chain is linear: root + one landing per writer
    const history = await json<{ changesets: { id: string }[] }>(
      await api('GET', `/history?cs=${head}&limit=100`),
      200,
    );
    expect(history.changesets).toHaveLength(WRITERS + 1);
    expect(history.changesets.at(-1)?.id).toBe(root);

    // D1: root + originals + one merge per lost race; refs untouched elsewhere
    const rows = await q(
      dbEnv,
      `SELECT ${C.changesets.id} FROM ${T.changesets} WHERE ${C.changesets.repoId} = ?`,
      [repo.id],
    );
    const losses = outcomes.filter((o) => o.status === 409).length;
    expect(rows).toHaveLength(1 + WRITERS + losses);
    const refs = await q(dbEnv, `SELECT * FROM ${T.refs} WHERE repo_id = ?`, [repo.id]);
    expect(refs).toHaveLength(1);
  });
});
