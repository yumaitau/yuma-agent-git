import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import {
  cleanDb,
  instrumentObjects,
  loginAs,
  makeViewerApp,
  seedSchema,
  sha256,
} from './helpers';
import type { TestEnv } from './helpers';
import { createRepo, getRepoBySlug, listRefs, setRef } from '../src/db/repos';
import { commitChanges } from '../src/core/commit';
import { firstParentHistory } from '../src/core/changesets';
import { resolvePath } from '../src/core/trees';
import { getBlob } from '../src/core/blobs';

const testEnv = env as unknown as TestEnv;
const dbEnv = testEnv as unknown as Env;

const author = { name: 'Ada', email: 'ada@example.com' };
const dec = new TextDecoder();
const enc = new TextEncoder();

let auth: Awaited<ReturnType<typeof loginAs>>;

function b64(text: string): string {
  return btoa(text);
}

async function postCommit(slug: string, body: unknown): Promise<Response> {
  const app = makeViewerApp(testEnv);
  return app(
    new Request(`http://x/api/v1/repos/${slug}/changesets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth.headers },
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
    const repo = await createRepo(dbEnv, { slug: 'acme/root', visibility: 'public' });
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

  it('rewrites only trees along the touched path — cost independent of repo size', async () => {
    // Two repos: identical touch, wildly different amount of untouched content.
    const build = async (slug: string, siblings: number): Promise<number> => {
      const repo = await createRepo(dbEnv, { slug });
      const rootChanges = [
        { path: 'a/b/c/f1.txt', op: 'add' as const, content_b64: b64('one') },
        { path: 'a/b/c/f2.txt', op: 'add' as const, content_b64: b64('two') },
        { path: 'x/y/f3.txt', op: 'add' as const, content_b64: b64('three') },
      ];
      for (let i = 0; i < siblings; i++) {
        rootChanges.push({
          path: `s${i}/t.txt`,
          op: 'add' as const,
          content_b64: b64(`sibling ${i}`),
        });
      }
      const root = await commitChanges(dbEnv, repo.id, {
        first_parent: null,
        message: 'root',
        author,
        changes: rootChanges,
      });
      const rootTree = root.changeset.root_tree as string;
      const cDirBefore = await resolvePath(dbEnv, repo.id, rootTree, ['a', 'b', 'c']);
      const xyBefore = await resolvePath(dbEnv, repo.id, rootTree, ['x', 'y']);

      const probe = instrumentObjects(testEnv);
      const child = await commitChanges(probe.env, repo.id, {
        first_parent: root.changeset.id,
        message: 'touch f1',
        author,
        // per-repo content: Git blob IDs are a global index, so a shared blob
        // would skip the git_ids read in the second repo only
        changes: [{ path: 'a/b/c/f1.txt', op: 'mod', content_b64: b64(`ONE ${slug}`) }],
      });
      const childTree = child.changeset.root_tree as string;

      // the touched chain was rewritten…
      const cDirAfter = await resolvePath(dbEnv, repo.id, childTree, ['a', 'b', 'c']);
      expect(cDirAfter?.hash).not.toBe(cDirBefore?.hash);
      // …while the untouched subtree keeps its exact tree hash…
      const xyAfter = await resolvePath(dbEnv, repo.id, childTree, ['x', 'y']);
      expect(xyAfter?.hash).toBe(xyBefore?.hash);
      // …and is NEVER fetched or written: no untouched subtree hash in any call
      const untouchedHashes = [xyBefore?.hash];
      for (let i = 0; i < siblings; i++) {
        const entry = await resolvePath(dbEnv, repo.id, rootTree, [`s${i}`]);
        untouchedHashes.push(entry?.hash);
      }
      for (const key of [...probe.puts, ...probe.gets]) {
        for (const hash of untouchedHashes) {
          expect(key.includes(hash as string)).toBe(false);
        }
      }
      // exactly 1 new blob + 4 rewritten trees (a/b/c, a/b, a, root)
      expect(probe.puts).toHaveLength(5);
      expect(probe.puts.filter((k) => k.includes('/blobs/'))).toHaveLength(1);
      expect(probe.puts.filter((k) => k.includes('/trees/'))).toHaveLength(4);

      return probe.puts.length + probe.gets.length;
    };

    const small = await build('acme/incremental-small', 1);
    const large = await build('acme/incremental-large', 30);
    // the whole point of the design: identical work regardless of repo size
    expect(large).toBe(small);
  });

  it('never moves refs as part of a commit (lock-free write path)', async () => {
    const repo = await createRepo(dbEnv, { slug: 'acme/no-refs', visibility: 'public' });
    await commitChanges(dbEnv, repo.id, {
      first_parent: null,
      message: 'root',
      author,
      changes: [{ path: 'a.txt', op: 'add', content_b64: b64('a') }],
    });
    expect(await listRefs(dbEnv, repo.id)).toEqual([]);
  });

  it('deletes: path absent from the new root tree, present in the parent', async () => {
    const repo = await createRepo(dbEnv, { slug: 'acme/delete', visibility: 'public' });
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
    const repo = await createRepo(dbEnv, { slug: 'acme/emptydir', visibility: 'public' });
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
    const repo = await createRepo(dbEnv, { slug: 'acme/merge', visibility: 'public' });
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

    // changed_files is relative to the FIRST parent — and so is the tree:
    // x.txt (first parent) and z.txt are in it, y.txt (second parent only) is not
    const tree = merge.changeset.root_tree as string;
    expect(await resolvePath(dbEnv, repo.id, tree, ['z.txt'])).not.toBeNull();
    expect(await resolvePath(dbEnv, repo.id, tree, ['x.txt'])).not.toBeNull();
    expect(await resolvePath(dbEnv, repo.id, tree, ['y.txt'])).toBeNull();
  });

  it('is idempotent: identical request reuses the changeset with ZERO R2 I/O', async () => {
    const repo = await createRepo(dbEnv, { slug: 'acme/idem', visibility: 'public' });
    const req = {
      first_parent: null,
      message: 'root',
      author,
      changes: [{ path: 'a.txt', op: 'add' as const, content_b64: b64('content') }],
    };
    const probe = instrumentObjects(testEnv);
    const first = await commitChanges(probe.env, repo.id, req);
    const firstWrites = probe.puts.length;
    expect(firstWrites).toBeGreaterThan(0);

    probe.puts.length = 0;
    probe.gets.length = 0;
    probe.heads.length = 0;
    const second = await commitChanges(probe.env, repo.id, req);

    expect(second.deduped).toBe(true);
    expect(second.changeset.id).toBe(first.changeset.id);
    expect(second.changeset.created_at).toBe(first.changeset.created_at);
    // no re-upload, no re-put, not even a dedupe head-check: zero object I/O
    expect(probe.puts).toEqual([]);
    expect(probe.gets).toEqual([]);
    expect(probe.heads).toEqual([]);
    expect(await firstParentHistory(dbEnv, repo.id, first.changeset.id, 10)).toHaveLength(
      1,
    );
  });

  it('rejects change sets that would corrupt the tree', async () => {
    const repo = await createRepo(dbEnv, {
      slug: 'acme/conflicts',
      visibility: 'public',
    });
    const root = await commitChanges(dbEnv, repo.id, {
      first_parent: null,
      message: 'root with file a',
      author,
      changes: [{ path: 'a', op: 'add', content_b64: b64('I am file a') }],
    });

    // del of a path nested under an existing FILE must not destroy that file
    await expect(
      commitChanges(dbEnv, repo.id, {
        first_parent: root.changeset.id,
        message: 'bogus',
        author,
        changes: [{ path: 'a/b/c.txt', op: 'del' }],
      }),
    ).rejects.toMatchObject({ code: 'invalid_change' });
    expect(
      await resolvePath(dbEnv, repo.id, root.changeset.root_tree as string, ['a']),
    ).toMatchObject({ kind: 'blob' });

    // add over an existing file
    await expect(
      commitChanges(dbEnv, repo.id, {
        first_parent: root.changeset.id,
        message: 'bogus',
        author,
        changes: [{ path: 'a', op: 'add', content_b64: b64('other') }],
      }),
    ).rejects.toMatchObject({ code: 'invalid_change' });

    // mod of a missing path
    await expect(
      commitChanges(dbEnv, repo.id, {
        first_parent: root.changeset.id,
        message: 'bogus',
        author,
        changes: [{ path: 'missing.txt', op: 'mod', content_b64: b64('x') }],
      }),
    ).rejects.toMatchObject({ code: 'invalid_change' });

    // nested paths in one commit (file/dir collision)
    await expect(
      commitChanges(dbEnv, repo.id, {
        first_parent: root.changeset.id,
        message: 'bogus',
        author,
        changes: [
          { path: 'd', op: 'add', content_b64: b64('file d') },
          { path: 'd/e.txt', op: 'add', content_b64: b64('inside d') },
        ],
      }),
    ).rejects.toMatchObject({ code: 'invalid_change' });

    // del of a directory
    const withDirs = await commitChanges(dbEnv, repo.id, {
      first_parent: root.changeset.id,
      message: 'dirs',
      author,
      changes: [{ path: 'dir/one.txt', op: 'add', content_b64: b64('1') }],
    });
    await expect(
      commitChanges(dbEnv, repo.id, {
        first_parent: withDirs.changeset.id,
        message: 'bogus',
        author,
        changes: [{ path: 'dir', op: 'del' }],
      }),
    ).rejects.toMatchObject({ code: 'invalid_change' });
  });

  it('resolves first_parent via ref:main and bare ref names', async () => {
    const repo = await createRepo(dbEnv, { slug: 'acme/refs', visibility: 'public' });
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
    auth = await loginAs(testEnv, 1, 'ada');
  });

  it('POST creates a changeset (201) and GET serves it back', async () => {
    await createRepo(dbEnv, {
      slug: 'acme/routes',
      visibility: 'public',
      createdBy: auth.userId,
    });
    const res = await postCommit('acme/routes', baseBody());
    expect(res.status).toBe(201);
    const created = (await res.json()) as {
      changeset: { id: string; message: string };
      deduped: boolean;
    };
    expect(created.deduped).toBe(false);
    expect(created.changeset.message).toBe('hello');

    const get = await makeViewerApp(testEnv)(
      new Request(`http://x/api/v1/repos/acme/routes/changesets/${created.changeset.id}`),
    );
    expect(get.status).toBe(200);
    expect(((await get.json()) as { changeset: { id: string } }).changeset.id).toBe(
      created.changeset.id,
    );

    const missing = await makeViewerApp(testEnv)(
      new Request(`http://x/api/v1/repos/acme/routes/changesets/${'0'.repeat(64)}`),
    );
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe(
      'changeset_not_found',
    );
  });

  it('POST is idempotent over HTTP: second call 200 + deduped', async () => {
    await createRepo(dbEnv, {
      slug: 'acme/http-idem',
      visibility: 'public',
      createdBy: auth.userId,
    });
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
    await createRepo(dbEnv, {
      slug: 'acme/history',
      visibility: 'public',
      createdBy: auth.userId,
    });
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

    const res = await makeViewerApp(testEnv)(
      new Request('http://x/api/v1/repos/acme/history/changesets?head=ref:main&limit=10'),
    );
    expect(res.status).toBe(200);
    const { changesets } = (await res.json()) as { changesets: { message: string }[] };
    expect(changesets.map((c) => c.message)).toEqual(['two', 'one']);

    const limited = await makeViewerApp(testEnv)(
      new Request(
        `http://x/api/v1/repos/acme/history/changesets?head=${rootBody.changeset.id}&limit=1`,
      ),
    );
    expect(((await limited.json()) as { changesets: unknown[] }).changesets).toHaveLength(
      1,
    );

    const bad = await makeViewerApp(testEnv)(
      new Request('http://x/api/v1/repos/acme/history/changesets?head=nosuchrev'),
    );
    expect(bad.status).toBe(404);
  });

  it('rejects invalid requests with the error envelope', async () => {
    await createRepo(dbEnv, {
      slug: 'acme/bad',
      visibility: 'public',
      createdBy: auth.userId,
    });

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

    const malformed = await makeViewerApp(testEnv)(
      new Request('http://x/api/v1/repos/acme/bad/changesets', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth.headers },
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
