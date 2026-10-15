import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import {
  cleanDb,
  instrumentObjects,
  loginAs,
  makeViewerApp,
  seedSchema,
} from './helpers';
import type { TestEnv } from './helpers';
import { createRepo, setRef } from '../src/db/repos';
import { commitChanges } from '../src/core/commit';
import type { Changeset } from '../src/core/changesets';
import { collectTexts, diffRevisions } from '../src/core/diff';
import { resolvePath } from '../src/core/trees';

const testEnv = env as unknown as TestEnv;
const dbEnv = testEnv as unknown as Env;
const author = { name: 'Ada', email: 'ada@example.com' };

function b64(text: string): string {
  return btoa(text);
}

async function get(path: string): Promise<Response> {
  return makeViewerApp(testEnv)(new Request(`http://x/api/v1/repos${path}`));
}

/**
 * base: A.txt, B.txt, a/b/c/f.txt, x/y/g.txt
 * from: A.txt modified          to: B.txt modified
 */
async function seedBranches(
  slug: string,
  visibility: 'private' | 'public' = 'public',
): Promise<{
  repoId: string;
  base: Changeset;
  from: Changeset;
  to: Changeset;
}> {
  const repo = await createRepo(dbEnv, { slug, visibility });
  const base = (
    await commitChanges(dbEnv, repo.id, {
      first_parent: null,
      message: 'base',
      author,
      changes: [
        { path: 'A.txt', op: 'add', content_b64: b64('a1\na2\n') },
        { path: 'B.txt', op: 'add', content_b64: b64('b1\n') },
        { path: 'a/b/c/f.txt', op: 'add', content_b64: b64('f\n') },
        { path: 'x/y/g.txt', op: 'add', content_b64: b64('g\n') },
      ],
    })
  ).changeset;
  const from = (
    await commitChanges(dbEnv, repo.id, {
      first_parent: base.id,
      message: 'change A',
      author,
      changes: [{ path: 'A.txt', op: 'mod', content_b64: b64('a1\nCHANGED\n') }],
    })
  ).changeset;
  const to = (
    await commitChanges(dbEnv, repo.id, {
      first_parent: base.id,
      message: 'change B',
      author,
      changes: [{ path: 'B.txt', op: 'mod', content_b64: b64('b1\nb2\n') }],
    })
  ).changeset;
  await setRef(dbEnv, repo.id, 'main', base.id);
  return { repoId: repo.id, base, from, to };
}

describe('diffRevisions', () => {
  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
  });

  it('three-dot: shows BOTH sides vs the merge base and reports it', async () => {
    const { repoId, base, from, to } = await seedBranches('acme/threedot');
    const diff = await diffRevisions(dbEnv, repoId, from.id, to.id);

    expect(diff.merge_base).toBe(base.id);
    // skip-list merge base (issue #8) — the provisional flag no longer exists
    expect(diff.files).toEqual([
      {
        path: 'A.txt',
        kind: 'mod',
        old_hash: expect.any(String),
        new_hash: expect.any(String),
        old_size: 6,
        new_size: 11,
        size_delta: 5,
        side: 'from',
      },
      {
        path: 'B.txt',
        kind: 'mod',
        old_hash: expect.any(String),
        new_hash: expect.any(String),
        old_size: 3,
        new_size: 6,
        size_delta: 3,
        side: 'to',
      },
    ]);
    expect(diff.truncated).toBe(false);
  });

  it('three-dot: conflicting same-file edits show both sides vs base', async () => {
    const { repoId, base } = await seedBranches('acme/conflict');
    const from = (
      await commitChanges(dbEnv, repoId, {
        first_parent: base.id,
        message: 'A from side',
        author,
        changes: [{ path: 'A.txt', op: 'mod', content_b64: b64('FROM\n') }],
      })
    ).changeset;
    const to = (
      await commitChanges(dbEnv, repoId, {
        first_parent: base.id,
        message: 'A to side',
        author,
        changes: [{ path: 'A.txt', op: 'mod', content_b64: b64('TO\n') }],
      })
    ).changeset;

    const diff = await diffRevisions(dbEnv, repoId, from.id, to.id, {
      includeText: true,
    });
    const aFiles = diff.files.filter((f) => f.path === 'A.txt');
    expect(aFiles.map((f) => f.side)).toEqual(['from', 'to']);
    const aTexts = (diff.texts ?? []).filter((t) => t.path === 'A.txt');
    expect(aTexts).toHaveLength(2);
    // each side's unified diff is base → that side
    expect(aTexts[0]?.unified).toContain('-a1\n-a2\n');
    expect(aTexts[0]?.unified).toContain('+FROM\n');
    expect(aTexts[1]?.unified).toContain('-a1\n-a2\n');
    expect(aTexts[1]?.unified).toContain('+TO\n');
  });

  it('direct mode compares from/to trees without a merge base', async () => {
    const { repoId, from, to } = await seedBranches('acme/direct');
    const diff = await diffRevisions(dbEnv, repoId, from.id, to.id, { mode: 'direct' });

    expect(diff.merge_base).toBeNull();
    expect(diff.files).toEqual([
      {
        path: 'A.txt',
        kind: 'mod',
        old_hash: expect.any(String),
        new_hash: expect.any(String),
        old_size: 11,
        new_size: 6,
        size_delta: -5,
        side: undefined,
      },
      {
        path: 'B.txt',
        kind: 'mod',
        old_hash: expect.any(String),
        new_hash: expect.any(String),
        old_size: 3,
        new_size: 6,
        size_delta: 3,
        side: undefined,
      },
    ]);
  });

  it('walks only changed subtrees (untouched trees never fetched)', async () => {
    const { repoId, base, from } = await seedBranches('acme/prune');
    const xyEntry = await resolvePath(dbEnv, repoId, base.root_tree as string, [
      'x',
      'y',
    ]);
    const siblingEntry = await resolvePath(dbEnv, repoId, base.root_tree as string, [
      'x',
    ]);

    const probe = instrumentObjects(testEnv);
    const diff = await diffRevisions(probe.env, repoId, base.id, from.id, {
      mode: 'direct',
    });
    expect(diff.files.map((f) => f.path)).toEqual(['A.txt']);

    // only the root trees + the a/ chain are read; x and x/y are never fetched
    for (const key of [...probe.gets]) {
      expect(key.includes(xyEntry?.hash as string)).toBe(false);
      expect(key.includes(siblingEntry?.hash as string)).toBe(false);
    }
  });

  it('truncates at maxFiles', async () => {
    const repo = await createRepo(dbEnv, { slug: 'acme/trunc', visibility: 'public' });
    const changes = [];
    for (let i = 0; i < 10; i++) {
      changes.push({ path: `f${i}.txt`, op: 'add' as const, content_b64: b64(`f${i}`) });
    }
    const root = (
      await commitChanges(dbEnv, repo.id, {
        first_parent: null,
        message: 'root',
        author,
        changes,
      })
    ).changeset;
    const diff = await diffRevisions(dbEnv, repo.id, root.id, root.id, {
      mode: 'direct',
      maxFiles: 3,
    });
    // identical trees → empty diff; use base-less instead
    const from = root;
    const child = (
      await commitChanges(dbEnv, repo.id, {
        first_parent: root.id,
        message: 'delete all',
        author,
        changes: changes.map((ch) => ({ path: ch.path, op: 'del' as const })),
      })
    ).changeset;
    const del = await diffRevisions(dbEnv, repo.id, from.id, child.id, {
      mode: 'direct',
      maxFiles: 3,
    });
    expect(del.truncated).toBe(true);
    expect(del.files).toHaveLength(3);
    expect(diff.truncated).toBe(false);
  });

  it('text diffs: binaries and oversized files excluded, hunks well-formed', async () => {
    const repo = await createRepo(dbEnv, { slug: 'acme/text', visibility: 'public' });
    const root = (
      await commitChanges(dbEnv, repo.id, {
        first_parent: null,
        message: 'root',
        author,
        changes: [
          { path: 'bin.dat', op: 'add', content_b64: btoa('\x00\x01\x02\x00\xff') },
          { path: 'big.txt', op: 'add', content_b64: b64('x\n') },
          { path: 'code.ts', op: 'add', content_b64: b64('let a = 1;\nlet b = 2;\n') },
        ],
      })
    ).changeset;
    const child = (
      await commitChanges(dbEnv, repo.id, {
        first_parent: root.id,
        message: 'change all',
        author,
        changes: [
          { path: 'bin.dat', op: 'mod', content_b64: btoa('\x00\x09\x08\x00\xfe') },
          { path: 'code.ts', op: 'mod', content_b64: b64('let a = 1;\nlet b = 3;\n') },
        ],
      })
    ).changeset;

    const diff = await diffRevisions(dbEnv, repo.id, root.id, child.id, {
      mode: 'direct',
      includeText: true,
      maxTextFileSize: 4,
    });
    const texts = diff.texts ?? [];
    // big.txt is 2 bytes but unchanged; bin.dat binary → excluded; code.ts
    // over the 4-byte limit → excluded by size
    expect(texts.map((t) => t.path)).toEqual([]);

    const withLargerCap = await diffRevisions(dbEnv, repo.id, root.id, child.id, {
      mode: 'direct',
      includeText: true,
      maxTextFileSize: 512 * 1024,
    });
    const names = (withLargerCap.texts ?? []).map((t) => t.path);
    expect(names).toContain('code.ts');
    expect(names).not.toContain('bin.dat');
    const code = (withLargerCap.texts ?? []).find((t) => t.path === 'code.ts');
    expect(code?.unified).toMatch(/^@@ -1,2 \+1,2 @@/);
    expect(code?.unified).toContain('-let b = 2;');
    expect(code?.unified).toContain('+let b = 3;');
  });

  it('renders whole-file add and del text diffs', async () => {
    const { repoId, base } = await seedBranches('acme/wholefile');
    const child = await commitChanges(dbEnv, repoId, {
      first_parent: base.id,
      message: 'swap files',
      author,
      changes: [
        { path: 'B.txt', op: 'del' },
        { path: 'NEW.txt', op: 'add', content_b64: b64('n1\n') },
      ],
    });
    const diff = await diffRevisions(dbEnv, repoId, base.id, child.changeset.id, {
      mode: 'direct',
      includeText: true,
    });
    const texts = diff.texts ?? [];
    const del = texts.find((t) => t.path === 'B.txt');
    const add = texts.find((t) => t.path === 'NEW.txt');
    expect(del?.unified).toContain('@@ -1,1 +0,0 @@');
    expect(del?.unified).toContain('-b1\n');
    expect(add?.unified).toContain('@@ -0,0 +1,1 @@');
    expect(add?.unified).toContain('+n1\n');

    // missing blobs surface as typed errors, never silent empties
    await expect(
      collectTexts(dbEnv, repoId, [
        { path: 'B.txt', kind: 'del', old_hash: 'b'.repeat(64) },
      ]),
    ).rejects.toMatchObject({ code: 'object_not_found' });
  });
});

describe('diff route', () => {
  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
  });

  it('serves three-dot diffs over HTTP with the right cache policy', async () => {
    const { base, from, to } = await seedBranches('acme/http', 'public');

    const res = await get(`/acme/http/diff?from=${from.id}&to=${to.id}&text=1`);
    expect(res.status).toBe(200);
    // the cache tier keeps signed-in reads out of shared caches
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const body = (await res.json()) as {
      merge_base: string;
      files: { path: string }[];
      texts?: { path: string }[];
    };
    expect(body.merge_base).toBe(base.id);
    expect(body.files.map((f) => f.path).sort()).toEqual(['A.txt', 'B.txt']);
    expect((body.texts ?? []).map((t) => t.path).sort()).toEqual(['A.txt', 'B.txt']);

    // ref-addressed revs are never frozen either
    const byRef = await get(`/acme/http/diff?from=ref:main&to=${to.id}`);
    expect(byRef.headers.get('cache-control')).toBe('private, no-store');
  });

  it('merge base is skip-list real; private diffs stay uncacheable', async () => {
    const auth = await loginAs(testEnv, 1, 'ada');
    const { repoId, base } = await seedBranches('acme/prov', 'private');
    const { run } = await import('../src/db/client');
    const { C, T } = await import('../src/db/schema');
    await run(
      dbEnv,
      `INSERT INTO ${T.repoMembers} (${C.repoMembers.repoId}, ${C.repoMembers.userId}, ${C.repoMembers.role}) VALUES (?, ?, 'read')`,
      [repoId, auth.userId],
    );
    // sibling branches with NO common first-parent walk through `from`… the
    // provisional walk is exercised because neither is an ancestor of the other
    const a = (
      await commitChanges(dbEnv, repoId, {
        first_parent: base.id,
        message: 'a',
        author,
        changes: [{ path: 'A.txt', op: 'mod', content_b64: b64('A\n') }],
      })
    ).changeset;
    const b = (
      await commitChanges(dbEnv, repoId, {
        first_parent: base.id,
        message: 'b',
        author,
        changes: [{ path: 'B.txt', op: 'mod', content_b64: b64('B\n') }],
      })
    ).changeset;

    const res = await makeViewerApp(testEnv)(
      new Request(`https://x/api/v1/repos/acme/prov/diff?from=${a.id}&to=${b.id}`, {
        headers: auth.headers,
      }),
    );
    expect(res.status).toBe(200);
    // provisional merge-base flags are GONE (issue #8 replaced the fallback)
    expect(res.headers.get('x-yag-provisional')).toBeNull();
    const body = (await res.json()) as { merge_base: string };
    expect(body.merge_base).toBe(base.id);
    // private repo (default) → never publicly cacheable
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('validates params and revisions at the edge', async () => {
    const { from, to } = await seedBranches('acme/diffbad');

    const missing = await get('/acme/diffbad/diff');
    expect(missing.status).toBe(400);

    const unknownRev = await get(
      `/acme/diffbad/diff?from=${from.id}&to=${'0'.repeat(64)}`,
    );
    expect(unknownRev.status).toBe(404);
    expect(((await unknownRev.json()) as { error: { code: string } }).error.code).toBe(
      'revision_not_found',
    );

    const unknownRepo = await get(`/acme/nope/diff?from=${from.id}&to=${to.id}`);
    expect(unknownRepo.status).toBe(404);
  });
});
