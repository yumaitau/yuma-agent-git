import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { YagApi } from '../src/api';
import { ObjectCache } from '../src/cache';
import { checkout, decodeBlob } from '../src/checkout';
import { loadState, saveConfig } from '../src/config';
import { commit, status } from '../src/workcopy';

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

interface StoredBlob {
  bytes: Buffer;
  encoding: string;
}

/** In-memory yuma-agent-git API — enough surface to drive the CLI. */
class FakeServer {
  blobs = new Map<string, StoredBlob>();
  trees = new Map<string, { entries: unknown[] }>();
  refs = new Map<string, string>();
  changesets: { id: string; changes: unknown[] }[] = [];
  fetchLog: { method: string; path: string; query: string; body?: unknown }[] = [];
  corrupt = new Set<string>();
  staleRefs = false;

  rootTree = '';

  seedTree(
    entries: { name: string; kind: 'tree' | 'blob'; hash: string; size?: number }[],
  ): string {
    const payload = { entries };
    const hash = sha(new TextEncoder().encode(JSON.stringify(payload)));
    this.trees.set(hash, payload);
    return hash;
  }

  seedBlob(
    content: string,
    encoding: 'identity' | 'deflate-raw' = 'deflate-raw',
  ): string {
    const raw = Buffer.from(content, 'utf8');
    const stored = encoding === 'deflate-raw' ? deflateRawSync(raw) : raw;
    const hash = sha(raw);
    this.blobs.set(hash, { bytes: stored, encoding });
    return hash;
  }

  fetchFn = async (input: Request | string): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(input);
    const url = new URL(req.url);
    const path = url.pathname.replace('/api/v1/repos/acme/app', '');
    let body: unknown;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const text = await req.text();
      body = text ? (JSON.parse(text) as unknown) : undefined;
    }
    this.fetchLog.push({
      method: req.method,
      path,
      query: url.searchParams.toString(),
      body,
    });

    if (path === '/checkout-info') {
      return json({
        cs: 'c'.repeat(64),
        root_tree: this.rootTree,
        size_estimate: { blobs: this.blobs.size, bytes: 1 },
      });
    }
    if (path === '/fetch-objects') {
      const want = body as { trees?: string[]; blobs?: string[] };
      const trees = (want.trees ?? []).flatMap((hash) => {
        const tree = this.trees.get(hash);
        return tree
          ? [{ hash, payload_b64: Buffer.from(JSON.stringify(tree)).toString('base64') }]
          : [];
      });
      const missing: string[] = (want.trees ?? []).filter((h) => !this.trees.has(h));
      const blobs = (want.blobs ?? []).flatMap((hash) => {
        const blob = this.blobs.get(hash);
        if (!blob) return [];
        const bytes = this.corrupt.has(hash) ? Buffer.from('CORRUPTED') : blob.bytes;
        return [
          {
            hash,
            size: bytes.byteLength,
            encoding: blob.encoding,
            data_b64: bytes.toString('base64'),
          },
        ];
      });
      for (const h of want.blobs ?? []) if (!this.blobs.has(h)) missing.push(h);
      return json({ trees, blobs, missing });
    }
    if (path === '/blob' && req.method === 'PUT') {
      const bytes = Buffer.from(await req.arrayBuffer());
      const declared = url.searchParams.get('sha256') as string;
      if (sha(bytes) !== declared) {
        return json({ error: { code: 'hash_mismatch', message: 'bad hash' } }, 400);
      }
      this.blobs.set(declared, { bytes, encoding: 'identity' });
      return json({ sha256: declared, size: bytes.byteLength, deduped: false }, 201);
    }
    if (path === '/changesets' && req.method === 'POST') {
      const cs = body as { changes: unknown[] };
      const id = sha(new TextEncoder().encode(JSON.stringify(cs))).slice(0, 64);
      this.changesets.push({ id, changes: cs.changes });
      return json(
        {
          changeset: { id, root_tree: 'r'.repeat(64), changed_files: cs.changes },
          deduped: false,
        },
        201,
      );
    }
    if (path.startsWith('/refs/') && req.method === 'GET') {
      const head = this.refs.get(path.slice('/refs/'.length));
      return head
        ? json({ name: path.slice('/refs/'.length), head })
        : json({ error: { code: 'ref_not_found', message: 'no ref' } }, 404);
    }
    if (path.startsWith('/refs/') && req.method === 'PUT') {
      const name = path.slice('/refs/'.length);
      const move = body as { from: string | null; to: string };
      const current = this.refs.get(name) ?? null;
      if (this.staleRefs || current !== move.from) {
        return json(
          {
            error: {
              code: 'ref_stale',
              message: 'ref moved',
              expected: move.from,
              actual: current,
            },
          },
          409,
        );
      }
      this.refs.set(name, move.to);
      return json({ ok: true, from: move.from, to: move.to });
    }
    if (path === '/diff') {
      if (!url.searchParams.toString().includes('text=1')) {
        return json(
          { error: { code: 'invalid_request', message: 'text=1 required' } },
          400,
        );
      }
      return json({
        from: 'a'.repeat(64),
        to: 'b'.repeat(64),
        merge_base: null,
        files: [{ path: 'src/a.ts', kind: 'mod' }],
        truncated: false,
        texts: [{ path: 'src/a.ts', unified: '@@ -1 +1 @@\n-a\n+b\n' }],
      });
    }
    if (path === '/history') {
      return json({
        changesets: [{ id: 'd'.repeat(64), message: 'hello', created_at: 0, author: {} }],
      });
    }
    return json({ error: { code: 'not_found', message: path } }, 404);
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('yag CLI', () => {
  let server: FakeServer;
  let dir: string;
  let cache: ObjectCache;
  let api: YagApi;

  beforeEach(async () => {
    server = new FakeServer();
    dir = await mkdtemp(join(tmpdir(), 'yag-test-'));
    cache = new ObjectCache(`${dir}-cache`, 2 * 1024 * 1024); // outside the working copy
    api = new YagApi({
      api: 'http://api.test',
      repo: 'acme/app',
      token: 'test-token',
      fetchFn: server.fetchFn as unknown as typeof fetch,
    });
    await saveConfig(dir, { api: 'http://api.test', repo: 'acme/app' });

    // repo: src/a.ts, src/b.ts, x/y/g.txt
    const a = server.seedBlob('hello a\n');
    const b = server.seedBlob('hello b\n');
    const g = server.seedBlob('secret\n');
    const tSrc = server.seedTree([
      { name: 'a.ts', kind: 'blob', hash: a, size: 7 },
      { name: 'b.ts', kind: 'blob', hash: b, size: 7 },
    ]);
    const tY = server.seedTree([{ name: 'g.txt', kind: 'blob', hash: g, size: 7 }]);
    const tXy = server.seedTree([{ name: 'y', kind: 'tree', hash: tY }]);
    server.rootTree = server.seedTree([
      { name: 'src', kind: 'tree', hash: tSrc },
      { name: 'x', kind: 'tree', hash: tXy },
    ]);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(`${dir}-cache`, { recursive: true, force: true });
  });

  it('sparse checkout pays only for the requested prefixes (want-only)', async () => {
    const result = await checkout({
      dir,
      rev: 'ref:main',
      prefixes: ['src'],
      api,
      cache,
    });
    expect(result.files.map((f) => f.path).sort()).toEqual(['src/a.ts', 'src/b.ts']);

    // only src objects were ever requested; no haves anywhere in the wire format
    const requestedTrees = server.fetchLog
      .filter((l) => l.path === '/fetch-objects')
      .flatMap((l) => (l.body as { trees?: string[]; blobs?: string[] }).trees ?? []);
    const requestedBlobs = server.fetchLog
      .filter((l) => l.path === '/fetch-objects')
      .flatMap((l) => (l.body as { trees?: string[]; blobs?: string[] }).blobs ?? []);
    expect(requestedBlobs.sort()).toEqual(
      [sha(Buffer.from('hello a\n')), sha(Buffer.from('hello b\n'))].sort(),
    );
    // the x/y subtree was never asked for
    for (const entry of server.trees.values()) {
      const names = (entry.entries as { name: string }[]).map((e) => e.name);
      if (names.includes('g.txt')) {
        const hash = sha(new TextEncoder().encode(JSON.stringify(entry)));
        expect(requestedTrees).not.toContain(hash);
      }
    }
    for (const log of server.fetchLog) {
      expect(log.body === undefined || !('have' in (log.body as object))).toBe(true);
    }
  });

  it('writes the working copy + state, verifies content addresses', async () => {
    const result = await checkout({ dir, rev: 'ref:main', prefixes: [], api, cache });
    expect(result.files).toHaveLength(3);
    expect(await readFile(join(dir, 'src/a.ts'), 'utf8')).toBe('hello a\n');
    expect(await readFile(join(dir, 'x/y/g.txt'), 'utf8')).toBe('secret\n');

    const state = await loadState(dir);
    expect(state.cs).toBe('c'.repeat(64));
    expect(state.entries).toHaveLength(3);
    // stored form is the server's codec (deflate-raw), decoded locally
    const cached = await cache.get(sha(Buffer.from('hello a\n')));
    expect(cached?.encoding).toBe('deflate-raw');
    expect(decodeBlob(cached!.bytes, cached!.encoding).toString('utf8')).toBe(
      'hello a\n',
    );
  });

  it('cache hits avoid refetching (resumable checkouts)', async () => {
    await checkout({ dir, rev: 'ref:main', prefixes: [], api, cache });
    const calls = server.fetchLog.filter((l) => l.path === '/fetch-objects').length;
    await checkout({ dir, rev: 'ref:main', prefixes: [], api, cache });
    const after = server.fetchLog.filter((l) => l.path === '/fetch-objects').length;
    expect(after).toBe(calls); // zero additional object fetches
  });

  it('corrupt blobs are detected, retried exactly once, then fail hard', async () => {
    const a = sha(Buffer.from('hello a\n'));
    server.corrupt.add(a);
    await expect(
      checkout({ dir, rev: 'ref:main', prefixes: ['src/a.ts'], api, cache }),
    ).rejects.toThrow(/hash verification/);
    const attempts = server.fetchLog.filter(
      (l) =>
        l.path === '/fetch-objects' &&
        (l.body as { blobs?: string[] }).blobs?.includes(a),
    );
    expect(attempts).toHaveLength(2); // original + exactly one retry
  });

  it('LRU cache evicts oldest objects past its byte cap', async () => {
    const small = new ObjectCache(join(dir, 'small-cache'), 200);
    await small.put('a'.repeat(64), Buffer.alloc(90, 1), 'identity');
    await small.put('b'.repeat(64), Buffer.alloc(90, 2), 'identity');
    await small.put('c'.repeat(64), Buffer.alloc(90, 3), 'identity');
    expect(await small.has('a'.repeat(64))).toBe(false); // evicted (LRU)
    expect(await small.has('c'.repeat(64))).toBe(true);
    expect(await small.totalBytes()).toBeLessThanOrEqual(200);
  });

  it('commit round-trips: modified files become a changeset against state.cs', async () => {
    await checkout({ dir, rev: 'ref:main', prefixes: [], api, cache });
    await writeFile(join(dir, 'src/a.ts'), 'hello a v2\n');
    await utimes(join(dir, 'src/a.ts'), new Date(), new Date(Date.now() + 10_000));

    const st = await status(dir);
    expect(st.modified).toEqual(['src/a.ts']);

    const outcome = await commit({
      dir,
      api,
      message: 'update a',
      author: { name: 'Ada', email: 'ada@example.com' },
    });
    expect(outcome.id).toHaveLength(64);
    const recorded = server.changesets[0];
    expect(recorded?.changes).toEqual([
      {
        path: 'src/a.ts',
        op: 'mod',
        content_b64: Buffer.from('hello a v2\n').toString('base64'),
      },
    ]);
    expect((await loadState(dir)).cs).toBe(outcome.id);
    expect(await status(dir)).toEqual({ modified: [], deleted: [], untracked: [] });
    await writeFile(join(dir, 'src/a.ts'), 'hello a v3\n');
    const next = await commit({
      dir,
      api,
      message: 'next edit',
      author: { name: 'Ada', email: 'ada@example.com' },
    });
    const requests = server.fetchLog.filter((entry) => entry.path === '/changesets');
    expect(requests.at(-1)?.body).toMatchObject({ first_parent: outcome.id });
    expect((await loadState(dir)).cs).toBe(next.id);
  });

  it('keeps edits made during commit upload visible as modified', async () => {
    await checkout({ dir, rev: 'ref:main', prefixes: [], api, cache });
    await writeFile(join(dir, 'src/a.ts'), 'uploaded version\n');
    await utimes(join(dir, 'src/a.ts'), new Date(), new Date(Date.now() + 10000));
    const create = api.createChangeset.bind(api);
    api.createChangeset = async (body) => {
      const result = await create(body);
      await writeFile(join(dir, 'src/a.ts'), 'edit made while uploading\n');
      return result;
    };
    await commit({
      dir,
      api,
      message: 'upload',
      author: { name: 'Ada', email: 'ada@example.com' },
    });
    expect((await status(dir)).modified).toEqual(['src/a.ts']);
  });

  it('stale ref CAS is reported so the command can exit 3', async () => {
    await checkout({ dir, rev: 'ref:main', prefixes: [], api, cache });
    await writeFile(join(dir, 'src/a.ts'), 'hello a v3\n');
    await utimes(join(dir, 'src/a.ts'), new Date(), new Date(Date.now() + 10_000));
    server.refs.set('main', 'f'.repeat(64)); // someone else landed first
    server.staleRefs = true;

    const outcome = await commit({
      dir,
      api,
      message: 'too late',
      author: { name: 'Ada', email: 'ada@example.com' },
      ref: 'main',
    });
    expect(outcome.refMoved).toBe(false);
    expect(outcome.stale).toEqual({ expected: 'c'.repeat(64), actual: 'f'.repeat(64) });
    expect((await loadState(dir)).cs).toBe(outcome.id);
  });

  it('diff asks for text=1; log walks history', async () => {
    await checkout({ dir, rev: 'ref:main', prefixes: [], api, cache });
    const diff = await api.diff('c'.repeat(64), 'ref:main');
    expect(diff.texts?.[0]?.unified).toContain('@@');
    const log = server.fetchLog.find((l) => l.path === '/diff');
    expect(log?.query).toContain('text=1');

    const history = await api.history({ cs: 'c'.repeat(64), limit: 5 });
    expect(history.changesets).toHaveLength(1);
  });
});
