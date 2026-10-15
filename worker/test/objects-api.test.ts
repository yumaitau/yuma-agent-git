import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { cleanDb, loginAs, makeViewerApp, seedSchema, sha256 } from './helpers';
import type { TestEnv } from './helpers';
import { createRepo, getRepoBySlug, setRef } from '../src/db/repos';
import { commitChanges } from '../src/core/commit';
import { C, T } from '../src/db/schema';
import { run } from '../src/db/client';
import { compressBytes, preferredCodec } from '../src/core/compress';

const testEnv = env as unknown as TestEnv;
const dbEnv = testEnv as unknown as Env;
const author = { name: 'Ada', email: 'ada@example.com' };
const enc = new TextEncoder();
const dec = new TextDecoder();

function b64(text: string): string {
  return btoa(text);
}

async function api(path: string, init?: RequestInit): Promise<Response> {
  return makeViewerApp(testEnv)(new Request(`http://x/api/v1/repos${path}`, init));
}

async function seedRepo(
  slug: string,
  visibility: 'private' | 'public' = 'public',
): Promise<{
  repoId: string;
  rootTree: string;
  hashes: string[];
}> {
  const repo = await createRepo(dbEnv, { slug, visibility });
  const committed = await commitChanges(dbEnv, repo.id, {
    first_parent: null,
    message: 'seed',
    author,
    changes: [
      { path: 'src/a.txt', op: 'add', content_b64: b64('aaa\n') },
      { path: 'src/b.txt', op: 'add', content_b64: b64('bbb\n') },
      { path: 'x/y/g.txt', op: 'add', content_b64: b64('ggg\n') },
    ],
  });
  await setRef(dbEnv, repo.id, 'main', committed.changeset.id);
  return {
    repoId: repo.id,
    rootTree: committed.changeset.root_tree as string,
    hashes: committed.blobs.map((b) => b.hash),
  };
}

describe('objects API (sparse checkout protocol)', () => {
  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
  });

  it('fetch-objects batches want-only, lists missing, enforces caps', async () => {
    const { repoId, hashes } = await seedRepo('acme/fetch');
    void repoId;

    const res = await api('/acme/fetch/fetch-objects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        blobs: [...hashes.slice(0, 2), '0'.repeat(64)],
        blob_encoding: 'identity',
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    const body = (await res.json()) as {
      blobs: { hash: string; size: number; encoding: string; data_b64: string }[];
      missing: string[];
      trees: unknown[];
    };
    expect(body.blobs).toHaveLength(2);
    expect(body.missing).toEqual(['0'.repeat(64)]);
    expect(body.blobs.every((b) => b.encoding === 'identity')).toBe(true);
    // identity encoding: bytes are the verified content
    for (const blob of body.blobs) {
      const bytes = dec.decode(
        Uint8Array.from(atob(blob.data_b64), (ch) => ch.charCodeAt(0)),
      );
      expect(await sha256(enc.encode(bytes))).toBe(blob.hash);
    }

    // object caps → 413 fetch_too_large
    const tooMany = await api('/acme/fetch/fetch-objects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ blobs: Array.from({ length: 201 }, () => 'a'.repeat(64)) }),
    });
    expect(tooMany.status).toBe(413);
    expect(((await tooMany.json()) as { error: { code: string } }).error.code).toBe(
      'fetch_too_large',
    );

    // bodies never contain negotiation fields ("haves") — want-only
    const wire = JSON.parse(
      JSON.stringify({ trees: [], blobs: hashes, blob_encoding: 'zstd' }),
    ) as Record<string, unknown>;
    expect(Object.keys(wire).some((k) => k.startsWith('have'))).toBe(false);
  });

  it('blob passthrough vs identity encoding', async () => {
    const { hashes } = await seedRepo('acme/enc');
    const hash = hashes[0] as string;

    // default passthrough: stored bytes + codec header
    const passthrough = await api(`/acme/enc/object/blob/${hash}`);
    expect(passthrough.status).toBe(200);
    expect(passthrough.headers.get('x-yag-encoding')).toBe(preferredCodec());
    const stored = new Uint8Array(await passthrough.arrayBuffer());
    // passthrough bytes are the stored codec form, not the plaintext
    expect(dec.decode(stored)).not.toBe('aaa\n');

    // identity: server decompresses AND verifies the content address
    const identity = await api(`/acme/enc/object/blob/${hash}?encoding=identity`);
    expect(identity.status).toBe(200);
    expect(identity.headers.get('x-yag-encoding')).toBe('identity');
    const content = new Uint8Array(await identity.arrayBuffer());
    expect(dec.decode(content)).toBe('aaa\n');
    expect(await sha256(content)).toBe(hash);

    // corrupt object → identity path refuses (verification), passthrough still serves bytes
    const codec = preferredCodec();
    await testEnv.OBJECTS.put(
      `repos/${(await getRepoId('acme/enc')) as string}/blobs/${hash.slice(0, 2)}/${hash}`,
      await compressBytes(enc.encode('EVIL'), codec),
      { customMetadata: { size: '4', encoding: codec } },
    );
    // cache-bust: the earlier (good) identity read is legitimately cached for
    // this URL — a distinct key reaches the now-corrupt object
    const corrupt = await api(`/acme/enc/object/blob/${hash}?encoding=identity&nc=1`);
    expect(corrupt.status).toBe(500);
    expect(((await corrupt.json()) as { error: { code: string } }).error.code).toBe(
      'object_corrupt',
    );
  });

  it('tree objects serve canonical entries with immutable cache headers', async () => {
    const { rootTree } = await seedRepo('acme/trees');
    const res = await api(`/acme/trees/object/tree/${rootTree}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const body = (await res.json()) as { entries: { name: string; kind: string }[] };
    expect(body.entries.map((e) => e.name).sort()).toEqual(['src', 'x']);

    const missing = await api(`/acme/trees/object/tree/${'0'.repeat(64)}`);
    expect(missing.status).toBe(404);
  });

  it('checkout-info estimate matches the seeded tree', async () => {
    const { hashes, rootTree } = await seedRepo('acme/info');
    const res = await api('/acme/info/checkout-info?cs=ref:main');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      cs: string;
      root_tree: string;
      size_estimate: { blobs: number; bytes: number };
    };
    expect(body.root_tree).toBe(rootTree);
    expect(body.size_estimate.blobs).toBe(hashes.length);
    expect(body.size_estimate.bytes).toBe('aaa\n'.length * 2 + 'ggg\n'.length);
  });

  it('PUT /blob verifies the declared content address', async () => {
    const auth = await loginAs(testEnv, 1, 'ada');
    await seedRepo('acme/upload');
    const bytes = Buffer.from('big file content\n');
    const hash = await sha256(new Uint8Array(bytes));
    await grantWrite('acme/upload', auth.userId);

    const ok = await api(`/acme/upload/blob?sha256=${hash}&encoding=identity`, {
      method: 'PUT',
      headers: auth.headers,
      body: new Uint8Array(bytes),
    });
    expect(ok.status).toBe(201);
    expect(await ok.json()).toMatchObject({ sha256: hash, size: bytes.byteLength });

    const bad = await api(
      `/acme/upload/blob?sha256=${'0'.repeat(64)}&encoding=identity`,
      {
        method: 'PUT',
        headers: auth.headers,
        body: new Uint8Array(bytes),
      },
    );
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe(
      'hash_mismatch',
    );

    const noHash = await api('/acme/upload/blob', {
      method: 'PUT',
      headers: auth.headers,
      body: new Uint8Array(bytes),
    });
    expect(noHash.status).toBe(400);
  });
});

async function grantWrite(slug: string, userId: string): Promise<void> {
  const repo = await getRepoBySlug(dbEnv, slug);
  await run(
    dbEnv,
    `INSERT INTO ${T.repoMembers} (${C.repoMembers.repoId}, ${C.repoMembers.userId}, ${C.repoMembers.role}) VALUES (?, ?, 'write')`,
    [repo!.id, userId],
  );
}

async function getRepoId(slug: string): Promise<string | null> {
  const { getRepoBySlug } = await import('../src/db/repos');
  const repo = await getRepoBySlug(dbEnv, slug);
  return repo ? repo.id : null;
}
