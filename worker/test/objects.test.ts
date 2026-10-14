import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { getBlob, hasBlob, putBlob, putBlobByHash, blobKey } from '../src/core/blobs';
import {
  getTree,
  getTreeRecursive,
  hashTree,
  putTree,
  resolvePath,
  treeKey,
  type Tree,
} from '../src/core/trees';
import { canonicalJson, sha256Hex } from '../src/core/hashing';
import {
  ObjectCorruptError,
  ObjectWalkLimitError,
  InvalidTreeError,
} from '../src/core/errors';
import { compressBytes, parseCodec, preferredCodec } from '../src/core/compress';

const testEnv = env as unknown as Env;
const enc = new TextEncoder();
// R2 state persists within a worker run: unique repo prefixes per run keep the
// `stored: true` first-write assertions rerun-safe.
const RUN = Date.now().toString(36);
const repo = (name: string): string => `${name}-${RUN}`;

describe('canonicalJson', () => {
  it('is deterministic regardless of key order', () => {
    const a = { b: 1, a: { z: [1, 2], y: 'x' }, c: null };
    const b = { c: null, a: { y: 'x', z: [1, 2] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"y":"x","z":[1,2]},"b":1,"c":null}');
  });

  it('keeps array order and drops undefined object values', () => {
    expect(canonicalJson({ a: [3, 2, 1], gone: undefined })).toBe('{"a":[3,2,1]}');
    expect(canonicalJson('q"uote')).toBe('"q\\"uote"');
    expect(canonicalJson(1.5)).toBe('1.5');
  });
});

describe('blobs', () => {
  it('round-trips content with compression and hash verification', async () => {
    const content = enc.encode('hello blob '.repeat(100));
    const put = await putBlob(testEnv, repo('repo-roundtrip'), content);
    expect(put.stored).toBe(true);
    expect(put.size).toBe(content.byteLength);
    expect(put.hash).toBe(await sha256Hex(content));

    const got = await getBlob(testEnv, repo('repo-roundtrip'), put.hash);
    expect(got).not.toBeNull();
    expect(got?.size).toBe(content.byteLength);
    expect(got?.content).toEqual(content);

    // object is stored compressed under an explicit, known codec
    const raw = await testEnv.OBJECTS.get(blobKey(repo('repo-roundtrip'), put.hash));
    const encoding = raw?.customMetadata?.encoding;
    expect(['zstd', 'deflate-raw']).toContain(encoding);
    expect(parseCodec(encoding)).toBe(encoding);
    const rawBytes = new Uint8Array((await raw?.arrayBuffer()) ?? new ArrayBuffer(0));
    expect(rawBytes.byteLength).toBeLessThan(content.byteLength);
  });

  it('dedupes: second put of identical content is a no-op', async () => {
    const content = enc.encode('dedupe me');
    const first = await putBlob(testEnv, repo('repo-dedupe'), content);
    const second = await putBlob(testEnv, repo('repo-dedupe'), content);
    expect(first.stored).toBe(true);
    expect(second.stored).toBe(false);
    expect(second.hash).toBe(first.hash);
  });

  it('throws ObjectCorruptError when stored bytes are garbage', async () => {
    const content = enc.encode('will be corrupted');
    const { hash } = await putBlob(testEnv, repo('repo-corrupt-a'), content);
    await testEnv.OBJECTS.put(
      blobKey(repo('repo-corrupt-a'), hash),
      'not compressed data',
    );
    await expect(getBlob(testEnv, repo('repo-corrupt-a'), hash)).rejects.toThrow(
      ObjectCorruptError,
    );
  });

  it('throws ObjectCorruptError when content does not match its address', async () => {
    const good = enc.encode('address of this');
    const evil = enc.encode('address of that');
    const hash = await sha256Hex(good);
    const compressed = await compressBytes(evil, preferredCodec());
    await testEnv.OBJECTS.put(blobKey(repo('repo-corrupt-b'), hash), compressed);
    await expect(getBlob(testEnv, repo('repo-corrupt-b'), hash)).rejects.toThrow(
      ObjectCorruptError,
    );
  });

  it('putBlobByHash verifies the declared address and records size', async () => {
    const content = enc.encode('pre-uploaded');
    const hash = await sha256Hex(content);
    const compressed = await compressBytes(content, preferredCodec());
    const put = await putBlobByHash(testEnv, repo('repo-preupload'), hash, compressed);
    expect(put).toEqual({ hash, size: content.byteLength, stored: true });

    const wrongHash = 'f'.repeat(64);
    await expect(
      putBlobByHash(testEnv, repo('repo-preupload'), wrongHash, compressed),
    ).rejects.toThrow(ObjectCorruptError);
  });

  it('hasBlob reports presence in batches', async () => {
    const a = await putBlob(testEnv, repo('repo-has'), enc.encode('a'));
    await putBlob(testEnv, repo('repo-has'), enc.encode('b'));
    const missing = '0'.repeat(64);
    const found = await hasBlob(testEnv, repo('repo-has'), [
      a.hash,
      missing,
      await sha256Hex(enc.encode('b')),
    ]);
    expect(found.has(a.hash)).toBe(true);
    expect(found.has(missing)).toBe(false);
    expect(found.size).toBe(2);
  });
});

describe('trees', () => {
  const leaf: Tree = {
    entries: [
      { name: 'file.txt', kind: 'blob', hash: 'a'.repeat(64), size: 3, mode: '100644' },
    ],
  };

  it('round-trips and hashes stably', async () => {
    const put = await putTree(testEnv, repo('repo-trees'), leaf);
    expect(put.stored).toBe(true);
    expect(put.hash).toBe(await hashTree(leaf));

    const again = await putTree(testEnv, repo('repo-trees'), {
      entries: [...leaf.entries],
    });
    expect(again.stored).toBe(false);
    expect(again.hash).toBe(put.hash);

    const got = await getTree(testEnv, repo('repo-trees'), put.hash);
    expect(got?.entries).toEqual(leaf.entries);
  });

  it('hash is order-independent for entry input order', async () => {
    const x = { name: 'a', kind: 'blob' as const, hash: 'a'.repeat(64) };
    const y = { name: 'b', kind: 'blob' as const, hash: 'b'.repeat(64) };
    expect(await hashTree({ entries: [y, x] })).toBe(await hashTree({ entries: [x, y] }));
    // but putTree demands canonical (sorted) entry order
    await expect(
      putTree(testEnv, repo('repo-order'), { entries: [y, x] }),
    ).rejects.toThrow(InvalidTreeError);
  });

  it('rejects invalid entry names and kinds', async () => {
    for (const name of ['a/b', '..', '', '.']) {
      await expect(
        putTree(testEnv, repo('repo-invalid'), {
          entries: [{ name, kind: 'blob', hash: 'a'.repeat(64) }],
        }),
      ).rejects.toThrow(InvalidTreeError);
    }
    await expect(
      putTree(testEnv, repo('repo-invalid'), {
        entries: [{ name: 'x', kind: 'sym' as unknown as 'blob', hash: 'a'.repeat(64) }],
      }),
    ).rejects.toThrow(InvalidTreeError);
    await expect(
      putTree(testEnv, repo('repo-invalid'), {
        entries: [
          { name: 'x', kind: 'blob', hash: 'a'.repeat(64) },
          { name: 'x', kind: 'blob', hash: 'b'.repeat(64) },
        ],
      }),
    ).rejects.toThrow(InvalidTreeError);
  });

  it('walks recursively (3 levels) and respects the object bound', async () => {
    const blobHash = 'c'.repeat(64);
    const level2: Tree = {
      entries: [{ name: 'deep.txt', kind: 'blob', hash: blobHash, size: 1 }],
    };
    const level2Hash = (await putTree(testEnv, repo('repo-walk'), level2)).hash;
    const level1: Tree = { entries: [{ name: 'b', kind: 'tree', hash: level2Hash }] };
    const level1Hash = (await putTree(testEnv, repo('repo-walk'), level1)).hash;
    const root: Tree = { entries: [{ name: 'a', kind: 'tree', hash: level1Hash }] };
    const rootHash = (await putTree(testEnv, repo('repo-walk'), root)).hash;

    const all = await getTreeRecursive(testEnv, repo('repo-walk'), rootHash);
    expect(all.size).toBe(3);
    expect(all.get(rootHash)?.entries[0]?.name).toBe('a');

    await expect(
      getTreeRecursive(testEnv, repo('repo-walk'), rootHash, { maxObjects: 2 }),
    ).rejects.toThrow(ObjectWalkLimitError);
  });

  it('resolvePath finds nested entries and returns null for missing paths', async () => {
    const blobHash = 'd'.repeat(64);
    const level2: Tree = {
      entries: [
        { name: 'deep.txt', kind: 'blob', hash: blobHash, size: 4 },
        { name: 'sub', kind: 'tree', hash: 'e'.repeat(64) },
      ],
    };
    const level2Hash = (await putTree(testEnv, repo('repo-paths'), level2)).hash;
    const root: Tree = {
      entries: [
        { name: 'a', kind: 'tree', hash: level2Hash },
        { name: 'top.txt', kind: 'blob', hash: 'f'.repeat(64), size: 2 },
      ],
    };
    const rootHash = (await putTree(testEnv, repo('repo-paths'), root)).hash;

    expect(await resolvePath(testEnv, repo('repo-paths'), rootHash, [])).toEqual({
      name: '',
      kind: 'tree',
      hash: rootHash,
    });
    expect(await resolvePath(testEnv, repo('repo-paths'), rootHash, ['top.txt'])).toEqual(
      {
        name: 'top.txt',
        kind: 'blob',
        hash: 'f'.repeat(64),
        size: 2,
      },
    );
    expect(
      await resolvePath(testEnv, repo('repo-paths'), rootHash, ['a', 'deep.txt']),
    ).toEqual({ name: 'deep.txt', kind: 'blob', hash: blobHash, size: 4 });
    expect(
      await resolvePath(testEnv, repo('repo-paths'), rootHash, ['a', 'nope']),
    ).toBeNull();
    expect(
      await resolvePath(testEnv, repo('repo-paths'), rootHash, ['top.txt', 'x']),
    ).toBeNull();
  });

  it('throws ObjectCorruptError for corrupt and mis-addressed trees', async () => {
    const r = repo('repo-treecorrupt');
    const tree: Tree = {
      entries: [{ name: 'f.txt', kind: 'blob', hash: 'a'.repeat(64), size: 1 }],
    };
    const { hash } = await putTree(testEnv, r, tree);

    // garbage bytes at the right key
    await testEnv.OBJECTS.put(treeKey(r, hash), 'garbage');
    await expect(getTree(testEnv, r, hash)).rejects.toThrow(ObjectCorruptError);

    // well-formed tree bytes stored under the WRONG address
    const other: Tree = {
      entries: [{ name: 'g.txt', kind: 'blob', hash: 'b'.repeat(64), size: 2 }],
    };
    const codec = preferredCodec();
    await testEnv.OBJECTS.put(
      treeKey(r, hash),
      await compressBytes(
        new TextEncoder().encode(canonicalJson({ entries: other.entries })),
        codec,
      ),
      { customMetadata: { encoding: codec } },
    );
    await expect(getTree(testEnv, r, hash)).rejects.toThrow(ObjectCorruptError);

    // a tree referencing a missing child is corruption, not silence
    const root: Tree = {
      entries: [{ name: 'missing', kind: 'tree', hash: 'c'.repeat(64) }],
    };
    const rootHash = (await putTree(testEnv, r, root)).hash;
    await expect(getTreeRecursive(testEnv, r, rootHash)).rejects.toThrow(
      ObjectCorruptError,
    );
  });
});
