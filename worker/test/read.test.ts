import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { cleanDb, loginAs, makeApp, seedSchema, sha256 } from './helpers';
import type { TestEnv } from './helpers';
import { createRepo, setRef } from '../src/db/repos';
import { commitChanges } from '../src/core/commit';
import type { Changeset } from '../src/core/changesets';
import { putBlob } from '../src/core/blobs';
import { compressBytes, preferredCodec } from '../src/core/compress';
import { resolveRevision } from '../src/core/read';

const testEnv = env as unknown as TestEnv;
const dbEnv = testEnv as unknown as Env;
const author = { name: 'Ada', email: 'ada@example.com' };
const enc = new TextEncoder();

function b64(text: string): string {
  return btoa(text);
}

function bytesToB64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function get(path: string): Promise<Response> {
  return makeApp(testEnv)(new Request(`http://x/api/v1/repos${path}`));
}

/**
 * 3-commit history:
 *   cs1 (root): add src/app.ts='v1', docs/readme.md='doc'
 *   cs2:        mod src/app.ts='v2'
 *   cs3:        del docs/readme.md
 */
async function seedHistory(
  slug: string,
  visibility: 'private' | 'public' = 'public',
): Promise<{
  repoId: string;
  cs1: Changeset;
  cs2: Changeset;
  cs3: Changeset;
}> {
  const repo = await createRepo(dbEnv, { slug, visibility });
  const cs1 = (
    await commitChanges(dbEnv, repo.id, {
      first_parent: null,
      message: 'add app + docs',
      author,
      changes: [
        { path: 'src/app.ts', op: 'add', content_b64: b64('v1') },
        { path: 'docs/readme.md', op: 'add', content_b64: b64('doc') },
      ],
    })
  ).changeset;
  const cs2 = (
    await commitChanges(dbEnv, repo.id, {
      first_parent: cs1.id,
      message: 'bump app',
      author,
      changes: [{ path: 'src/app.ts', op: 'mod', content_b64: b64('v2') }],
    })
  ).changeset;
  const cs3 = (
    await commitChanges(dbEnv, repo.id, {
      first_parent: cs2.id,
      message: 'drop docs',
      author,
      changes: [{ path: 'docs/readme.md', op: 'del' }],
    })
  ).changeset;
  await setRef(dbEnv, repo.id, 'main', cs3.id);
  return { repoId: repo.id, cs1, cs2, cs3 };
}

describe('read RPCs', () => {
  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
  });

  it('serves file content at any revision (old / new / deleted)', async () => {
    const { cs1, cs2, cs3 } = await seedHistory('acme/files');

    const old = await get(`/acme/files/file?cs=${cs1.id}&path=src/app.ts`);
    expect(old.status).toBe(200);
    const oldBody = (await old.json()) as { content_b64: string; cs: string };
    expect(atob(oldBody.content_b64)).toBe('v1');
    expect(oldBody.cs).toBe(cs1.id);

    const fresh = await get(`/acme/files/file?cs=${cs2.id}&path=src/app.ts`);
    expect(atob(((await fresh.json()) as { content_b64: string }).content_b64)).toBe(
      'v2',
    );

    const gone = await get(`/acme/files/file?cs=${cs3.id}&path=docs/readme.md`);
    expect(gone.status).toBe(404);
    expect(((await gone.json()) as { error: { code: string } }).error.code).toBe(
      'path_not_found',
    );

    const missingRev = await get(`/acme/files/file?cs=${'0'.repeat(64)}&path=src/app.ts`);
    expect(missingRev.status).toBe(404);
    expect(((await missingRev.json()) as { error: { code: string } }).error.code).toBe(
      'revision_not_found',
    );
  });

  it('streams raw bytes with the extension content-type map', async () => {
    const repo = await createRepo(dbEnv, { slug: 'acme/raw', visibility: 'public' });
    const binary = new Uint8Array([0, 1, 2, 255, 254, 13, 10, 0, 128, 42]);
    const committed = await commitChanges(dbEnv, repo.id, {
      first_parent: null,
      message: 'binary + named files',
      author,
      changes: [
        { path: 'data/blob.bin', op: 'add', content_b64: bytesToB64(binary) },
        { path: 'conf.json', op: 'add', content_b64: b64('{"a":1}') },
        { path: 'pic.png', op: 'add', content_b64: bytesToB64(new Uint8Array([137])) },
        { path: 'LICENSE', op: 'add', content_b64: b64('mit') },
      ],
    });
    await setRef(dbEnv, repo.id, 'main', committed.changeset.id);

    const raw = await get('/acme/raw/file?format=raw&cs=ref:main&path=data/blob.bin');
    expect(raw.status).toBe(200);
    expect(raw.headers.get('content-type')).toBe('application/octet-stream');
    expect(raw.headers.get('content-disposition')).toBe('inline; filename="blob.bin"');
    expect(new Uint8Array(await raw.arrayBuffer())).toEqual(binary);

    const json = await get('/acme/raw/file?format=raw&cs=ref:main&path=conf.json');
    expect(json.headers.get('content-type')).toBe('application/json; charset=utf-8');

    const png = await get('/acme/raw/file?format=raw&cs=ref:main&path=pic.png');
    expect(png.headers.get('content-type')).toBe('image/png');

    const license = await get('/acme/raw/file?format=raw&cs=ref:main&path=LICENSE');
    expect(license.headers.get('content-type')).toBe('application/octet-stream');
  });

  it('serves one-level and recursive trees; empty dirs never exist', async () => {
    const repo = await createRepo(dbEnv, { slug: 'acme/trees', visibility: 'public' });
    const first = await commitChanges(dbEnv, repo.id, {
      first_parent: null,
      message: 'layout',
      author,
      changes: [
        { path: 'a/1.txt', op: 'add', content_b64: b64('1') },
        { path: 'a/b/2.txt', op: 'add', content_b64: b64('2') },
        { path: 'c/3.txt', op: 'add', content_b64: b64('3') },
        { path: 'd/e/f.txt', op: 'add', content_b64: b64('f') },
      ],
    });
    const head = (
      await commitChanges(dbEnv, repo.id, {
        first_parent: first.changeset.id,
        message: 'drop d/e/f.txt',
        author,
        changes: [{ path: 'd/e/f.txt', op: 'del' }],
      })
    ).changeset;

    const root = await get(`/acme/trees/tree?cs=${head.id}`);
    expect(root.status).toBe(200);
    const rootBody = (await root.json()) as {
      entries: { name: string; kind: string }[];
    };
    expect(rootBody.entries.map((e) => e.name)).toEqual(['a', 'c']);

    const nested = await get(`/acme/trees/tree?cs=${head.id}&path=a`);
    const nestedBody = (await nested.json()) as {
      entries: { name: string; kind: string }[];
    };
    expect(nestedBody.entries).toEqual([
      { name: '1.txt', kind: 'blob', hash: expect.any(String), size: 1, mode: '100644' },
      { name: 'b', kind: 'tree', hash: expect.any(String) },
    ]);

    const flat = await get(`/acme/trees/tree?cs=${head.id}&recursive=1`);
    const flatBody = (await flat.json()) as { entries: { path: string }[] };
    expect(flatBody.entries.map((e) => e.path).sort()).toEqual([
      'a',
      'a/1.txt',
      'a/b',
      'a/b/2.txt',
      'c',
      'c/3.txt',
    ]);

    // deleted dir is gone entirely (git-like: no empty trees)
    const emptyDir = await get(`/acme/trees/tree?cs=${head.id}&path=d`);
    expect(emptyDir.status).toBe(404);

    // a blob is not a directory
    const notATree = await get(`/acme/trees/tree?cs=${head.id}&path=a/1.txt`);
    expect(notATree.status).toBe(400);
    expect(((await notATree.json()) as { error: { code: string } }).error.code).toBe(
      'not_a_tree',
    );
  });

  it('resolveRevision accepts cs ids, ref: form, and bare ref names', async () => {
    const { repoId, cs3 } = await seedHistory('acme/revs');
    for (const rev of [cs3.id, 'ref:main', 'main']) {
      expect((await resolveRevision(dbEnv, repoId, rev)).id).toBe(cs3.id);
    }
    await expect(resolveRevision(dbEnv, repoId, 'nope')).rejects.toMatchObject({
      code: 'revision_not_found',
    });
    await expect(resolveRevision(dbEnv, repoId, 'release/1.0')).rejects.toMatchObject({
      code: 'revision_not_found',
    });
  });

  it('history walks first-parent; path filter served by path_history kind', async () => {
    const { cs1, cs2, cs3 } = await seedHistory('acme/history');

    const all = await get('/acme/history/history?cs=ref:main');
    expect(all.status).toBe(200);
    // short TTL even on public repos (history depends on mutable heads)
    expect(all.headers.get('cache-control')).toBe('public, max-age=10');
    const allBody = (await all.json()) as { changesets: { id: string }[] };
    expect(allBody.changesets.map((c) => c.id)).toEqual([cs3.id, cs2.id, cs1.id]);

    const byFile = await get('/acme/history/history?path=src/app.ts');
    // provisional fallback removed (issue #10) — real derived data answers
    expect(byFile.headers.get('x-yag-provisional')).toBeNull();
    const byFileBody = (await byFile.json()) as {
      changesets: { id: string }[];
      next: string | null;
      complete: boolean;
    };
    expect(byFileBody.changesets.map((c) => c.id)).toEqual([cs2.id, cs1.id]);
    expect(byFileBody.complete).toBe(true);

    const byDir = await get('/acme/history/history?path=docs/readme.md');
    const byDirBody = (await byDir.json()) as { changesets: { id: string }[] };
    expect(byDirBody.changesets.map((c) => c.id)).toEqual([cs3.id, cs1.id]);

    const limited = await get('/acme/history/history?path=src/app.ts&limit=1');
    expect(((await limited.json()) as { changesets: unknown[] }).changesets).toHaveLength(
      1,
    );
  });

  it('immutable only for content-addressed reads of PUBLIC repos', async () => {
    const { cs1 } = await seedHistory('acme/cache', 'public');

    const file = await get(`/acme/cache/file?cs=${cs1.id}&path=src/app.ts`);
    expect(file.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(file.headers.get('etag')).toMatch(new RegExp(`^"${cs1.id}-[0-9a-f]{16}"$`));

    const tree = await get(`/acme/cache/tree?cs=${cs1.id}&path=src`);
    expect(tree.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(tree.headers.get('etag')).toMatch(new RegExp(`^"${cs1.id}-[0-9a-f]{16}"$`));

    // ref-addressed revs are MUTABLE URLs — must never be frozen in caches
    const byRef = await get('/acme/cache/file?cs=ref:main&path=src/app.ts');
    expect(byRef.headers.get('cache-control')).toBe('public, max-age=10');
    expect(byRef.headers.get('cache-control')).not.toContain('immutable');

    const changed = await get(`/acme/cache/changed-paths?cs=${cs1.id}`);
    expect(changed.status).toBe(200);
    expect(changed.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    );
    const changedBody = (await changed.json()) as {
      cs: string;
      changed_files: { path: string }[];
    };
    expect(changedBody.cs).toBe(cs1.id);
    expect(changedBody.changed_files.map((f) => f.path).sort()).toEqual([
      'docs/readme.md',
      'src/app.ts',
    ]);
  });

  it('private repos are never publicly cacheable (issue #21 contract)', async () => {
    const auth = await loginAs(testEnv, 1, 'ada');
    const { cs1, repoId } = await seedHistory('acme/priv', 'private');
    // the caller is a member — authed reads of private data stay no-store
    const { run } = await import('../src/db/client');
    const { C, T } = await import('../src/db/schema');
    await run(
      dbEnv,
      `INSERT INTO ${T.repoMembers} (${C.repoMembers.repoId}, ${C.repoMembers.userId}, ${C.repoMembers.role}) VALUES (?, ?, 'read')`,
      [repoId, auth.userId],
    );
    await setRef(dbEnv, repoId, 'main', cs1.id);
    for (const path of [
      `file?cs=${cs1.id}&path=src/app.ts`,
      `tree?cs=${cs1.id}`,
      `changed-paths?cs=${cs1.id}`,
      'history?cs=ref:main',
    ]) {
      const res = await makeApp(testEnv)(
        new Request(`https://x/api/v1/repos/acme/priv/${path}`, {
          headers: auth.headers,
        }),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('private, no-store');
    }
  });

  it('413s large files on the JSON path and streams them raw', async () => {
    const repo = await createRepo(dbEnv, { slug: 'acme/big', visibility: 'public' });
    const big = new Uint8Array(9 * 1024 * 1024).fill(7);
    const put = await putBlob(dbEnv, repo.id, big);
    const committed = await commitChanges(dbEnv, repo.id, {
      first_parent: null,
      message: 'big file',
      author,
      changes: [{ path: 'big.bin', op: 'add', blob_sha256: put.hash }],
    });
    await setRef(dbEnv, repo.id, 'main', committed.changeset.id);

    const json = await get('/acme/big/file?cs=ref:main&path=big.bin');
    expect(json.status).toBe(413);
    const body = (await json.json()) as { error: { code: string; use: string } };
    expect(body.error.code).toBe('file_too_large');
    expect(body.error.use).toBe('?format=raw');

    const raw = await get('/acme/big/file?format=raw&cs=ref:main&path=big.bin');
    expect(raw.status).toBe(200);
    expect(raw.headers.get('content-length')).toBe(String(big.byteLength));
    // consume the whole stream and verify the content address byte-for-byte
    const streamed = new Uint8Array(await raw.arrayBuffer());
    expect(streamed.byteLength).toBe(big.byteLength);
    expect(await sha256(streamed)).toBe(put.hash);
  });

  it('raw reads verify the content address and abort the stream on corruption', async () => {
    const repo = await createRepo(dbEnv, { slug: 'acme/corrupt', visibility: 'public' });
    const content = enc.encode('trustworthy bytes');
    const hash = await sha256(content);
    const committed = await commitChanges(dbEnv, repo.id, {
      first_parent: null,
      message: 'file',
      author,
      changes: [{ path: 'real.txt', op: 'add', content_b64: bytesToB64(content) }],
    });
    await setRef(dbEnv, repo.id, 'main', committed.changeset.id);
    // well-formed compressed bytes of DIFFERENT content under the same address,
    // with valid codec metadata so only the hash check can catch it
    const evil = enc.encode('EVIL REPLACEMENT BYTES');
    const codec = preferredCodec();
    const compressed = await compressBytes(evil, codec);
    await testEnv.OBJECTS.put(
      `repos/${repo.id}/blobs/${hash.slice(0, 2)}/${hash}`,
      compressed,
      {
        customMetadata: { size: String(evil.byteLength), encoding: codec },
      },
    );

    const json = await get('/acme/corrupt/file?cs=ref:main&path=real.txt');
    expect(json.status).toBe(500);
    expect(((await json.json()) as { error: { code: string } }).error.code).toBe(
      'object_corrupt',
    );

    const raw = await get('/acme/corrupt/file?format=raw&cs=ref:main&path=real.txt');
    expect(raw.status).toBe(200); // headers already sent when corruption is caught
    await expect(raw.arrayBuffer()).rejects.toThrow();
  });

  it('serves active content as attachments with nosniff', async () => {
    const repo = await createRepo(dbEnv, { slug: 'acme/xss', visibility: 'public' });
    const committed = await commitChanges(dbEnv, repo.id, {
      first_parent: null,
      message: 'webby',
      author,
      changes: [
        {
          path: 'poc.html',
          op: 'add',
          content_b64: b64('<script>alert(1)</script>'),
        },
        { path: 'pic.svg', op: 'add', content_b64: b64('<svg onload="alert(1)"/>') },
        { path: 'ok.json', op: 'add', content_b64: b64('{"fine":true}') },
      ],
    });
    await setRef(dbEnv, repo.id, 'main', committed.changeset.id);

    const html = await get('/acme/xss/file?format=raw&cs=ref:main&path=poc.html');
    expect(html.headers.get('x-content-type-options')).toBe('nosniff');
    expect(html.headers.get('content-disposition')).toContain('attachment');

    const svg = await get('/acme/xss/file?format=raw&cs=ref:main&path=pic.svg');
    expect(svg.headers.get('content-disposition')).toContain('attachment');

    const json = await get('/acme/xss/file?format=raw&cs=ref:main&path=ok.json');
    expect(json.headers.get('content-disposition')).toContain('inline');
    expect(json.headers.get('x-content-type-options')).toBe('nosniff');
    await json.body?.cancel();
  });
});
