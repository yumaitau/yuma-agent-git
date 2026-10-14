import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { cleanDb, makeApp, seedSchema, sha256 } from './helpers';
import type { TestEnv } from './helpers';
import { createRepo, getRepoBySlug, setRef } from '../src/db/repos';
import { commitChanges } from '../src/core/commit';
import { firstParentHistory } from '../src/core/changesets';
import { resolvePath } from '../src/core/trees';
import { getBlob } from '../src/core/blobs';

const testEnv = env as unknown as TestEnv;
const dbEnv = testEnv as unknown as Env;

const author = { name: 'Ada', email: 'ada@example.com' };
const dec = new TextDecoder();
const enc = new TextEncoder();

function b64(text: string): string {
  return btoa(text);
}

async function objectCount(repoId: string): Promise<number> {
  let n = 0;
  let cursor: string | undefined;
  do {
    const res = await testEnv.OBJECTS.list({ prefix: `repos/${repoId}/`, cursor });
    n += res.objects.length;
    cursor = res.truncated ? res.cursor : undefined;
  } while (cursor !== undefined);
  return n;
}

async function postCommit(slug: string, body: unknown): Promise<Response> {
  const app = makeApp(testEnv);
  return app(
    new Request(`http://x/api/v1/repos/${slug}/changesets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

function baseBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    first_parent: null,
    message: 'hello',
    author,
    changes: [{ path: 'src/app.ts', op: 'add', content_b64: b64('code') }],
    ...over,
  };
}

describe('commitChanges', () => {
  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
  });

  it('creates a root changeset: tree resolvable, blob retrievable + hash-verified', async () => {
    const repo = await createRepo(dbEnv, { slug: 'acme/root' });
    const text = 'export const x = 1;\n';
    const result = await commitChanges(dbEnv, repo.id, {
      first_parent: null,
      message: 'root',
      author,
      changes: [{ path: 'src/app.ts', op: 'add', content_b64: b64(text) }],
    });

    expect(result.deduped).toBe(false);
    expect(result.changeset.first_parent).toBeNull();
    expect(result.changeset.parents).toEqual([]);
    expect(result.changeset.root_tree).toMatch(/^[0-9a-f]{64}$/);

    const entry = await resolvePath(
      dbEnv,
      repo.id,
      result.changeset.root_tree as string,
      ['src', 'app.ts'],
    );
    expect(entry?.kind).toBe('blob');
    expect(entry?.hash).toBe(result.blobs[0]?.hash);
    expect(entry?.size).toBe(enc.encode(text).byteLength);

    const blob = await getBlob(dbEnv, repo.id, entry?.hash as string);
    expect(dec.decode(blob?.content as Uint8Array)).toBe(text);
    expect(await sha256(blob?.content as Uint8Array)).toBe(entry?.hash);
  });

  it('rewrites only trees along the touched path (incremental, lock-free)', async () => {
    const repo = await createRepo(dbEnv, { slug: 'acme/incremental' });
    const root = await commitChanges(dbEnv, repo.id, {
      first_parent: null,
      message: 'root',
      author,
      changes: [
        { path: 'a/b/c/f1.txt', op: 'add', content_b64: b64('one') },
        { path: 'a/b/c/f2.txt', op: 'add', content_b64: b64('two') },
        { path: 'x/y/f3.txt', op: 'add', content_b64: b64('three') },
      ],
    });
    const rootTree = root.changeset.root_tree as string;
    const cDirBefore = await resolvePath(dbEnv, repo.id, rootTree, ['a', 'b', 'c']);
    const xyBefore = await resolvePath(dbEnv, repo.id, rootTree, ['x', 'y']);
    const before = await objectCount(repo.id);

    const child = await commitChanges(dbEnv, repo.id, {
      first_parent: root.changeset.id,
      message: 'touch f1',
      author,
      changes: [{ path: 'a/b/c/f1.txt', op: 'mod', content_b64: b64('ONE') }],
    });
    const childTree = child.changeset.root_tree as string;
    const cDirAfter = await resolvePath(dbEnv, repo.id, childTree, ['a', 'b', 'c']);
    const xyAfter = await resolvePath(dbEnv, repo.id, childTree, ['x', 'y']);

    // untouched subtree keeps its exact tree hash and is never rewritten
    expect(xyAfter?.hash).toBe(xyBefore?.hash);
    expect(cDirAfter?.hash).not.toBe(cDirBefore?.hash);

    // exactly: 1 new blob + 4 rewritten trees (a/b/c, a/b, a, root)
    expect(await objectCount(repo.id)).toBe(before + 5);
  });

  it('deletes: path absent from the new root tree, present in the parent', async () => {
    const repo = await createRepo(dbEnv, { slug: 'acme/delete' });
    const root = await commitChanges(dbEnv, repo.id, {
      first_parent: null,
      message: 'root',
      author,
      changes: [
        { path: 'keep.txt', op: 'add', content_b64: b64('keep') },
        { path: 'gone.txt', op: 'add', content_b64: b64('gone') },
      ],
    });
    expect(
      await resolvePath(dbEnv, repo.id, root.changeset.root_tree as string, ['gone.txt']),
    ).not.toBeNull();

    const child = await commitChanges(dbEnv, repo.id, {
      first_parent: root.changeset.id,
      message: 'delete gone',
      author,
      changes: [{ path: 'gone.txt', op: 'del' }],
    });

    expect(
      await resolvePath(dbEnv, repo.id, child.changeset.root_tree as string, [
        'gone.txt',
      ]),
    ).toBeNull();
    expect(
      await resolvePath(dbEnv, repo.id, root.changeset.root_tree as string, ['gone.txt']),
    ).not.toBeNull();
    expect(
      await resolvePath(dbEnv, repo.id, child.changeset.root_tree as string, [
        'keep.txt',
      ]),
    ).not.toBeNull();
  });

  it('drops empty directories git-style', async () => {
    const repo = await createRepo(dbEnv, { slug: 'acme/emptydir' });
    const root = await commitChanges(dbEnv, repo.id, {
      first_parent: null,
      message: 'root',
      author,
      changes: [{ path: 'only/dir/file.txt', op: 'add', content_b64: b64('x') }],
    });
    const child = await commitChanges(dbEnv, repo.id, {
      first_parent: root.changeset.id,
      message: 'remove it',
      author,
      changes: [{ path: 'only/dir/file.txt', op: 'del' }],
    });
    expect(
      await resolvePath(dbEnv, repo.id, child.changeset.root_tree as string, ['only']),
    ).toBeNull();
  });

  it('stores merge commits with parents and changed_files relative to first parent', async () => {
    const repo = await createRepo(dbEnv, { slug: 'acme/merge' });
    const root = await commitChanges(dbEnv, repo.id, {
      first_parent: null,
      message: 'root',
      author,
      changes: [{ path: 'base.txt', op: 'add', content_b64: b64('base') }],
    });
    const c1 = await commitChanges(dbEnv, repo.id, {
      first_parent: root.changeset.id,
      message: 'c1',
      author,
      changes: [{ path: 'x.txt', op: 'add', content_b64: b64('x') }],
    });
    const c2 = await commitChanges(dbEnv, repo.id, {
      first_parent: root.changeset.id,
      message: 'c2',
      author,
      changes: [{ path: 'y.txt', op: 'add', content_b64: b64('y') }],
    });

    const merge = await commitChanges(dbEnv, repo.id, {
      first_parent: c1.changeset.id,
      parents: [c2.changeset.id],
      message: 'merge',
      author,
      changes: [{ path: 'z.txt', op: 'add', content_b64: b64('z') }],
    });

    expect(merge.changeset.parents).toEqual([c1.changeset.id, c2.changeset.id]);
    expect(merge.changeset.first_parent).toBe(c1.changeset.id);
    expect(merge.changeset.changed_files).toEqual([
      {
        path: 'z.txt',
        op: 'add',
        hash: await sha256(enc.encode('z')),
        size: 1,
      },
    ]);
  });

  it('is idempotent: identical request reuses the changeset and writes no objects', async () => {
    const repo = await createRepo(dbEnv, { slug: 'acme/idem' });
    const req = {
      first_parent: null,
      message: 'root',
      author,
      changes: [{ path: 'a.txt', op: 'add' as const, content_b64: b64('content') }],
    };
    const first = await commitChanges(dbEnv, repo.id, req);
    const afterFirst = await objectCount(repo.id);
    const second = await commitChanges(dbEnv, repo.id, req);

    expect(second.deduped).toBe(true);
    expect(second.changeset.id).toBe(first.changeset.id);
    expect(second.changeset.created_at).toBe(first.changeset.created_at);
    expect(await objectCount(repo.id)).toBe(afterFirst);
    expect(await firstParentHistory(dbEnv, repo.id, first.changeset.id, 10)).toHaveLength(
      1,
    );
  });

  it('resolves first_parent via ref:main and bare ref names', async () => {
    const repo = await createRepo(dbEnv, { slug: 'acme/refs' });
    const root = await commitChanges(dbEnv, repo.id, {
      first_parent: null,
      message: 'root',
      author,
      changes: [{ path: 'a.txt', op: 'add', content_b64: b64('a') }],
    });
    await setRef(dbEnv, repo.id, 'main', root.changeset.id);

    for (const first_parent of ['ref:main', 'main', root.changeset.id]) {
      const child = await commitChanges(dbEnv, repo.id, {
        first_parent,
        message: `child via ${first_parent}`,
        author,
        changes: [{ path: 'b.txt', op: 'add', content_b64: b64('b') }],
      });
      expect(child.changeset.first_parent).toBe(root.changeset.id);
    }
  });
});

describe('changeset routes', () => {
  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
  });

  it('POST creates a changeset (201) and GET serves it back', async () => {
    await createRepo(dbEnv, { slug: 'acme/routes' });
    const res = await postCommit('acme/routes', baseBody());
    expect(res.status).toBe(201);
    const created = (await res.json()) as {
      changeset: { id: string; message: string };
      deduped: boolean;
    };
    expect(created.deduped).toBe(false);
    expect(created.changeset.message).toBe('hello');

    const get = await makeApp(testEnv)(
      new Request(`http://x/api/v1/repos/acme/routes/changesets/${created.changeset.id}`),
    );
    expect(get.status).toBe(200);
    expect(((await get.json()) as { changeset: { id: string } }).changeset.id).toBe(
      created.changeset.id,
    );

    const missing = await makeApp(testEnv)(
      new Request(`http://x/api/v1/repos/acme/routes/changesets/${'0'.repeat(64)}`),
    );
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe(
      'changeset_not_found',
    );
  });

  it('POST is idempotent over HTTP: second call 200 + deduped', async () => {
    await createRepo(dbEnv, { slug: 'acme/http-idem' });
    const first = await postCommit('acme/http-idem', baseBody());
    expect(first.status).toBe(201);
    const second = await postCommit('acme/http-idem', baseBody());
    expect(second.status).toBe(200);
    const body = (await second.json()) as {
      deduped: boolean;
      changeset: { id: string };
    };
    expect(body.deduped).toBe(true);
    expect(body.changeset.id).toBe(
      ((await first.json()) as { changeset: { id: string } }).changeset.id,
    );
  });

  it('GET /changesets walks first-parent history from head', async () => {
    await createRepo(dbEnv, { slug: 'acme/history' });
    const root = await postCommit('acme/history', baseBody({ message: 'one' }));
    const rootBody = (await root.json()) as { changeset: { id: string } };

    const second = await postCommit(
      'acme/history',
      baseBody({
        message: 'two',
        first_parent: rootBody.changeset.id,
        changes: [{ path: 'src/app.ts', op: 'mod', content_b64: b64('more code') }],
      }),
    );
    const secondBody = (await second.json()) as { changeset: { id: string } };
    await setRef(
      dbEnv,
      (await getRepoId('acme/history')) as string,
      'main',
      secondBody.changeset.id,
    );

    const res = await makeApp(testEnv)(
      new Request('http://x/api/v1/repos/acme/history/changesets?head=ref:main&limit=10'),
    );
    expect(res.status).toBe(200);
    const { changesets } = (await res.json()) as { changesets: { message: string }[] };
    expect(changesets.map((c) => c.message)).toEqual(['two', 'one']);

    const limited = await makeApp(testEnv)(
      new Request(
        `http://x/api/v1/repos/acme/history/changesets?head=${rootBody.changeset.id}&limit=1`,
      ),
    );
    expect(((await limited.json()) as { changesets: unknown[] }).changesets).toHaveLength(
      1,
    );

    const bad = await makeApp(testEnv)(
      new Request('http://x/api/v1/repos/acme/history/changesets?head=nosuchrev'),
    );
    expect(bad.status).toBe(404);
  });

  it('rejects invalid requests with the error envelope', async () => {
    await createRepo(dbEnv, { slug: 'acme/bad' });

    const unknownRepo = await postCommit('acme/nope', baseBody());
    expect(unknownRepo.status).toBe(404);
    expect(((await unknownRepo.json()) as { error: { code: string } }).error.code).toBe(
      'repo_not_found',
    );

    const badPath = await postCommit(
      'acme/bad',
      baseBody({
        changes: [{ path: '../x', op: 'add', content_b64: b64('x') }],
      }),
    );
    expect(badPath.status).toBe(400);

    const missingBlob = await postCommit(
      'acme/bad',
      baseBody({
        changes: [{ path: 'x.bin', op: 'add', blob_sha256: '0'.repeat(64) }],
      }),
    );
    expect(missingBlob.status).toBe(400);
    expect(((await missingBlob.json()) as { error: { code: string } }).error.code).toBe(
      'missing_blob',
    );

    const bigMessage = await postCommit(
      'acme/bad',
      baseBody({ message: 'x'.repeat(70000) }),
    );
    expect(bigMessage.status).toBe(400);

    const unknownParent = await postCommit(
      'acme/bad',
      baseBody({ first_parent: '1'.repeat(64) }),
    );
    expect(unknownParent.status).toBe(400);
    expect(((await unknownParent.json()) as { error: { code: string } }).error.code).toBe(
      'unknown_parent',
    );

    const bigInline = await postCommit(
      'acme/bad',
      baseBody({
        changes: [
          {
            path: 'big.bin',
            op: 'add',
            content_b64: btoa('x'.repeat(5 * 1024 * 1024)),
          },
        ],
      }),
    );
    expect(bigInline.status).toBe(413);
    expect(((await bigInline.json()) as { error: { code: string } }).error.code).toBe(
      'inline_too_large',
    );

    const malformed = await makeApp(testEnv)(
      new Request('http://x/api/v1/repos/acme/bad/changesets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not json',
      }),
    );
    expect(malformed.status).toBe(400);
  });
});

async function getRepoId(slug: string): Promise<string | null> {
  const repo = await getRepoBySlug(dbEnv, slug);
  return repo ? repo.id : null;
}
