import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { cleanDb, loginAs, makeApp, seedSchema, type TestEnv } from './helpers';
import {
  capturedQueue,
  driveImport,
  fakeGithub,
  installFakeGithub,
  type FakeGithub,
} from './github-fake';
import { q, q1, run } from '../src/db/client';
import { createRepo, getRef, getRepoBySlug, setRef } from '../src/db/repos';
import { commitChanges } from '../src/core/commit';
import { createApiToken } from '../src/auth/tokens';
import { createUser, linkIdentity } from '../src/auth/session';
import { commitShas } from '../src/git/upload-pack';
import {
  checkRateLimit,
  lfsPointer,
  READ_ONLY,
  rewriteReferences,
} from '../src/bridge/github-meta';
import { planChunks } from '../src/bridge/bulk-import';
import { generateNotes } from '../src/releases/notes';
import { runSecretScanSlice } from '../src/security/secrets/history';

/**
 * Bulk importer (issue #72): a whole GitHub org into a forge org, against the
 * fake github.com in github-fake.ts. Git history arrives over smart HTTP from
 * a real upload-pack, so imported SHAs must equal the source's.
 */

const testEnv = env as unknown as TestEnv;
const { env: qEnv, sent } = capturedQueue(testEnv as unknown as Env);
const app = makeApp(qEnv);
const enc = new TextEncoder();
const b64 = (text: string | Uint8Array): string =>
  btoa(typeof text === 'string' ? text : String.fromCharCode(...text));

let gh: FakeGithub;
let restore: () => void = () => {};
let admin: Awaited<ReturnType<typeof loginAs>>;

async function call(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = admin.headers,
): Promise<Response> {
  return app(
    new Request(`https://x${path}`, {
      method,
      headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const LEAKED_KEY = `AKIA${'MNOPQRSTUVWXYZ23'.split('').reverse().join('')}`;
const at = (n: number): string => new Date(1_700_000_000_000 + n * 1000).toISOString();
const user = (id: number, login: string) => ({
  id,
  login,
  avatar_url: null,
  type: 'User',
});

interface Source {
  repoId: string;
  c1: string;
  c2: string;
  c3: string;
  lfsOid: string;
  lfsBytes: Uint8Array;
}

/** A source repo served as `acme-gh/<name>`: main (2 commits), feature, a tag, an LFS pointer. */
async function seedSource(name: string): Promise<Source> {
  const repo = await createRepo(qEnv, { slug: `src/${name}`, createdBy: admin.userId });
  const token = await createApiToken(qEnv, admin.userId, { label: 'source' });
  gh.git[name] = { slug: repo.slug, authorization: `Basic ${btoa(`git:${token.raw}`)}` };
  const lfsBytes = enc.encode('large binary payload\n');
  const lfsOid = await sha256Hex(lfsBytes);
  const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${lfsOid}\nsize ${lfsBytes.length}\n`;
  const author = { name: 'Ada', email: 'ada@example.com' };
  const c1 = await commitChanges(qEnv, repo.id, {
    first_parent: null,
    message: 'root\n',
    author,
    author_tz: '+1000',
    changes: [
      { path: 'README.md', op: 'add', content_b64: b64('hello\n') },
      { path: 'bin/run.sh', op: 'add', content_b64: b64('#!/bin/sh\n'), mode: '100755' },
      { path: 'assets/big.bin', op: 'add', content_b64: b64(pointer) },
    ],
  });
  const c2 = await commitChanges(qEnv, repo.id, {
    first_parent: c1.changeset.id,
    message: 'second\n',
    author,
    changes: [{ path: 'README.md', op: 'mod', content_b64: b64('hello again\n') }],
  });
  const c3 = await commitChanges(qEnv, repo.id, {
    first_parent: c1.changeset.id,
    message: 'feature\n',
    author,
    changes: [
      { path: 'feature.txt', op: 'add', content_b64: b64('one\n') },
      // a leaked key (built at run time) for the history secret scan
      { path: 'deploy.env', op: 'add', content_b64: b64(`AWS_KEY=${LEAKED_KEY}\n`) },
    ],
  });
  await setRef(qEnv, repo.id, 'main', c2.changeset.id);
  await setRef(qEnv, repo.id, 'feature', c3.changeset.id);
  await setRef(qEnv, repo.id, 'refs/tags/v1.0', c1.changeset.id);
  const shas = await commitShas(qEnv, repo.id, [
    c1.changeset.id,
    c2.changeset.id,
    c3.changeset.id,
  ]);
  return {
    repoId: repo.id,
    c1: shas.get(c1.changeset.id) as string,
    c2: shas.get(c2.changeset.id) as string,
    c3: shas.get(c3.changeset.id) as string,
    lfsOid,
    lfsBytes,
  };
}

async function setupOrg(): Promise<void> {
  const res = await call('POST', '/api/v1/orgs', { slug: 'acme' });
  expect(res.status).toBe(201);
  await run(
    qEnv,
    `INSERT INTO installations (installation_id, account_login, account_id, repos, updated_at)
     VALUES (77, 'acme-gh', 9, '[]', ?)`,
    [Date.now()],
  );
}

async function startImport(repos?: string[]): Promise<string> {
  const res = await call('POST', '/api/v1/orgs/acme/imports', {
    source: 'github',
    github_org: 'acme-gh',
    installation_id: 77,
    ...(repos ? { repos } : {}),
  });
  expect(res.status).toBe(202);
  return ((await res.json()) as { import: { id: string } }).import.id;
}

async function countRows(sql: string, binds: unknown[]): Promise<number> {
  return (
    (await q1<{ n: number }>(qEnv, `SELECT COUNT(*) AS n FROM ${sql}`, binds))?.n ?? 0
  );
}

beforeEach(async () => {
  await seedSchema(testEnv);
  await cleanDb(testEnv);
  sent.length = 0;
  gh = fakeGithub('acme-gh');
  restore = installFakeGithub(gh, app);
  admin = await loginAs(testEnv, 1, 'admin');
  // the caller's linked GitHub account administers the source org
  gh.objects['/user/1'] = { login: 'admin-gh' };
  gh.objects['/orgs/acme-gh/memberships/admin-gh'] = { state: 'active', role: 'admin' };
  await setupOrg();
});

afterEach(() => restore());

describe('bulk import: one org end to end', () => {
  it('imports history with identical SHAs, then issues, pulls, reviews, releases and LFS', async () => {
    const src = await seedSource('app');
    const alice = await loginAs(testEnv, 1001, 'alice'); // linked GitHub identity
    const bob = await createUser(qEnv, 'bob');
    await linkIdentity(qEnv, bob.id, 'oidc:corp', 'sub-bob', 'bob@example.com');
    const ghAlice = user(1001, 'alice');
    const ghBob = user(1002, 'bob');
    const ghCarol = user(1003, 'carol');
    gh.objects['/users/bob'] = { email: 'Bob@example.com' };
    gh.objects['/users/carol'] = { email: null };

    const base = '/repos/acme-gh/app';
    gh.lists['/orgs/acme-gh/repos'] = [
      { id: 501, name: 'app', full_name: 'acme-gh/app', owner: { login: 'acme-gh' } },
      {
        id: 502,
        name: 'skipped',
        full_name: 'acme-gh/skipped',
        owner: { login: 'acme-gh' },
      },
    ];
    gh.lists[`${base}/labels`] = [
      { id: 11, name: 'bug', color: 'd73a4a', description: 'Something' },
      { id: 12, name: 'yuma:ready', color: '0e8a16', description: null },
      { id: 13, name: 'yuma:risk:medium', color: 'fbca04', description: null },
    ];
    gh.lists[`${base}/milestones`] = [
      {
        id: 21,
        number: 1,
        title: 'v1',
        description: 'first',
        state: 'open',
        due_on: at(9000),
        created_at: at(1),
      },
    ];
    const issue = (n: number, extra: Record<string, unknown>) => ({
      id: 9000 + n,
      number: n,
      title: `Issue ${n}`,
      body: '',
      state: 'open',
      state_reason: null,
      user: ghAlice,
      labels: [],
      assignees: [],
      milestone: null,
      locked: false,
      created_at: at(n),
      updated_at: at(n),
      closed_at: null,
      ...extra,
    });
    gh.lists[`${base}/issues`] = [
      issue(1, {
        body: 'See acme-gh/app#2, https://github.com/acme-gh/app/pull/3 and acme-gh/elsewhere#4',
        labels: [{ name: 'bug' }, { name: 'yuma:ready' }, { name: 'yuma:risk:medium' }],
        assignees: [ghBob],
        milestone: { id: 21 },
        sub_issues_summary: { total: 1 },
      }),
      issue(2, {
        user: ghBob,
        state: 'closed',
        state_reason: 'completed',
        closed_at: at(50),
      }),
      issue(3, { pull_request: {} }),
      issue(4, { user: ghCarol }),
    ];
    gh.lists[`${base}/issues/1/sub_issues`] = [{ id: 9002 }];
    gh.lists[`${base}/pulls`] = [
      {
        id: 301,
        number: 3,
        title: 'Feature',
        body: 'Closes #1',
        state: 'open',
        draft: false,
        user: ghAlice,
        base: { ref: 'main', sha: src.c2 },
        head: { sha: src.c3 },
        created_at: at(3),
        updated_at: at(3),
        merged_at: null,
      },
      {
        // squash-merged: the head is off main, the squash commit is main's head
        id: 305,
        number: 5,
        title: 'Squashed',
        body: '',
        state: 'closed',
        user: ghAlice,
        base: { ref: 'main', sha: src.c1 },
        head: { sha: src.c3 },
        created_at: at(4),
        updated_at: at(5),
        merged_at: at(5),
        merge_commit_sha: src.c2,
      },
    ];
    gh.lists[`${base}/pulls/5/reviews`] = [];
    gh.lists[`${base}/issues/comments`] = [
      {
        id: 401,
        body: 'on the issue',
        user: ghBob,
        created_at: at(60),
        updated_at: at(60),
        issue_url: 'https://api.github.com/repos/acme-gh/app/issues/1',
      },
      {
        id: 402,
        body: 'on the pull',
        user: ghCarol,
        created_at: at(61),
        updated_at: at(61),
        issue_url: 'https://api.github.com/repos/acme-gh/app/issues/3',
      },
    ];
    gh.lists[`${base}/pulls/3/reviews`] = [
      {
        id: 551,
        user: ghBob,
        body: 'lgtm',
        state: 'APPROVED',
        commit_id: src.c3,
        submitted_at: at(70),
      },
      { id: 552, user: ghCarol, body: '', state: 'PENDING', commit_id: src.c3 },
    ];
    const lineComment = {
      path: 'feature.txt',
      line: 1,
      start_line: null,
      original_line: 1,
      original_start_line: null,
      side: 'RIGHT',
      commit_id: src.c3,
      original_commit_id: src.c3,
      pull_request_url: 'https://api.github.com/repos/acme-gh/app/pulls/3',
    };
    gh.lists[`${base}/pulls/comments`] = [
      {
        ...lineComment,
        id: 601,
        pull_request_review_id: 551,
        user: ghBob,
        body: 'nit',
        created_at: at(71),
      },
      {
        ...lineComment,
        id: 602,
        in_reply_to_id: 601,
        pull_request_review_id: null,
        user: ghAlice,
        body: 'fixed',
        created_at: at(72),
      },
    ];
    gh.lists[`${base}/releases`] = [
      {
        id: 701,
        tag_name: 'v1.0',
        name: 'One',
        body: 'notes for acme-gh/app#1',
        draft: false,
        prerelease: false,
        target_commitish: 'main',
        author: ghAlice,
        created_at: at(80),
        published_at: at(81),
        assets: [{ id: 801, name: 'app.zip', size: 3, content_type: 'application/zip' }],
      },
    ];
    gh.assets[801] = enc.encode('zip');
    gh.lfs[src.lfsOid] = src.lfsBytes;

    const jobId = await startImport(['app']);
    expect(sent.at(-1)?.body).toEqual({ type: 'bulk_import', job_id: jobId, seq: 0 });
    expect(await driveImport(qEnv, jobId, { chunk: 1 })).toBe('done');

    // git: every ref at the same commit SHA as the source
    const repo = (await getRepoBySlug(qEnv, 'acme/app'))!;
    expect(repo).toMatchObject({ owner_kind: 'org', visibility: 'private' });
    for (const [name, sha] of [
      ['main', src.c2],
      ['feature', src.c3],
      ['refs/tags/v1.0', src.c1],
    ] as const) {
      const head = (await getRef(qEnv, repo.id, name))!.head;
      expect((await commitShas(qEnv, repo.id, [head])).get(head)).toBe(sha);
    }

    // the per-repo report
    const report = (await (
      await call('GET', `/api/v1/orgs/acme/imports/${jobId}`)
    ).json()) as {
      import: {
        status: string;
        repos: {
          github: string;
          repo: string;
          status: string;
          counts: Record<string, number>;
        }[];
      };
    };
    expect(report.import.status).toBe('done');
    expect(report.import.repos).toHaveLength(1);
    expect(report.import.repos[0]).toMatchObject({
      github: 'acme-gh/app',
      repo: 'acme/app',
      status: 'done',
      counts: {
        labels: 3,
        milestones: 1,
        issues: 3,
        sub_issue_links: 1,
        work_items: 1,
        pulls: 2,
        issue_comments: 1,
        pull_comments: 1,
        reviews: 1,
        review_threads: 1,
        review_comments: 2,
        releases: 1,
        release_assets: 1,
        lfs_pointers: 1,
        lfs_objects: 1,
        branches: 2,
        tags: 1,
        placeholder_users: 1,
      },
    });

    // issues keep numbers, authors map to users, references point at the forge org
    const issues = await q<{
      id: number;
      number: number;
      body: string;
      state: string;
      state_reason: string | null;
      author_id: string;
      milestone_id: number | null;
    }>(qEnv, 'SELECT * FROM issues WHERE repo_id = ? ORDER BY number', [repo.id]);
    expect(issues.map((i) => i.number)).toEqual([1, 2, 4]);
    const [one, two, four] = issues as [
      (typeof issues)[0],
      (typeof issues)[0],
      (typeof issues)[0],
    ];
    expect(one.body).toBe('See acme/app#2, acme/app#3 and acme-gh/elsewhere#4');
    expect(one.author_id).toBe(alice.userId);
    expect(one.milestone_id).not.toBeNull();
    expect(two).toMatchObject({
      author_id: bob.id,
      state: 'closed',
      state_reason: 'completed',
    });
    const carol = await q1<{ user_id: string; matched_by: string }>(
      qEnv,
      'SELECT user_id, matched_by FROM github_import_users WHERE github_id = 1003',
      [],
    );
    expect(carol?.matched_by).toBe('placeholder');
    expect(four.author_id).toBe(carol?.user_id);
    expect(
      await q1(qEnv, 'SELECT login, github_id FROM users WHERE id = ?', [carol?.user_id]),
    ).toEqual({ login: 'carol', github_id: 1003 });
    expect(
      (
        await q<{ matched_by: string; github_id: number }>(
          qEnv,
          'SELECT github_id, matched_by FROM github_import_users ORDER BY github_id',
          [],
        )
      ).map((r) => r.matched_by),
    ).toEqual(['identity', 'email', 'placeholder']);
    expect(
      (
        await q<{ name: string }>(
          qEnv,
          `SELECT l.name FROM issue_labels il JOIN labels l ON l.id = il.label_id
            WHERE il.issue_id = ? ORDER BY l.name`,
          [one.id],
        )
      ).map((l) => l.name),
    ).toEqual(['bug', 'yuma:ready', 'yuma:risk:medium']);
    expect(
      await q1(qEnv, 'SELECT principal FROM issue_assignees WHERE issue_id = ?', [
        one.id,
      ]),
    ).toEqual({ principal: `user:${bob.id}` });
    expect(
      await q1(qEnv, 'SELECT readiness, risk FROM work_items WHERE issue_id = ?', [
        one.id,
      ]),
    ).toEqual({ readiness: 'ready', risk: 'medium' });
    expect(await q1(qEnv, 'SELECT parent_id, child_id FROM issue_links', [])).toEqual({
      parent_id: one.id,
      child_id: two.id,
    });
    expect(
      await q1<{ last_number: number }>(
        qEnv,
        'SELECT last_number FROM repo_counters WHERE repo_id = ?',
        [repo.id],
      ),
    ).toEqual({ last_number: 5 });

    // pulls, conversation comments, reviews and line threads
    const pull = await q1<{
      id: number;
      head_cs: string;
      base_ref: string;
      state: string;
    }>(
      qEnv,
      'SELECT id, head_cs, base_ref, state FROM pull_requests WHERE repo_id = ? AND number = 3',
      [repo.id],
    );
    expect(pull).toMatchObject({
      head_cs: (await getRef(qEnv, repo.id, 'feature'))!.head,
      base_ref: 'main',
      state: 'open',
    });
    // a squash merge keeps what landed, so release notes list the pull request
    const main = (await getRef(qEnv, repo.id, 'main'))!.head;
    const tag = (await getRef(qEnv, repo.id, 'refs/tags/v1.0'))!.head;
    expect(
      await q1(
        qEnv,
        'SELECT state, merged_cs FROM pull_requests WHERE repo_id = ? AND number = 5',
        [repo.id],
      ),
    ).toEqual({ state: 'merged', merged_cs: main });
    const notes = await generateNotes(qEnv, repo, {
      tag: 'v1.1',
      target: main,
      previous: { tag: 'v1.0', cs: tag },
    });
    expect(notes.pulls).toEqual([5]);
    expect(notes.body).not.toContain('Other commits');
    expect(
      await q(
        qEnv,
        'SELECT decision, body FROM pull_reviews WHERE pull_id = ? ORDER BY id',
        [pull!.id],
      ),
    ).toEqual([
      { decision: 'comment', body: 'on the pull' },
      { decision: 'approve', body: 'lgtm' },
    ]);
    const threads = await q<{
      id: number;
      side: string;
      start_line: number;
      outdated: number;
    }>(
      qEnv,
      'SELECT id, side, start_line, outdated FROM review_threads WHERE pull_id = ?',
      [pull!.id],
    );
    expect(threads).toEqual([
      { id: threads[0]!.id, side: 'head', start_line: 1, outdated: 0 },
    ]);
    const replies = await q<{ body: string; review_id: number | null }>(
      qEnv,
      'SELECT body, review_id FROM review_comments WHERE thread_id = ? ORDER BY id',
      [threads[0]!.id],
    );
    expect(replies.map((r) => r.body)).toEqual(['nit', 'fixed']);
    expect(replies[0]!.review_id).not.toBeNull();

    // releases stored for #54, with the asset in R2
    const release = await q1<{ target_cs: string; body: string; assets: string }>(
      qEnv,
      'SELECT target_cs, body, assets FROM imported_releases WHERE repo_id = ?',
      [repo.id],
    );
    expect(release?.target_cs).toBe(
      (await getRef(qEnv, repo.id, 'refs/tags/v1.0'))!.head,
    );
    expect(release?.body).toBe('notes for acme/app#1');
    const [asset] = JSON.parse(release!.assets) as { key: string; name: string }[];
    expect(asset?.name).toBe('app.zip');
    expect(await (await qEnv.OBJECTS.get(asset!.key))?.text()).toBe('zip');
    // ...and mapped to a forge release (#54) whose asset downloads checksummed
    const listed = (await (
      await call('GET', '/api/v1/repos/acme/app/releases')
    ).json()) as {
      releases: {
        id: string;
        tag: string;
        name: string;
        body: string;
        draft: boolean;
        latest: boolean;
        created_by: string;
        published_at: number;
        assets: { id: string; name: string; size: number; sha256: string }[];
      }[];
    };
    expect(listed.releases).toHaveLength(1);
    const forgeRelease = listed.releases[0]!;
    expect(forgeRelease).toMatchObject({
      tag: 'v1.0',
      name: 'One',
      body: 'notes for acme/app#1',
      draft: false,
      latest: true,
      created_by: `user:${alice.userId}`,
      published_at: Date.parse(at(81)),
    });
    expect(forgeRelease.assets).toEqual([
      expect.objectContaining({
        name: 'app.zip',
        size: 3,
        sha256: await sha256Hex(enc.encode('zip')),
      }),
    ]);
    const download = await call(
      'GET',
      `/api/v1/repos/acme/app/releases/${forgeRelease.id}/assets/${forgeRelease.assets[0]!.id}`,
    );
    expect(download.status).toBe(200);
    expect(new TextDecoder().decode(await download.arrayBuffer())).toBe('zip');

    // LFS: the pointer's object fetched through the batch API and verified
    expect(
      await q1(qEnv, 'SELECT oid, status FROM lfs_objects WHERE repo_id = ?', [repo.id]),
    ).toEqual({ oid: src.lfsOid, status: 'stored' });
    const lfs = await qEnv.OBJECTS.get(`lfs/${repo.id}/${src.lfsOid}`);
    expect(new Uint8Array(await lfs!.arrayBuffer())).toEqual(src.lfsBytes);

    // history secret scan (#66): queued after the git phase, alerts only
    const scan = await q1<{ id: string; created_by: string }>(
      qEnv,
      'SELECT id, created_by FROM secret_scans WHERE repo_id = ?',
      [repo.id],
    );
    expect(scan?.created_by).toBe('import');
    expect(await runSecretScanSlice(qEnv, scan!.id)).toBe(true);
    expect(
      await q(qEnv, 'SELECT source, path, state FROM secret_alerts WHERE repo_id = ?', [
        repo.id,
      ]),
    ).toEqual([{ source: 'history', path: 'deploy.env', state: 'open' }]);

    // read-only installation tokens only (members: read checks the caller is a GitHub admin)
    expect(gh.tokenPermissions.length).toBeGreaterThan(0);
    for (const p of gh.tokenPermissions)
      expect([READ_ONLY, { members: 'read' }]).toContainEqual(p);
    // chunked history: commits-only plan, then one fetch per chunk
    expect(gh.calls.filter((c) => c.endsWith('/git-upload-pack')).length).toBeGreaterThan(
      3,
    );

    // audit: the import and the repo it created
    const actions = (
      await q<{ action: string }>(qEnv, 'SELECT action FROM audit_events ORDER BY id', [])
    ).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['org.import', 'repo.create']));

    // re-running the import adds nothing
    const tables = [
      'issues',
      'labels',
      'milestones',
      'pull_requests',
      'imported_releases',
      'releases',
      'release_assets',
      'work_items',
    ];
    const before = await Promise.all(
      tables.map((t) => countRows(`${t} WHERE repo_id = ?`, [repo.id])),
    );
    const reviewsBefore = await countRows('pull_reviews', []);
    const commentsBefore = await countRows('review_comments', []);
    const issueCommentsBefore = await countRows('issue_comments', []);
    const again = await startImport(['app']);
    expect(await driveImport(qEnv, again)).toBe('done');
    expect(
      await Promise.all(
        tables.map((t) => countRows(`${t} WHERE repo_id = ?`, [repo.id])),
      ),
    ).toEqual(before);
    expect(await countRows('pull_reviews', [])).toBe(reviewsBefore);
    expect(await countRows('review_comments', [])).toBe(commentsBefore);
    expect(await countRows('issue_comments', [])).toBe(issueCommentsBefore);
    expect(await countRows('repos', [])).toBe(2);
  });

  it('fails a repo whose slug is already taken, and the job ends partial', async () => {
    await seedSource('app');
    await createRepo(qEnv, {
      slug: 'acme/app',
      createdBy: admin.userId,
      ownerKind: 'org',
    });
    gh.lists['/orgs/acme-gh/repos'] = [
      { id: 501, name: 'app', full_name: 'acme-gh/app', owner: { login: 'acme-gh' } },
    ];
    const jobId = await startImport();
    expect(await driveImport(qEnv, jobId)).toBe('partial');
    const row = await q1<{ status: string; error: string }>(
      qEnv,
      'SELECT status, error FROM bulk_import_repos WHERE job_id = ?',
      [jobId],
    );
    expect(row).toMatchObject({ status: 'failed' });
    expect(row?.error).toMatch(/already exists/);
  });
});

describe('bulk import: scale, rate limits and resume', () => {
  it(
    'imports 5,000 issues through a rate limit and a dropped connection',
    { timeout: 240_000 },
    async () => {
      await seedSource('big');
      gh.lists['/orgs/acme-gh/repos'] = [
        { id: 600, name: 'big', full_name: 'acme-gh/big', owner: { login: 'acme-gh' } },
      ];
      gh.lists['/repos/acme-gh/big/labels'] = [
        { id: 1, name: 'yuma:ready', color: '0e8a16', description: null },
      ];
      gh.lists['/repos/acme-gh/big/issues'] = Array.from({ length: 5000 }, (_, i) => ({
        id: 100_000 + i,
        number: i + 1,
        title: `Issue ${i + 1}`,
        body: '',
        state: 'open',
        user: user(2000 + (i % 7), `dev${i % 7}`),
        labels: i % 10 === 0 ? [{ name: 'yuma:ready' }] : [],
        created_at: at(i),
        updated_at: at(i),
      }));
      for (let i = 0; i < 7; i++) gh.objects[`/users/dev${i}`] = { email: null };
      const reset = Math.floor(Date.now() / 1000) + 600;
      gh.faults.push(
        {
          match: /GET \/repos\/acme-gh\/big\/issues\?.*&page=10$/,
          status: 403,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
        },
        { match: /GET \/repos\/acme-gh\/big\/issues\?.*&page=30$/, throws: true },
      );

      const jobId = await startImport();
      // drive until the rate limit pauses the job
      for (let step = 0; ; step++) {
        expect(step).toBeLessThan(100);
        const job = (await q1<{ seq: number; status: string; resume_at: number | null }>(
          qEnv,
          'SELECT seq, status, resume_at FROM bulk_imports WHERE id = ?',
          [jobId],
        ))!;
        if (job.status === 'rate_limited') {
          expect(job.resume_at).toBe(reset * 1000);
          const delay = sent.at(-1)?.delaySeconds ?? 0;
          expect(delay).toBeGreaterThan(500);
          expect(delay).toBeLessThanOrEqual(600);
          break;
        }
        await driveImport(qEnv, jobId, { maxSteps: 1 }).catch(() => undefined);
      }
      expect(await countRows('issues', [])).toBe(900);

      // carry on; the dropped connection fails the repo with its checkpoint kept
      expect(await driveImport(qEnv, jobId)).toBe('partial');
      const failed = await q1<{ status: string; phase: string; error: string }>(
        qEnv,
        'SELECT status, phase, error FROM bulk_import_repos WHERE job_id = ?',
        [jobId],
      );
      expect(failed).toMatchObject({ status: 'failed', phase: 'issues' });
      expect(await countRows('issues', [])).toBe(2900);

      // resume picks up at page 30: every issue exactly once
      const resumed = await call('POST', `/api/v1/orgs/acme/imports/${jobId}/resume`);
      expect(resumed.status).toBe(202);
      expect(await driveImport(qEnv, jobId)).toBe('done');
      expect(await countRows('issues', [])).toBe(5000);
      expect(await countRows('(SELECT DISTINCT number FROM issues)', [])).toBe(5000);
      expect(await countRows("work_items WHERE readiness = 'ready'", [])).toBe(500);
      // 50 issue pages, two of them retried, plus 7 user lookups and the rest
      const issueCalls = gh.calls.filter((c) =>
        c.startsWith('GET /repos/acme-gh/big/issues?'),
      );
      expect(issueCalls).toHaveLength(52);
    },
  );

  it('pauses before the quota runs out and honours retry-after', () => {
    const now = 1_000_000;
    const ctx = { pauseUntil: null as number | null };
    checkRateLimit(
      ctx,
      new Response('[]', {
        headers: { 'x-ratelimit-remaining': '20', 'x-ratelimit-reset': '2000' },
      }),
      now,
    );
    expect(ctx.pauseUntil).toBe(2_000_000);
    expect(() =>
      checkRateLimit(
        ctx,
        new Response('', { status: 429, headers: { 'retry-after': '30' } }),
        now,
      ),
    ).toThrow(/rate limit/);
    try {
      checkRateLimit(
        ctx,
        new Response('', { status: 403, headers: { 'retry-after': '7' } }),
        now,
      );
    } catch (err) {
      expect((err as { resumeAt: number }).resumeAt).toBe(now + 7000);
    }
    // a plain 403 (no permission) is not a rate limit
    expect(() =>
      checkRateLimit(ctx, new Response('', { status: 403 }), now),
    ).not.toThrow();
  });
});

describe('bulk import: API access', () => {
  it('answers 401, 404 and 403 by caller, and validates the request', async () => {
    const anon = await call('GET', '/api/v1/orgs/acme/imports', undefined, {});
    expect(anon.status).toBe(401);
    const outsider = await loginAs(testEnv, 50, 'outsider');
    expect(
      (await call('GET', '/api/v1/orgs/acme/imports', undefined, outsider.headers))
        .status,
    ).toBe(404);
    const member = await loginAs(testEnv, 51, 'member');
    await call('PUT', '/api/v1/orgs/acme/members', {
      user_login: 'member',
      role: 'member',
    });
    const denied = await call(
      'POST',
      '/api/v1/orgs/acme/imports',
      {
        source: 'github',
        github_org: 'acme-gh',
        installation_id: 77,
      },
      member.headers,
    );
    expect(denied.status).toBe(403);
    const readToken = await createApiToken(qEnv, admin.userId, {
      label: 'ro',
      scopes: ['repo:read'],
    });
    expect(
      (
        await call('GET', '/api/v1/orgs/acme/imports', undefined, {
          authorization: `Bearer ${readToken.raw}`,
        })
      ).status,
    ).toBe(403);
    const cli = await createApiToken(qEnv, admin.userId, {
      label: 'cli',
      scopes: ['repo:read', 'repo:write'],
    });
    const bearer = { authorization: `Bearer ${cli.raw}` };
    expect(
      (await call('GET', '/api/v1/orgs/acme/imports', undefined, bearer)).status,
    ).toBe(200);
    const unknown = await call(
      'POST',
      '/api/v1/orgs/acme/imports',
      { source: 'github', github_org: 'other-gh', installation_id: 77 },
      bearer,
    );
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe(
      'unknown_installation',
    );
    const invalid = await call(
      'POST',
      '/api/v1/orgs/acme/imports',
      { source: 'gitlab', github_org: 'acme-gh', installation_id: 77 },
      bearer,
    );
    expect(invalid.status).toBe(400);
    expect(
      (await call('GET', '/api/v1/orgs/acme/imports/nope', undefined, bearer)).status,
    ).toBe(404);
    const started = await call(
      'POST',
      '/api/v1/orgs/acme/imports',
      { source: 'github', github_org: 'acme-gh', installation_id: 77 },
      bearer,
    );
    expect(started.status).toBe(202);
  });

  it('refuses an installation the caller does not administer on GitHub', async () => {
    // an unrelated user owns a fresh forge org and names someone else's installation
    const intruder = await loginAs(testEnv, 60, 'intruder');
    const own = await call('POST', '/api/v1/orgs', { slug: 'evil' }, intruder.headers);
    expect(own.status).toBe(201);
    gh.objects['/user/60'] = { login: 'intruder-gh' };
    const start = (headers: Record<string, string>) =>
      call(
        'POST',
        '/api/v1/orgs/evil/imports',
        { source: 'github', github_org: 'acme-gh', installation_id: 77 },
        headers,
      );
    const refused = await start(intruder.headers);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      'not_github_admin',
    );
    // a plain member of the GitHub org is refused too
    gh.objects['/orgs/acme-gh/memberships/intruder-gh'] = {
      state: 'active',
      role: 'member',
    };
    expect((await start(intruder.headers)).status).toBe(403);
    // and a forge user with no linked GitHub account
    const local = await createUser(qEnv, 'local');
    await run(
      qEnv,
      "INSERT INTO org_members (org_id, user_id, role) SELECT id, ?, 'owner' FROM orgs WHERE slug = 'evil'",
      [local.id],
    );
    const session = await (
      await import('../src/auth/session')
    ).createSession(qEnv, local.id);
    expect((await start({ cookie: `yag_session=${session.token}` })).status).toBe(403);
    expect(
      await q(
        qEnv,
        "SELECT id FROM bulk_imports WHERE org_id = (SELECT id FROM orgs WHERE slug = 'evil')",
      ),
    ).toEqual([]);
  });
});

describe('bulk import helpers', () => {
  it('rewrites only references to repos in the job', () => {
    const refs = { from: 'acme-gh', to: 'acme', names: new Set(['app', 'lib']) };
    expect(
      rewriteReferences(
        'acme-gh/app#1 (acme-gh/lib#2) acme-gh/other#3 x/acme-gh/app#4 ' +
          'https://github.com/acme-gh/lib/issues/5#issuecomment-1 https://github.com/acme-gh/zzz/pull/6 #7',
        refs,
      ),
    ).toBe(
      'acme/app#1 (acme/lib#2) acme-gh/other#3 x/acme-gh/app#4 acme/lib#5 https://github.com/acme-gh/zzz/pull/6 #7',
    );
  });

  it('parses LFS pointers and nothing else', () => {
    const oid = 'a'.repeat(64);
    expect(
      lfsPointer(
        enc.encode(
          `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 12\n`,
        ),
      ),
    ).toEqual({ oid, size: 12 });
    expect(lfsPointer(enc.encode('hello'))).toBeNull();
  });

  it('cuts the history into chunks, parents first', async () => {
    const { blob, commit, tree } = await import('./git-helpers');
    const t = await tree([{ name: 'a', sha: (await blob('a')).sha }]);
    const a = await commit(t.sha, [], 'a');
    const b = await commit(t.sha, [a.sha], 'b');
    const c = await commit(t.sha, [b.sha], 'c');
    const side = await commit(t.sha, [a.sha], 'side');
    const objects = new Map(
      [a, b, c, side].map((o) => [o.sha, { type: o.type, body: o.body }] as const),
    );
    expect(planChunks(objects, [c.sha, side.sha], 2)).toEqual([b.sha]);
    expect(planChunks(objects, [c.sha, side.sha], 1)).toEqual([a.sha, b.sha, c.sha]);
  });
});
