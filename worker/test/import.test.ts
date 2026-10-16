import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { gzipSync } from 'node:zlib';
import type { Env } from '../src/env';
import { cleanDb, loginAs, makeApp, seedSchema } from './helpers';
import type { TestEnv } from './helpers';
import { C, T } from '../src/db/schema';
import { parseChangesetRow, q, q1, run } from '../src/db/client';
import { createRepo } from '../src/db/repos';
import { getChangeset } from '../src/core/changesets';
import { getBlob } from '../src/core/blobs';
import { getImportJob, runImportMessage, type ImportMessage } from '../src/bridge/import';
import { importQueue } from '../src/queues/import';
import { tarEntry, tarEnd, concat } from '../src/bridge/tar';

const testEnv = env as unknown as TestEnv;
const dbEnv = testEnv as unknown as Env;
const enc = new TextEncoder();

// ---------------------------------------------------------------------------
// GitHub API stub (global fetch — tests share the worker isolate)
// ---------------------------------------------------------------------------

interface GithubState {
  head: string;
  tarball: Uint8Array;
  commits: {
    sha: string;
    message: string;
    author: { name: string; email: string; date: string };
    parents: string[];
    files: {
      filename: string;
      status: string;
      previous_filename?: string;
      sha?: string;
    }[];
  }[];
  contents: Record<string, string>; // path → text at each sha (simplified: one map)
  largeContents: Set<string>; // paths the contents API answers with encoding "none"
  blobs: Record<string, string>; // git blob sha → text (git blobs API)
  tarballs: Record<string, Uint8Array>; // per-ref tarballs (fallback: `tarball`)
  failContentsAt: Set<number>; // 1-based contents call index to fail
  compareCommits: string[]; // shas returned by compare (incremental sync)
  contentsCalls: number;
  calls: string[];
}

const gh: GithubState = {
  head: '',
  tarball: new Uint8Array(),
  commits: [],
  contents: {},
  largeContents: new Set(),
  blobs: {},
  tarballs: {},
  failContentsAt: new Set(),
  compareCommits: [],
  contentsCalls: 0,
  calls: [],
};

const realFetch = globalThis.fetch;

/** GitHub's /commits shape: everything nests under `commit`. */
function githubShape(entry: GithubState['commits'][number]): unknown {
  return {
    sha: entry.sha,
    commit: { message: entry.message, author: entry.author },
    parents: entry.parents.map((p) => ({ sha: p })),
    files: entry.files,
  };
}

function mockGithub(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as RequestInfo, init);
    const url = new URL(req.url);
    gh.calls.push(`${req.method} ${url.pathname}${url.search}`);
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    if (url.pathname.includes('/access_tokens')) {
      return json({
        token: 'inst-token',
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      });
    }
    const tarball = /^\/repos\/[^/]+\/[^/]+\/tarball\/([^/]+)$/.exec(url.pathname);
    if (tarball) {
      return new Response(
        (gh.tarballs[tarball[1] as string] ?? gh.tarball) as unknown as BodyInit,
        {
          status: 200,
          headers: { 'content-type': 'application/x-gzip' },
        },
      );
    }
    const compare = /^\/repos\/[^/]+\/[^/]+\/compare\/(.+)\.\.\.(.+)$/.exec(url.pathname);
    if (compare) {
      return json({
        commits: gh.compareCommits.map((sha) =>
          githubShape(gh.commits.find((c) => c.sha === sha)!),
        ),
      });
    }
    const contents = /^\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/.exec(url.pathname);
    if (contents) {
      const path = decodeURIComponent(contents[1] as string);
      gh.contentsCalls++;
      if (gh.failContentsAt.has(gh.contentsCalls)) {
        gh.failContentsAt.delete(gh.contentsCalls);
        throw new Error('simulated network failure');
      }
      const text = gh.contents[path];
      if (text !== undefined && gh.largeContents.has(path)) {
        const sha = Object.keys(gh.blobs).find((k) => gh.blobs[k] === text);
        return json({ content: '', encoding: 'none', size: text.length, sha });
      }
      return text === undefined
        ? json({ message: 'Not Found' }, 404)
        : json({ content: btoa(text), encoding: 'base64' });
    }
    const blob = /^\/repos\/[^/]+\/[^/]+\/git\/blobs\/([^/]+)$/.exec(url.pathname);
    if (blob) {
      const text = gh.blobs[blob[1] as string];
      return text === undefined
        ? json({ message: 'Not Found' }, 404)
        : json({ content: btoa(text), encoding: 'base64', size: text.length });
    }
    const commitDetail = /^\/repos\/[^/]+\/[^/]+\/commits\/([^/]+)$/.exec(url.pathname);
    if (commitDetail) {
      const ref = commitDetail[1] as string;
      // unknown refs resolve to the branch head, like GitHub
      const entry =
        gh.commits.find((c) => c.sha === ref) ?? gh.commits[gh.commits.length - 1];
      if (!entry) return json({ message: 'Not Found' }, 404);
      // GitHub pages the file list 300 at a time with a Link header
      const page = Number(url.searchParams.get('page') ?? '1');
      const shaped = githubShape(entry) as { files: unknown[] };
      const res = json({
        ...shaped,
        files: entry.files.slice((page - 1) * 300, page * 300),
      });
      if (entry.files.length > page * 300) {
        res.headers.set(
          'link',
          `<https://api.github.com${url.pathname}?page=${page + 1}>; rel="next"`,
        );
      }
      return res;
    }
    if (/\/commits$/.test(url.pathname)) {
      // newest first, like GitHub
      return json([...gh.commits].reverse().map(githubShape));
    }
    return json({ message: 'Not Found' }, 404);
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

function snapshotTarball(files: Record<string, string>): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const [path, content] of Object.entries(files)) {
    chunks.push(tarEntry(`acme-app-abc123/${path}`, enc.encode(content)));
  }
  chunks.push(tarEnd());
  return concat(chunks);
}

function seedGithubRepo(slug: string): Promise<Awaited<ReturnType<typeof createRepo>>> {
  return createRepo(dbEnv, {
    slug,
    visibility: 'public',
    githubInstallationId: 42,
    githubRepoId: 777,
    createdBy: 'importer',
  });
}

async function runJob(jobId: string, repoId: string): Promise<void> {
  await runImportMessage(dbEnv, {
    type: 'import_job',
    job_id: jobId,
  } satisfies ImportMessage);
  void repoId;
}

describe('tar-based snapshot import', () => {
  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
    mockGithub();
    gh.calls = [];
    gh.contentsCalls = 0;
    gh.failContentsAt.clear();
  });

  it('imports a tarball as a root changeset and lands main', async () => {
    const repo = await seedGithubRepo('acme/app');
    gh.tarball = gzipSync(
      Buffer.from(
        snapshotTarball({
          'src/a.txt': 'aaa\n',
          'docs/readme.md': 'hello docs\n',
        }),
      ),
    ) as unknown as Uint8Array;
    gh.commits = [
      {
        sha: 'a'.repeat(40),
        message: 'head',
        author: { name: 'Ada', email: 'ada@x', date: '2024-01-01T00:00:00Z' },
        parents: [],
        files: [],
      },
    ];

    const jobId = await startImportAs('acme/app');
    await runJob(jobId, repo.id);

    const job = await getImportJob(dbEnv, repo.id, jobId);
    expect(job.status).toBe('done');
    expect(job.commits_done).toBe(1);
    expect((job.checkpoint as { github_sha?: string }).github_sha).toBe('a'.repeat(40));
    // the imported history is queued for a secret scan (#66)
    expect(
      await q1(dbEnv, 'SELECT id FROM secret_scans WHERE repo_id = ?', [repo.id]),
    ).not.toBeNull();

    // main landed at the snapshot root; content byte-identical through the RPC
    const head = (await q1(
      dbEnv,
      `SELECT ${C.refs.head} FROM ${T.refs} WHERE ${C.refs.repoId} = ? AND ${C.refs.name} = 'main'`,
      [repo.id],
    )) as { head: string };
    const cs = await getChangeset(dbEnv, repo.id, head.head);
    expect(cs?.first_parent).toBeNull();
    expect(cs?.message).toContain('Import snapshot of github:acme/app@');
    const file = cs?.changed_files.find((f) => f.path === 'src/a.txt');
    const blob = await getBlob(dbEnv, repo.id, file?.hash as string);
    expect(new TextDecoder().decode(blob?.content as Uint8Array)).toBe('aaa\n');

    // tarball wrapper folder stripped from paths
    expect(cs?.changed_files.map((f) => f.path).sort()).toEqual([
      'docs/readme.md',
      'src/a.txt',
    ]);
  });

  it('skips oversized files with a recorded warning', async () => {
    const repo = await seedGithubRepo('acme/big');
    const huge = new Uint8Array(26 * 1024 * 1024).fill(1);
    gh.tarball = gzipSync(
      Buffer.from(
        concat([
          tarEntry('acme-app-abc123/small.txt', enc.encode('ok')),
          tarEntry('acme-app-abc123/huge.bin', huge),
          tarEnd(),
        ]),
      ),
    ) as unknown as Uint8Array;
    gh.commits = [
      {
        sha: 'b'.repeat(40),
        message: 'head',
        author: { name: 'Ada', email: 'ada@x', date: '2024-01-01T00:00:00Z' },
        parents: [],
        files: [],
      },
    ];

    const started = await startImportAs('acme/big');
    await runJob(started, repo.id);
    const job = await getImportJob(dbEnv, repo.id, started);
    expect(job.status).toBe('done');
    const warnings = (job.checkpoint as { warnings: { path: string; skipped: string }[] })
      .warnings;
    expect(warnings).toEqual([
      { path: 'acme-app-abc123/huge.bin', skipped: 'too_large' },
    ]);
    const cs = await q1(
      dbEnv,
      `SELECT * FROM ${T.changesets} WHERE ${C.changesets.repoId} = ?`,
      [repo.id],
    );
    expect(parseChangesetRow(cs).changed_files.map((f) => f.path)).toEqual(['small.txt']);
  });
});

describe('full-history import', () => {
  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
    mockGithub();
    gh.calls = [];
  });

  function linearCommits(): void {
    gh.commits = [
      {
        sha: 'c1'.padEnd(40, '0'),
        message: 'first',
        author: { name: 'Ada', email: 'ada@x', date: '2024-01-01T00:00:00Z' },
        parents: [],
        files: [{ filename: 'f.txt', status: 'added' }],
      },
      {
        sha: 'c2'.padEnd(40, '0'),
        message: 'second',
        author: { name: 'Bob', email: 'bob@x', date: '2024-02-02T00:00:00Z' },
        parents: ['c1'.padEnd(40, '0')],
        files: [{ filename: 'f.txt', status: 'modified' }],
      },
      {
        sha: 'c3'.padEnd(40, '0'),
        message: 'third',
        author: { name: 'Ada', email: 'ada@x', date: '2024-03-03T00:00:00Z' },
        parents: ['c2'.padEnd(40, '0')],
        files: [{ filename: 'g.txt', status: 'added' }],
      },
    ];
    gh.contents = { 'f.txt': 'v1', 'g.txt': 'g' };
  }

  it('imports each commit with preserved author/message/date and chains parents', async () => {
    const repo = await seedGithubRepo('acme/hist');
    linearCommits();
    // contents change per commit is stubbed globally here: v1 for add, v2 for mod
    gh.contents = { 'f.txt': 'v2', 'g.txt': 'g' };

    const jobId = await startImportAs('acme/hist', 'full_history');
    await runJob(jobId, repo.id);

    const rows = await q(
      dbEnv,
      `SELECT * FROM ${T.changesets} WHERE ${C.changesets.repoId} = ? ORDER BY ${C.changesets.createdAt}`,
      [repo.id],
    );
    const changesets = rows.map(parseChangesetRow);
    expect(changesets).toHaveLength(3);
    expect(changesets.map((c) => c.message)).toEqual(['first', 'second', 'third']);
    expect(changesets.map((c) => (c.author as { name: string }).name)).toEqual([
      'Ada',
      'Bob',
      'Ada',
    ]);
    // created_at preserves the GitHub commit date
    expect(changesets[0]?.created_at).toBe(Date.parse('2024-01-01T00:00:00Z'));
    expect(changesets[2]?.created_at).toBe(Date.parse('2024-03-03T00:00:00Z'));
    // chained: root → first_parent links
    expect(changesets[0]?.first_parent).toBeNull();
    expect(changesets[1]?.first_parent).toBe(changesets[0]?.id);
    expect(changesets[2]?.first_parent).toBe(changesets[1]?.id);

    const head = (await q1(
      dbEnv,
      `SELECT ${C.refs.head} FROM ${T.refs} WHERE ${C.refs.repoId} = ? AND ${C.refs.name} = 'main'`,
      [repo.id],
    )) as { head: string };
    expect(head.head).toBe(changesets[2]?.id);

    const job = await getImportJob(dbEnv, repo.id, jobId);
    expect(job.status).toBe('done');
    expect(job.commits_done).toBe(3);
  });

  it('resumes from the checkpoint without duplicating imported commits', async () => {
    const repo = await seedGithubRepo('acme/resume');
    linearCommits();
    gh.contents = { 'f.txt': 'v2', 'g.txt': 'g' };
    gh.contentsCalls = 0;
    gh.failContentsAt.add(2); // commit 2's contents fetch fails (commit 1 lands)

    const jobId = await startImportAs('acme/resume', 'full_history');
    await expect(runJob(jobId, repo.id)).rejects.toThrow();

    // checkpoint shows commit 1 landed
    let job = await getImportJob(dbEnv, repo.id, jobId);
    expect(job.checkpoint).toMatchObject({ cursor: 1 });

    // the queue retries — resume completes WITHOUT re-importing commit 1
    await runJob(jobId, repo.id);
    job = await getImportJob(dbEnv, repo.id, jobId);
    expect(job.status).toBe('done');
    expect(job.commits_done).toBe(3);
    const rows = await q(
      dbEnv,
      `SELECT * FROM ${T.changesets} WHERE ${C.changesets.repoId} = ?`,
      [repo.id],
    );
    expect(rows).toHaveLength(3); // no duplicates (content-addressed + cursor)
  });

  it('imports merge commits single-parent with a recorded divergence', async () => {
    const repo = await seedGithubRepo('acme/merge');
    gh.commits = [
      {
        sha: 'm1'.padEnd(40, '0'),
        message: 'merge branch',
        author: { name: 'Ada', email: 'ada@x', date: '2024-04-04T00:00:00Z' },
        parents: ['p1'.padEnd(40, '0'), 'p2'.padEnd(40, '0')],
        files: [{ filename: 'm.txt', status: 'added' }],
      },
    ];
    gh.contents = { 'm.txt': 'merged' };

    const jobId = await startImportAs('acme/merge', 'full_history');
    await runJob(jobId, repo.id);

    const row = await q1(dbEnv, `SELECT * FROM ${T.changesets}`);
    const cs = parseChangesetRow(row);
    expect(cs.parents).toEqual([]); // single-parent: the imported root
    expect(cs.first_parent).toBeNull();
    const job = await getImportJob(dbEnv, repo.id, jobId);
    expect(job.checkpoint).toMatchObject({ merge_imported_single_parent: true });
  });
});

describe('full-history import: oversized commits and large files', () => {
  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
    mockGithub();
    gh.calls = [];
    gh.contentsCalls = 0;
    gh.failContentsAt.clear();
    gh.largeContents = new Set();
    gh.blobs = {};
    gh.tarballs = {};
  });

  it('falls back to a snapshot at the commit past the file cap and records a warning', async () => {
    const repo = await seedGithubRepo('acme/huge');
    const c1 = 'h1'.padEnd(40, '0');
    const c2 = 'h2'.padEnd(40, '0');
    const c3 = 'h3'.padEnd(40, '0');
    // the big commit: 1,200 adds + one modify + one delete — beyond MAX_FILES_PER_COMMIT
    const bigFiles: Record<string, string> = { 'keep.txt': 'keep', 'edit.txt': 'v2' };
    for (let i = 0; i < 1200; i++) bigFiles[`gen/f${i}.txt`] = `g${i}`;
    gh.tarballs[c2] = gzipSync(
      Buffer.from(snapshotTarball(bigFiles)),
    ) as unknown as Uint8Array;
    gh.commits = [
      {
        sha: c1,
        message: 'base',
        author: { name: 'Ada', email: 'ada@x', date: '2024-01-01T00:00:00Z' },
        parents: [],
        files: [
          { filename: 'keep.txt', status: 'added' },
          { filename: 'edit.txt', status: 'added' },
          { filename: 'gone.txt', status: 'added' },
        ],
      },
      {
        sha: c2,
        message: 'vendor everything',
        author: { name: 'Ada', email: 'ada@x', date: '2024-02-01T00:00:00Z' },
        parents: [c1],
        files: [
          ...Object.keys(bigFiles)
            .filter((f) => f.startsWith('gen/'))
            .map((filename) => ({ filename, status: 'added' })),
          { filename: 'edit.txt', status: 'modified' },
          { filename: 'gone.txt', status: 'removed' },
        ],
      },
      {
        sha: c3,
        message: 'after',
        author: { name: 'Bob', email: 'bob@x', date: '2024-03-01T00:00:00Z' },
        parents: [c2],
        files: [{ filename: 'late.txt', status: 'added' }],
      },
    ];
    gh.contents = {
      'keep.txt': 'keep',
      'edit.txt': 'v1',
      'gone.txt': 'bye',
      'late.txt': 'l',
    };

    const jobId = await startImportAs('acme/huge', 'full_history');
    await runJob(jobId, repo.id);

    const job = await getImportJob(dbEnv, repo.id, jobId);
    expect(job.status).toBe('done');
    expect(job.commits_done).toBe(3);
    expect((job.checkpoint as { warnings: unknown[] }).warnings).toEqual([
      expect.objectContaining({ commit: c2, warning: 'snapshot_fallback' }),
    ]);
    // the file list was paged (Link rel="next") until past the cap, then the tarball
    expect(gh.calls.filter((c) => c.includes(`/commits/${c2}`))).toHaveLength(4);
    expect(gh.calls).toContain(`GET /repos/acme/huge/tarball/${c2}`);

    const rows = (
      await q(
        dbEnv,
        `SELECT * FROM ${T.changesets} WHERE ${C.changesets.repoId} = ? ORDER BY ${C.changesets.createdAt}`,
        [repo.id],
      )
    ).map(parseChangesetRow);
    expect(rows.map((r) => r.message)).toEqual(['base', 'vendor everything', 'after']);
    const big = rows[1]!;
    expect(big.first_parent).toBe(rows[0]?.id);
    // nothing dropped: every file in the commit, plus the delete and the modify
    expect(big.changed_files).toHaveLength(1202);
    expect(big.changed_files.find((f) => f.path === 'gone.txt')?.op).toBe('del');
    const edit = big.changed_files.find((f) => f.path === 'edit.txt');
    expect(edit?.op).toBe('mod');
    const editBlob = await getBlob(dbEnv, repo.id, edit?.hash as string);
    expect(new TextDecoder().decode(editBlob?.content as Uint8Array)).toBe('v2');
    expect(big.changed_files.some((f) => f.path === 'keep.txt')).toBe(false); // unchanged
    expect(rows[2]?.first_parent).toBe(big.id);
  });

  it('fetches files over 1 MiB via the git blobs API and warns on fetch failures', async () => {
    const repo = await seedGithubRepo('acme/blobs');
    gh.commits = [
      {
        sha: 'b1'.padEnd(40, '0'),
        message: 'big file',
        author: { name: 'Ada', email: 'ada@x', date: '2024-01-01T00:00:00Z' },
        parents: [],
        files: [
          { filename: 'small.txt', status: 'added' },
          { filename: 'big.bin', status: 'added', sha: 'blob-big' },
          { filename: 'missing.txt', status: 'added', sha: 'blob-missing' },
        ],
      },
    ];
    gh.contents = { 'small.txt': 's', 'big.bin': 'large payload' };
    gh.largeContents.add('big.bin'); // contents API: encoding "none"
    gh.blobs = { 'blob-big': 'large payload' };

    const jobId = await startImportAs('acme/blobs', 'full_history');
    await runJob(jobId, repo.id);

    expect(gh.calls).toContain('GET /repos/acme/blobs/git/blobs/blob-big');
    const cs = parseChangesetRow(
      await q1(dbEnv, `SELECT * FROM ${T.changesets} WHERE ${C.changesets.repoId} = ?`, [
        repo.id,
      ]),
    );
    expect(cs.changed_files.map((f) => f.path).sort()).toEqual(['big.bin', 'small.txt']);
    const big = cs.changed_files.find((f) => f.path === 'big.bin');
    const blob = await getBlob(dbEnv, repo.id, big?.hash as string);
    expect(new TextDecoder().decode(blob?.content as Uint8Array)).toBe('large payload');

    const job = await getImportJob(dbEnv, repo.id, jobId);
    expect(job.status).toBe('done');
    expect((job.checkpoint as { warnings: unknown[] }).warnings).toEqual([
      {
        commit: 'b1'.padEnd(40, '0'),
        path: 'missing.txt',
        skipped: 'fetch_failed',
        status: 404,
      },
    ]);
  });
});

describe('incremental push sync', () => {
  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
    mockGithub();
    gh.calls = [];
    gh.contentsCalls = 0;
    gh.failContentsAt.clear();
  });

  it('lands commits after the checkpoint and moves main (rebase onto current head)', async () => {
    const repo = await seedGithubRepo('acme/sync');
    linear();
    const jobId = await startImportAs('acme/sync', 'full_history');
    await runJob(jobId, repo.id);

    // a push brings one more commit
    gh.commits.push({
      sha: 'c4'.padEnd(40, '0'),
      message: 'fourth',
      author: { name: 'Ada', email: 'ada@x', date: '2024-04-04T00:00:00Z' },
      parents: ['c3'.padEnd(40, '0')],
      files: [{ filename: 'f.txt', status: 'modified' }],
    });
    gh.contents = { 'f.txt': 'v3', 'g.txt': 'g' };
    gh.compareCommits = ['c4'.padEnd(40, '0')];

    const before = (await q1(
      dbEnv,
      `SELECT ${C.refs.head} FROM ${T.refs} WHERE ${C.refs.repoId} = ? AND ${C.refs.name} = 'main'`,
      [repo.id],
    )) as { head: string };

    await runImportMessage(dbEnv, {
      type: 'github_push',
      repo_id: repo.id,
      github_repo_id: 777,
      ref: 'refs/heads/main',
      after: 'c4'.padEnd(40, '0'),
    });

    const rows = await q(
      dbEnv,
      `SELECT * FROM ${T.changesets} WHERE ${C.changesets.repoId} = ?`,
      [repo.id],
    );
    expect(rows).toHaveLength(4); // exactly one new changeset
    const after = (await q1(
      dbEnv,
      `SELECT ${C.refs.head} FROM ${T.refs} WHERE ${C.refs.repoId} = ? AND ${C.refs.name} = 'main'`,
      [repo.id],
    )) as { head: string };
    expect(after.head).not.toBe(before.head);
    const landed = await getChangeset(dbEnv, repo.id, after.head);
    expect(landed?.message).toBe('fourth');
    expect(landed?.first_parent).toBe(before.head); // rebased onto current head
  });

  function linear(): void {
    gh.commits = [
      {
        sha: 'c1'.padEnd(40, '0'),
        message: 'first',
        author: { name: 'Ada', email: 'ada@x', date: '2024-01-01T00:00:00Z' },
        parents: [],
        files: [{ filename: 'f.txt', status: 'added' }],
      },
      {
        sha: 'c2'.padEnd(40, '0'),
        message: 'second',
        author: { name: 'Bob', email: 'bob@x', date: '2024-02-02T00:00:00Z' },
        parents: ['c1'.padEnd(40, '0')],
        files: [{ filename: 'g.txt', status: 'added' }],
      },
      {
        sha: 'c3'.padEnd(40, '0'),
        message: 'third',
        author: { name: 'Ada', email: 'ada@x', date: '2024-03-03T00:00:00Z' },
        parents: ['c2'.padEnd(40, '0')],
        files: [{ filename: 'f.txt', status: 'modified' }],
      },
    ];
    gh.contents = { 'f.txt': 'v2', 'g.txt': 'g' };
  }
});

describe('queue consumer', () => {
  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
    mockGithub();
    gh.contentsCalls = 0;
    gh.failContentsAt.clear();
  });

  it('poison jobs are marked failed and acked after 3 attempts', async () => {
    const repo = await seedGithubRepo('acme/poison');
    gh.tarball = new Uint8Array(); // garbage → parse fails forever
    const jobId = await startImportAs('acme/poison', 'snapshot');

    const acked: number[] = [];
    const batch = {
      queue: 'git-import',
      messages: [
        {
          body: { type: 'import_job', job_id: jobId } satisfies ImportMessage,
          attempts: 3,
          id: 'm0',
          timestamp: new Date(),
          ack: (): void => {
            acked.push(0);
          },
          retry: (): void => {},
        },
      ],
      ackAll: (): void => {},
      retryAll: (): void => {},
    } as unknown as MessageBatch<ImportMessage>;

    await importQueue(batch, dbEnv);
    expect(acked).toEqual([0]);
    const job = await getImportJob(dbEnv, repo.id, jobId);
    expect(job.status).toBe('failed');
    expect(job.error).toBeTruthy();
  });

  it('transient failures retry the batch', async () => {
    const repo = await seedGithubRepo('acme/transient');
    gh.tarball = new Uint8Array();
    const jobId = await startImportAs('acme/transient', 'snapshot');

    let retried = false;
    const batch = {
      queue: 'git-import',
      messages: [
        {
          body: { type: 'import_job', job_id: jobId } satisfies ImportMessage,
          attempts: 1,
          id: 'm0',
          timestamp: new Date(),
          ack: (): void => {},
          retry: (): void => {},
        },
      ],
      ackAll: (): void => {},
      retryAll: (): void => {
        retried = true;
      },
    } as unknown as MessageBatch<ImportMessage>;

    await importQueue(batch, dbEnv);
    expect(retried).toBe(true);
    const job = await getImportJob(dbEnv, repo.id, jobId);
    expect(job.status).toBe('running'); // not terminally failed
    void repo;
  });
});

async function startImportAs(
  slug: string,
  mode: 'snapshot' | 'full_history' = 'snapshot',
): Promise<string> {
  const auth = await loginAs(testEnv, 1, 'importer');
  await grantWrite(slug, auth.userId);
  const res = await makeApp(testEnv)(
    new Request(`https://x/api/v1/repos/${slug}/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: auth.cookie },
      body: JSON.stringify({ source: `github:${slug}`, mode, ref: 'main' }),
    }),
  );
  if (res.status !== 202) {
    throw new Error(`import start failed: ${res.status} ${await res.text()}`);
  }
  return ((await res.json()) as { job_id: string }).job_id;
}

async function grantWrite(slug: string, userId: string): Promise<void> {
  const repo = await getRepoBySlugLocal(slug);
  await run(
    dbEnv,
    `INSERT INTO ${T.repoMembers} (${C.repoMembers.repoId}, ${C.repoMembers.userId}, ${C.repoMembers.role}) VALUES (?, ?, 'write')`,
    [repo.id, userId],
  );
  await run(
    dbEnv,
    `UPDATE ${T.repos} SET ${C.repos.githubInstallationId} = 42, ${C.repos.githubRepoId} = 777 WHERE ${C.repos.id} = ?`,
    [repo.id],
  );
}

async function getRepoBySlugLocal(
  slug: string,
): Promise<NonNullable<Awaited<ReturnType<typeof createRepo>>>> {
  const { getRepoBySlug } = await import('../src/db/repos');
  const repo = await getRepoBySlug(dbEnv, slug);
  return repo as NonNullable<typeof repo>;
}
