import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { cleanDb, instrumentQueues, loginAs, makeApp, seedSchema } from './helpers';
import type { TestEnv } from './helpers';
import { C, T } from '../src/db/schema';
import { q1, run } from '../src/db/client';
import { createRepo, setRef } from '../src/db/repos';
import { commitChanges } from '../src/core/commit';
import { createChangeset } from '../src/core/changesets';
import { putBlob } from '../src/core/blobs';
import { putTree } from '../src/core/trees';
import { parseTar, gunzipIfNeeded } from '../src/bridge/tar';
import { exceedsExportLimits } from '../src/api/export';
import { runExportJob, startExportToGithub } from '../src/bridge/exportPush';
import { importQueue } from '../src/queues/import';
import type { GitImportMessage } from '../src/bridge/exportPush';

const testEnv = env as unknown as TestEnv;
const dbEnv = testEnv as unknown as Env;
const enc = new TextEncoder();
const author = { name: 'Ada', email: 'ada@example.com' };

async function get(path: string): Promise<Response> {
  return makeApp(testEnv)(new Request(`https://x/api/v1/repos${path}`));
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** Seed a repo through the normal commit path (5 files, nested dirs). */
async function seedFiles(slug: string): Promise<{ repoId: string; cs: string }> {
  const repo = await createRepo(dbEnv, { slug, visibility: 'public' });
  const committed = await commitChanges(dbEnv, repo.id, {
    first_parent: null,
    message: 'seed export fixture',
    author,
    changes: [
      { path: 'README.md', op: 'add', content_b64: b64('read me\n') },
      { path: 'src/a.ts', op: 'add', content_b64: b64('export const a = 1;\n') },
      { path: 'src/deep/b.ts', op: 'add', content_b64: b64('export const b = 2;\n') },
      { path: 'x/y/z.txt', op: 'add', content_b64: b64('deep\n') },
      { path: 'n.txt', op: 'add', content_b64: b64('n\n') },
    ],
  });
  await setRef(dbEnv, repo.id, 'main', committed.changeset.id);
  return { repoId: repo.id, cs: committed.changeset.id };
}

function b64(text: string): string {
  return btoa(text);
}

describe('tarball export', () => {
  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
  });

  it('streams a .tar.gz that parses back to identical paths/contents/modes', async () => {
    // hand-seeded tree: nested dirs + a symlink-mode blob + an executable
    const repo = await createRepo(dbEnv, { slug: 'acme/tarball', visibility: 'public' });
    const fileHash = (await putBlob(dbEnv, repo.id, enc.encode('real content\n'))).hash;
    const linkHash = (await putBlob(dbEnv, repo.id, enc.encode('deep/file.txt'))).hash;
    const execHash = (await putBlob(dbEnv, repo.id, enc.encode('#!/bin/sh\n'))).hash;
    const longName = `${'p'.repeat(120)}.txt`; // entry name > 100 chars → PAX
    const longHash = (await putBlob(dbEnv, repo.id, enc.encode('long\n'))).hash;
    const inner = await putTree(dbEnv, repo.id, {
      entries: [
        { name: 'file.txt', kind: 'blob', hash: fileHash, size: 13, mode: '100644' },
      ],
    });
    const root = await putTree(dbEnv, repo.id, {
      entries: [
        { name: 'deep', kind: 'tree', hash: inner.hash },
        { name: 'link', kind: 'blob', hash: linkHash, mode: '120000' },
        { name: longName, kind: 'blob', hash: longHash, size: 5, mode: '100644' },
        { name: 'run.sh', kind: 'blob', hash: execHash, size: 10, mode: '100755' },
      ],
    });
    const cs = await createChangeset(dbEnv, repo.id, {
      first_parent: null,
      parents: [],
      author,
      message: 'manual tree',
      changed_files: [{ path: 'deep/file.txt', op: 'add', hash: fileHash, size: 13 }],
      root_tree: root.hash,
    });

    const res = await get(`/acme/tarball/export/tarball?cs=${cs.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="acme-tarball-' + cs.id.slice(0, 8) + '.tar.gz"',
    );

    const gz = new Uint8Array(await res.arrayBuffer());
    const entries: { name: string; type: string; body: string; mode?: string }[] = [];
    for await (const entry of parseTar(
      await gunzipIfNeeded(
        new ReadableStream({
          start(controller) {
            controller.enqueue(gz);
            controller.close();
          },
        }),
        true,
      ),
    )) {
      entries.push({
        name: entry.name,
        type: entry.type,
        body: new TextDecoder().decode(entry.body),
        mode: entry.mode,
      });
    }

    expect(entries.map((e) => e.name).sort()).toEqual(
      [longName, 'link', 'deep/file.txt', 'run.sh'].sort(),
    );
    expect(entries.find((e) => e.name === 'deep/file.txt')?.body).toBe('real content\n');
    expect(entries.find((e) => e.name === longName)?.body).toBe('long\n');
    const link = entries.find((e) => e.name === 'link');
    expect(link?.type).toBe('symlink');
    expect(link?.body).toBe('deep/file.txt');
    expect(entries.find((e) => e.name === 'run.sh')?.mode).toContain('755');
  });

  it('refuses oversized exports and serves immutable headers for public cs revs', async () => {
    expect(exceedsExportLimits(5, 100)).toBe(false);
    expect(exceedsExportLimits(100_000, 0)).toBe(true);
    expect(exceedsExportLimits(5, 513 * 1024 * 1024)).toBe(true);

    const { cs } = await seedFiles('acme/limits');
    const res = await get(`/acme/limits/export/tarball?cs=${cs}`);
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    await res.body?.cancel();
  });
});

describe('fast-import export', () => {
  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
  });

  it('snapshot stream has valid structure and is byte-deterministic', async () => {
    const { cs } = await seedFiles('acme/fi');
    const body = async (): Promise<string> =>
      new TextDecoder().decode(
        await collect(
          (await get(`/acme/fi/export/fast-import?head=${cs}&mode=snapshot`))
            .body as ReadableStream<Uint8Array>,
        ),
      );

    const text = await body();
    expect(text).toContain('commit refs/heads/main');
    expect(text.trimEnd().endsWith('done')).toBe(true);
    expect(text.match(/^blob$/gm)).toHaveLength(5);
    expect(text).toMatch(/mark :1/);
    expect(text).toMatch(/data 8\nread me\n/);
    expect(text).toMatch(/M 100644 :\d+ README\.md/);
    expect(text).toMatch(/M 100644 :\d+ src\/deep\/b\.ts/);
    expect(text).toMatch(/committer Ada <ada@example\.com> \d+ \+0000/);

    // deterministic: same head ⇒ byte-identical
    expect(await body()).toBe(text);
  });

  it('full mode emits one commit block per changeset with 1:1 fileops; ranged works', async () => {
    const repo = await createRepo(dbEnv, { slug: 'acme/fifull', visibility: 'public' });
    let parent: string | null = null;
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await commitChanges(dbEnv, repo.id, {
        first_parent: parent,
        message: `c${i}`,
        author,
        changes:
          i === 2
            ? [{ path: 'f0.txt', op: 'del' }]
            : [{ path: `f${i}.txt`, op: 'add', content_b64: b64(`v${i}`) }],
      });
      ids.push(res.changeset.id);
      parent = res.changeset.id;
    }

    const full = await get(`/acme/fifull/export/fast-import?head=${ids[2]}&mode=full`);
    const text = new TextDecoder().decode(
      await collect(full.body as ReadableStream<Uint8Array>),
    );
    expect(text.match(/commit refs\/heads\/main/g)).toHaveLength(3);
    expect(text).toMatch(/M 100644 :\d+ f0\.txt/);
    expect(text).toMatch(/M 100644 :\d+ f1\.txt/);
    expect(text).toMatch(/D f0\.txt/); // delete op mirrors changed_files
    expect(text.match(/^from :\d+$/gm)).toHaveLength(2); // chained marks

    const ranged = await get(
      `/acme/fifull/export/fast-import?head=${ids[2]}&mode=ranged&from=${ids[0]}`,
    );
    const rangedText = new TextDecoder().decode(
      await collect(ranged.body as ReadableStream<Uint8Array>),
    );
    expect(rangedText.match(/commit refs\/heads\/main/g)).toHaveLength(2);
    expect(rangedText).toContain('c1');
    expect(rangedText).not.toContain('c0');
  });

  it('full mode keeps merges; ranged mode names outside parents by stored Git ID', async () => {
    const repo = await createRepo(dbEnv, { slug: 'acme/fimerge', visibility: 'public' });
    const commit = async (
      first: string | null,
      path: string,
      parents?: string[],
    ): Promise<string> =>
      (
        await commitChanges(dbEnv, repo.id, {
          first_parent: first,
          parents,
          message: `add ${path}`,
          author,
          changes: [{ path, op: 'add', content_b64: b64(path) }],
        })
      ).changeset.id;
    const root = await commit(null, 'root.txt');
    const main = await commit(root, 'main.txt');
    const side = await commit(root, 'side.txt');
    const merge = await commit(main, 'merge.txt', [main, side]);

    const text = async (query: string): Promise<string> =>
      new TextDecoder().decode(
        await collect(
          (await get(`/acme/fimerge/export/fast-import?head=${merge}&${query}`))
            .body as ReadableStream<Uint8Array>,
        ),
      );
    const full = await text('mode=full');
    expect(full.match(/^commit refs\/heads\/main$/gm)).toHaveLength(4);
    expect(full.match(/^merge :\d+$/gm)).toHaveLength(1);

    const ranged = await text(`mode=ranged&from=${main}`);
    const rootSha1 = (
      await q1<{ sha1: string }>(
        dbEnv,
        `SELECT sha1 FROM git_commits WHERE repo_id = ? AND cs_id = ?`,
        [repo.id, root],
      )
    )?.sha1;
    const mainSha1 = (
      await q1<{ sha1: string }>(
        dbEnv,
        `SELECT sha1 FROM git_commits WHERE repo_id = ? AND cs_id = ?`,
        [repo.id, main],
      )
    )?.sha1;
    // side + merge only; their parents outside the range are named by Git ID
    expect(ranged.match(/^commit refs\/heads\/main$/gm)).toHaveLength(2);
    expect(ranged).toContain(`from ${rootSha1}\n`);
    expect(ranged).toContain(`from ${mainSha1}\nmerge :`);
  });
});

describe('export → GitHub contents sync', () => {
  const gh: {
    files: Map<string, { sha: string; content: string }>;
    puts: { path: string; body: Record<string, unknown> }[];
    deletes: string[];
    remaining: string;
  } = { files: new Map(), puts: [], deletes: [], remaining: '5000' };
  const realFetch = globalThis.fetch;

  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
    gh.files = new Map();
    gh.puts = [];
    gh.deletes = [];
    gh.remaining = '5000';
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input as RequestInfo, init);
      const url = new URL(req.url);
      const json = (body: unknown, status = 200): Response =>
        new Response(JSON.stringify(body), {
          status,
          headers: {
            'content-type': 'application/json',
            'x-ratelimit-remaining': gh.remaining,
          },
        });
      if (url.pathname.includes('/access_tokens')) {
        return json({
          token: 't',
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        });
      }
      const contents = /^\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/.exec(url.pathname);
      if (contents) {
        const path = decodeURIComponent(contents[1] as string);
        if (req.method === 'GET') {
          const file = gh.files.get(path);
          return file
            ? json({ sha: file.sha, content: btoa(file.content) })
            : json({ message: 'Not Found' }, 404);
        }
        if (req.method === 'PUT') {
          const body = JSON.parse(await req.text()) as Record<string, unknown>;
          gh.puts.push({ path, body });
          const sha = `gh-${gh.puts.length}`;
          gh.files.set(path, { sha, content: atob(body.content as string) });
          return json(
            { content: { sha }, commit: { sha: `commit-${gh.puts.length}` } },
            201,
          );
        }
        if (req.method === 'DELETE') {
          gh.deletes.push(path);
          gh.files.delete(path);
          return json({ commit: { sha: 'del-commit' } });
        }
      }
      return json({ message: 'Not Found' }, 404);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  async function connect(slug: string): Promise<string> {
    const repo = await createRepo(dbEnv, {
      slug,
      visibility: 'public',
      githubInstallationId: 42,
      githubRepoId: 777,
    });
    return repo.id;
  }

  it('creates, updates (with sha), and deletes files on the target branch', async () => {
    const repoId = await connect('acme/sync');
    const first = await commitChanges(dbEnv, repoId, {
      first_parent: null,
      message: 'add files',
      author,
      changes: [
        { path: 'a.txt', op: 'add', content_b64: b64('a1') },
        { path: 'b.txt', op: 'add', content_b64: b64('b1') },
      ],
    });
    await setRef(dbEnv, repoId, 'main', first.changeset.id);

    const auth = await loginAs(testEnv, 1, 'syncer');
    await grantWrite(repoId, auth.userId);
    const started = await makeApp(testEnv)(
      new Request('https://x/api/v1/repos/acme/sync/export/github', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: auth.cookie },
        body: JSON.stringify({ target_branch: 'yag-sync' }),
      }),
    );
    expect(started.status).toBe(202);
    const { job_id: jobId } = (await started.json()) as { job_id: string };

    await runExportJob(dbEnv, jobId);
    expect(gh.puts.map((p) => p.path).sort()).toEqual(['a.txt', 'b.txt']);
    expect(gh.puts[0]?.body.sha).toBeUndefined(); // create — no sha
    expect(gh.puts[0]?.body.branch).toBe('yag-sync');
    expect(String(gh.puts[0]?.body.message)).toContain('add files');

    // second run: modify a.txt and delete b.txt → update carries sha, delete hits DELETE
    gh.puts = [];
    const second = await commitChanges(dbEnv, repoId, {
      first_parent: first.changeset.id,
      message: 'edit + delete',
      author,
      changes: [
        { path: 'a.txt', op: 'mod', content_b64: b64('a2') },
        { path: 'b.txt', op: 'del' },
      ],
    });
    await setRef(dbEnv, repoId, 'main', second.changeset.id);
    await runExportJob(dbEnv, jobId);

    expect(gh.puts).toHaveLength(1);
    expect(gh.puts[0]?.path).toBe('a.txt');
    expect(gh.puts[0]?.body.sha).toBe('gh-1'); // current GitHub sha on updates
    expect(gh.deletes).toEqual(['b.txt']);

    const row = await q1(dbEnv, `SELECT * FROM ${T.exportJobs} WHERE id = ?`, [jobId]);
    expect(row).toMatchObject({ status: 'done', head_cs: second.changeset.id });
  });

  it('requeues with a delay when the rate limit is tight', async () => {
    const repoId = await connect('acme/limited');
    const first = await commitChanges(dbEnv, repoId, {
      first_parent: null,
      message: 'one',
      author,
      changes: [{ path: 'a.txt', op: 'add', content_b64: b64('a') }],
    });
    await setRef(dbEnv, repoId, 'main', first.changeset.id);
    gh.remaining = '10'; // under the floor

    const jobId = (
      await startExportToGithub(dbEnv, repoId, { target_branch: 'yag-sync' })
    ).job_id;
    const probe = instrumentQueues(testEnv);
    const batch = {
      queue: 'git-import',
      messages: [
        {
          body: { type: 'export_job', job_id: jobId } satisfies GitImportMessage,
          attempts: 1,
          id: 'm0',
          timestamp: new Date(),
          ack: (): void => {},
          retry: (): void => {},
        },
      ],
      ackAll: (): void => {},
      retryAll: (): void => {},
    } as unknown as MessageBatch<GitImportMessage>;
    await importQueue(batch, probe.env);

    expect(probe.sends).toHaveLength(1);
    expect(probe.sends[0]?.body).toMatchObject({ type: 'export_job', job_id: jobId });
    const row = await q1(dbEnv, `SELECT * FROM ${T.exportJobs} WHERE id = ?`, [jobId]);
    expect(row).toMatchObject({ status: 'queued' });
    void repoId;
  });

  it('large diffs continue as queued batches (≤100 files per run)', async () => {
    const repoId = await connect('acme/batched');
    const changes = [];
    for (let i = 0; i < 120; i++) {
      changes.push({ path: `f${i}.txt`, op: 'add' as const, content_b64: b64(`c${i}`) });
    }
    const first = await commitChanges(dbEnv, repoId, {
      first_parent: null,
      message: 'many',
      author,
      changes,
    });
    await setRef(dbEnv, repoId, 'main', first.changeset.id);

    const jobId = (
      await startExportToGithub(dbEnv, repoId, { target_branch: 'yag-sync' })
    ).job_id;
    const probe = instrumentQueues(testEnv);
    await importQueue(
      {
        queue: 'git-import',
        messages: [
          {
            body: { type: 'export_job', job_id: jobId },
            attempts: 1,
            id: 'm0',
            timestamp: new Date(),
            ack: () => {},
            retry: () => {},
          },
        ],
        ackAll: () => {},
        retryAll: () => {},
      } as unknown as MessageBatch<GitImportMessage>,
      probe.env,
    );
    expect(gh.puts).toHaveLength(100);
    expect(probe.sends).toHaveLength(1); // continuation batch queued
  });
});

async function grantWrite(repoId: string, userId: string): Promise<void> {
  await run(
    dbEnv,
    `INSERT INTO ${T.repoMembers} (${C.repoMembers.repoId}, ${C.repoMembers.userId}, ${C.repoMembers.role}) VALUES (?, ?, 'write')`,
    [repoId, userId],
  );
}
