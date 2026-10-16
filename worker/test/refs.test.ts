import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { cleanDb, loginAs, makeApp, seedSchema } from './helpers';
import type { TestEnv } from './helpers';
import { createRepo, getRef, setRef } from '../src/db/repos';
import { commitChanges } from '../src/core/commit';
import type { Changeset } from '../src/core/changesets';
import {
  moveRefViaDO,
  readRefHead,
  validateBranchName,
  validateRefName,
} from '../src/core/refs';
import { ConflictError, RequestValidationError } from '../src/core/errors';

const testEnv = env as unknown as TestEnv;
const dbEnv = testEnv as unknown as Env;
const author = { name: 'Ada', email: 'ada@example.com' };
let auth: Awaited<ReturnType<typeof loginAs>>;

function b64(text: string): string {
  return btoa(text);
}

/** Linear chain of `count + 1` changesets (root + children). */
async function makeChain(repoId: string, count: number): Promise<Changeset[]> {
  const out: Changeset[] = [];
  let parent: string | null = null;
  for (let i = 0; i <= count; i++) {
    const res = await commitChanges(dbEnv, repoId, {
      first_parent: parent,
      message: `cs${i}`,
      author,
      changes: [{ path: `f${i}.txt`, op: 'add', content_b64: b64(`content ${i}`) }],
    });
    out.push(res.changeset);
    parent = res.changeset.id;
  }
  return out;
}

function app() {
  return makeApp(testEnv);
}

async function putRef(slug: string, name: string, body: unknown): Promise<Response> {
  return app()(
    new Request(`http://x/api/v1/repos/${slug}/refs/${name}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...auth.headers },
      body: JSON.stringify(body),
    }),
  );
}

async function getRefRoute(slug: string, name?: string): Promise<Response> {
  return app()(
    new Request(`http://x/api/v1/repos/${slug}/refs${name ? `/${name}` : ''}`),
  );
}

describe('ref compare-and-swap (RefLockDO)', () => {
  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
  });

  it('CAS success: creates the ref (from: null) then moves with the correct from', async () => {
    const repo = await createRepo(dbEnv, { slug: 'acme/cas', visibility: 'public' });
    const [cs0, cs1] = await makeChain(repo.id, 1);

    const created = await moveRefViaDO(dbEnv, repo.id, 'main', {
      from: null,
      to: cs0?.id as string,
    });
    expect(created).toEqual({ ok: true, from: null, to: cs0?.id });
    expect(await readRefHead(dbEnv, repo.id, 'main')).toBe(cs0?.id);

    const moved = await moveRefViaDO(dbEnv, repo.id, 'main', {
      from: cs0?.id as string,
      to: cs1?.id as string,
    });
    expect(moved).toEqual({ ok: true, from: cs0?.id, to: cs1?.id });
    expect((await getRef(dbEnv, repo.id, 'main'))?.head).toBe(cs1?.id);
  });

  it('CAS failure: concurrent-style stale moves lose with expected/actual', async () => {
    const repo = await createRepo(dbEnv, { slug: 'acme/stale', visibility: 'public' });
    const chain = await makeChain(repo.id, 5);
    const root = chain[0] as Changeset;
    await moveRefViaDO(dbEnv, repo.id, 'main', { from: null, to: root.id });

    const results = await Promise.allSettled(
      chain
        .slice(1)
        .map((cs) => moveRefViaDO(dbEnv, repo.id, 'main', { from: root.id, to: cs.id })),
    );
    const wins = results.filter((r) => r.status === 'fulfilled');
    const losses = results.filter((r) => r.status === 'rejected');
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(4);
    for (const loss of losses) {
      expect(loss.reason).toMatchObject({
        code: 'ref_stale',
        details: { expected: root.id, actual: expect.any(String) },
      });
    }
  });

  it('serializes 20 queued moves (stale-retry loop) with a correct final head', async () => {
    const repo = await createRepo(dbEnv, { slug: 'acme/queue', visibility: 'public' });
    const chain = await makeChain(repo.id, 20);
    await moveRefViaDO(dbEnv, repo.id, 'main', {
      from: null,
      to: (chain[0] as Changeset).id,
    });

    for (let i = 1; i < chain.length; i++) {
      const target = (chain[i] as Changeset).id;
      for (let attempt = 0; attempt < 10; attempt++) {
        const current = await readRefHead(dbEnv, repo.id, 'main');
        try {
          await moveRefViaDO(dbEnv, repo.id, 'main', { from: current, to: target });
          break;
        } catch (err) {
          if (!(err instanceof ConflictError) || attempt === 9) throw err;
        }
      }
    }

    expect(await readRefHead(dbEnv, repo.id, 'main')).toBe((chain[20] as Changeset).id);
  });

  it('enforces fast-forward unless forced', async () => {
    const repo = await createRepo(dbEnv, { slug: 'acme/ff', visibility: 'public' });
    const [base] = (await makeChain(repo.id, 0)) as [Changeset];
    // sibling branches from base
    const branchA = await commitChanges(dbEnv, repo.id, {
      first_parent: base.id,
      message: 'a',
      author,
      changes: [{ path: 'a.txt', op: 'add', content_b64: b64('a') }],
    });
    const branchB = await commitChanges(dbEnv, repo.id, {
      first_parent: base.id,
      message: 'b',
      author,
      changes: [{ path: 'b.txt', op: 'add', content_b64: b64('b') }],
    });

    await moveRefViaDO(dbEnv, repo.id, 'main', { from: null, to: base.id });
    await moveRefViaDO(dbEnv, repo.id, 'main', {
      from: base.id,
      to: branchA.changeset.id,
    });

    // branchB does not descend from branchA → rejected without force
    await expect(
      moveRefViaDO(dbEnv, repo.id, 'main', {
        from: branchA.changeset.id,
        to: branchB.changeset.id,
      }),
    ).rejects.toMatchObject({ code: 'ref_not_fast_forward' });

    // …but allowed with force
    const forced = await moveRefViaDO(dbEnv, repo.id, 'main', {
      from: branchA.changeset.id,
      to: branchB.changeset.id,
      force: true,
    });
    expect(forced.to).toBe(branchB.changeset.id);
    expect(await readRefHead(dbEnv, repo.id, 'main')).toBe(branchB.changeset.id);

    // from === to is a no-op fast-forward
    await expect(
      moveRefViaDO(dbEnv, repo.id, 'main', {
        from: branchB.changeset.id,
        to: branchB.changeset.id,
      }),
    ).resolves.toEqual({
      ok: true,
      from: branchB.changeset.id,
      to: branchB.changeset.id,
    });
  });

  it('rejects stale from: null when the ref exists', async () => {
    const repo = await createRepo(dbEnv, { slug: 'acme/nullfrom', visibility: 'public' });
    const [cs0] = await makeChain(repo.id, 0);
    await moveRefViaDO(dbEnv, repo.id, 'main', { from: null, to: (cs0 as Changeset).id });
    await expect(
      moveRefViaDO(dbEnv, repo.id, 'main', { from: null, to: (cs0 as Changeset).id }),
    ).rejects.toMatchObject({ code: 'ref_stale', details: { expected: null } });
  });

  it('scion mode only allows main, release/* and agent refs', async () => {
    expect(validateRefName('main', 'scion')).toBe('main');
    expect(validateRefName('release/1.2', 'scion')).toBe('release/1.2');
    expect(validateRefName('release/2026.10-rc.1', 'scion')).toBe('release/2026.10-rc.1');
    expect(validateRefName('refs/agents/a1/task', 'scion')).toBe('refs/agents/a1/task');
    for (const bad of [
      'feature/x',
      'Main',
      'release/',
      'release/A',
      'refs/heads/main',
      'refs/tags/v1',
      '',
    ]) {
      expect(() => validateRefName(bad, 'scion')).toThrow(RequestValidationError);
    }
    try {
      validateRefName('feature/x', 'scion');
    } catch (err) {
      expect(err).toMatchObject({ code: 'invalid_ref_name' });
    }
  });

  it('git mode follows check-ref-format', () => {
    for (const good of [
      'main',
      'feature/foo-bar',
      'user/justin/fix',
      'v1.2.3',
      'Main',
      'release/A',
      'refs/tags/v1.2.3',
      'refs/agents/01ABC/task-7',
    ]) {
      expect(validateRefName(good)).toBe(good);
    }
    for (const bad of [
      '',
      '@',
      'HEAD',
      '-x',
      'a b',
      'a~1',
      'a^',
      'a:b',
      'a?',
      'a*',
      'a[1',
      'a\\b',
      'a\x01b',
      'a\x7fb',
      'a..b',
      'a@{1}',
      'a//b',
      '/a',
      'a/',
      'a.',
      '.hidden',
      'x/.y',
      'x.lock',
      'x.lock/y',
      'refs/heads/main',
      'refs/tags/',
      'refs/agents/a1',
      'refs/agents/a.b/task',
      'x'.repeat(256),
    ]) {
      expect(() => validateRefName(bad), bad).toThrow(RequestValidationError);
    }
    expect(() => validateBranchName('refs/tags/v1')).toThrow(RequestValidationError);
  });

  it('force bypasses staleness — pinned response semantics', async () => {
    const repo = await createRepo(dbEnv, { slug: 'acme/force', visibility: 'public' });
    const [cs0, cs1, cs2] = (await makeChain(repo.id, 2)) as [
      Changeset,
      Changeset,
      Changeset,
    ];
    await moveRefViaDO(dbEnv, repo.id, 'main', { from: null, to: cs0.id });
    await moveRefViaDO(dbEnv, repo.id, 'main', { from: cs0.id, to: cs1.id });

    // stale from + force: lands anyway, response `from` reports the ACTUAL head
    const forced = await moveRefViaDO(dbEnv, repo.id, 'main', {
      from: cs0.id,
      to: cs2.id,
      force: true,
    });
    expect(forced).toEqual({ ok: true, from: cs1.id, to: cs2.id });
    expect(await readRefHead(dbEnv, repo.id, 'main')).toBe(cs2.id);
  });

  it('converges under a parallel stale-retry storm (tasks never go backward)', async () => {
    const repo = await createRepo(dbEnv, { slug: 'acme/storm', visibility: 'public' });
    const chain = await makeChain(repo.id, 8);
    await moveRefViaDO(dbEnv, repo.id, 'main', {
      from: null,
      to: (chain[0] as Changeset).id,
    });

    // Every task tries to land its chain link with a stale-retry loop. Chain
    // order makes cs8 the unique maximal target — it always lands, and nothing
    // can ever move the ref backward (non-fast-forwards are rejected), so the
    // final head MUST be the tip.
    const settle = async (target: string): Promise<'landed' | 'superseded'> => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const current = await readRefHead(dbEnv, repo.id, 'main');
        if (current === target) return 'landed';
        try {
          await moveRefViaDO(dbEnv, repo.id, 'main', { from: current, to: target });
          return 'landed';
        } catch (err) {
          if (!(err instanceof ConflictError)) throw err;
          if (err.code === 'ref_not_fast_forward') return 'superseded';
        }
      }
      throw new Error('did not settle');
    };

    const results = await Promise.all(chain.map((cs) => settle((cs as Changeset).id)));
    expect(results).toHaveLength(9);
    expect(results.every((r) => r === 'landed' || r === 'superseded')).toBe(true);
    expect(await readRefHead(dbEnv, repo.id, 'main')).toBe((chain[8] as Changeset).id);
  });

  it('DO ids are deterministic per (repo, ref)', () => {
    const a1 = testEnv.REF_LOCK.idFromName('repo-1:main');
    const a2 = testEnv.REF_LOCK.idFromName('repo-1:main');
    const other = testEnv.REF_LOCK.idFromName('repo-1:release/1.2');
    const otherRepo = testEnv.REF_LOCK.idFromName('repo-2:main');
    expect(a1.toString()).toBe(a2.toString());
    expect(a1.toString()).not.toBe(other.toString());
    expect(a1.toString()).not.toBe(otherRepo.toString());
  });
});

describe('ref routes', () => {
  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
    auth = await loginAs(testEnv, 1, 'ada');
  });

  it('PUT creates and moves refs over HTTP; GET serves them', async () => {
    const repo = await createRepo(dbEnv, {
      slug: 'acme/routes',
      visibility: 'public',
      createdBy: auth.userId,
    });
    const [cs0, cs1] = (await makeChain(repo.id, 1)) as [Changeset, Changeset];

    const created = await putRef('acme/routes', 'main', {
      from: null,
      to: cs0.id,
    });
    expect(created.status).toBe(200);
    expect(await created.json()).toEqual({
      ok: true,
      from: null,
      to: cs0.id,
    });

    const moved = await putRef('acme/routes', 'main', {
      from: cs0.id,
      to: cs1.id,
    });
    expect(moved.status).toBe(200);

    const single = await getRefRoute('acme/routes', 'main');
    expect(single.status).toBe(200);
    expect(((await single.json()) as { head: string }).head).toBe(cs1.id);

    const list = await getRefRoute('acme/routes');
    expect(list.status).toBe(200);
    const { refs } = (await list.json()) as {
      refs: { name: string; head: string }[];
    };
    expect(refs).toEqual([
      {
        name: 'main',
        head: cs1.id,
        updated_at: expect.any(Number),
      },
    ]);

    const missing = await getRefRoute('acme/routes', 'release/9.9');
    expect(missing.status).toBe(404);
  });

  it('PUT reports stale moves as 409 with expected/actual in the envelope', async () => {
    const repo = await createRepo(dbEnv, {
      slug: 'acme/http-stale',
      visibility: 'public',
      createdBy: auth.userId,
    });
    const [cs0, cs1, cs2] = (await makeChain(repo.id, 2)) as [
      Changeset,
      Changeset,
      Changeset,
    ];

    await putRef('acme/http-stale', 'main', { from: null, to: cs0.id });

    const stale = await putRef('acme/http-stale', 'main', {
      from: cs0.id,
      to: cs1.id,
    });
    expect(stale.status).toBe(200);

    const loser = await putRef('acme/http-stale', 'main', {
      from: cs0.id,
      to: cs2.id,
    });
    expect(loser.status).toBe(409);
    const body = (await loser.json()) as {
      error: { code: string; expected: string; actual: string };
    };
    expect(body.error.code).toBe('ref_stale');
    expect(body.error.expected).toBe(cs0.id);
    expect(body.error.actual).toBe(cs1.id);
  });

  it('validates names and targets at the edge', async () => {
    const repo = await createRepo(dbEnv, {
      slug: 'acme/validate',
      visibility: 'public',
      createdBy: auth.userId,
    });
    const [cs0] = (await makeChain(repo.id, 0)) as [Changeset];

    const unknownRepo = await putRef('acme/nope', 'main', {
      from: null,
      to: cs0.id,
    });
    expect(unknownRepo.status).toBe(404);

    const badName = await putRef('acme/validate', 'feature..x', {
      from: null,
      to: cs0.id,
    });
    expect(badName.status).toBe(400);
    expect(((await badName.json()) as { error: { code: string } }).error.code).toBe(
      'invalid_ref_name',
    );

    const badTarget = await putRef('acme/validate', 'main', {
      from: null,
      to: '0'.repeat(64),
    });
    expect(badTarget.status).toBe(400);
    expect(((await badTarget.json()) as { error: { code: string } }).error.code).toBe(
      'unknown_target',
    );

    const badBody = await putRef('acme/validate', 'main', { from: null });
    expect(badBody.status).toBe(400);
  });

  it('ref:main resolution in commits follows CAS moves', async () => {
    const repo = await createRepo(dbEnv, {
      slug: 'acme/wired',
      visibility: 'public',
      createdBy: auth.userId,
    });
    const [cs0] = (await makeChain(repo.id, 0)) as [Changeset];
    await setRef(dbEnv, repo.id, 'main', cs0.id);

    const child = await commitChanges(dbEnv, repo.id, {
      first_parent: 'ref:main',
      message: 'child',
      author,
      changes: [{ path: 'extra.txt', op: 'add', content_b64: b64('x') }],
    });
    expect(child.changeset.first_parent).toBe(cs0.id);
  });
});
