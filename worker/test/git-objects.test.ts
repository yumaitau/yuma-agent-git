import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import {
  cleanDb,
  instrumentDb,
  instrumentQueues,
  loginAs,
  makeApp,
  seedSchema,
} from './helpers';
import { capturedQueue, driveImport, fakeGithub, installFakeGithub } from './github-fake';
import { startBulkImport } from '../src/bridge/bulk-import';
import { getOrgBySlug } from '../src/api/orgs';
import { createApiToken } from '../src/auth/tokens';
import { commitShas } from '../src/git/upload-pack';
import type { TestEnv } from './helpers';
import { q, q1, run } from '../src/db/client';
import { C, T } from '../src/db/schema';
import { createRepo, getRef, getRepoBySlug, setRef } from '../src/db/repos';
import { putBlob } from '../src/core/blobs';
import { putTree, type TreeEntry } from '../src/core/trees';
import { commitChanges } from '../src/core/commit';
import {
  computeChangesetId,
  createChangeset,
  getChangeset,
  type Changeset,
} from '../src/core/changesets';
import { DerivedDeferredError, type DerivedMessage } from '../src/core/derived';
import {
  computeGitIds,
  ensureGitIds,
  GIT_IDS,
  MAX_WALK,
} from '../src/core/derived/gitIds';
import { derivedQueue } from '../src/queues/derived';
import {
  EMPTY_TREE,
  encodeCommit,
  gitBlobId,
  gitObjectBytes,
  gitObjectId,
  gitTreeId,
  sortTreeEntries,
  TREE_MODE,
  type GitTreeEntry,
} from '../src/git/objects';
import { agentIdFromEmail, commitSignatures, gitIdentity } from '../src/git/identity';
import {
  changesetForSha1,
  commitIdsFor,
  readGitObject,
  resolveSha1,
} from '../src/git/mapping';
import {
  GIT_HISTORY,
  GIT_HISTORY_HEAD_SHA1,
  changedFiles,
  type FixtureFile,
} from './fixtures/git-history';

const testEnv = env as unknown as TestEnv;
const dbEnv = testEnv as unknown as Env;
const enc = new TextEncoder();
const dec = new TextDecoder();
const author = { name: 'Ada', email: 'ada@example.com' };

function b64(text: string): string {
  return btoa(text);
}

/** Our trees + blobs for a file map (modes included), returning the root hash. */
async function storeTree(
  repoId: string,
  files: Record<string, FixtureFile>,
): Promise<string> {
  const dirs = new Map<string, Record<string, FixtureFile>>();
  const entries: TreeEntry[] = [];
  for (const [path, file] of Object.entries(files)) {
    const slash = path.indexOf('/');
    if (slash >= 0) {
      const dir = path.slice(0, slash);
      dirs.set(dir, { ...(dirs.get(dir) ?? {}), [path.slice(slash + 1)]: file });
      continue;
    }
    const put = await putBlob(dbEnv, repoId, enc.encode(file.content));
    entries.push({
      name: path,
      kind: 'blob',
      hash: put.hash,
      size: put.size,
      mode: file.mode ?? '100644',
    });
  }
  for (const [name, sub] of dirs) {
    entries.push({ name, kind: 'tree', hash: await storeTree(repoId, sub) });
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return (await putTree(dbEnv, repoId, { entries })).hash;
}

/** The shared fixture history as real changesets (no commit hook). */
async function seedHistory(repoId: string): Promise<Map<string, Changeset>> {
  const out = new Map<string, Changeset>();
  for (const commit of GIT_HISTORY) {
    const first = commit.parents[0];
    const parentFiles = first
      ? (GIT_HISTORY.find((c) => c.key === first)?.files ?? null)
      : null;
    const cs = await createChangeset(dbEnv, repoId, {
      first_parent: first ? (out.get(first) as Changeset).id : null,
      parents: commit.parents.map((p) => (out.get(p) as Changeset).id),
      author: commit.author,
      message: commit.message,
      changed_files: await changedFiles(parentFiles, commit.files),
      created_at: commit.created_at,
      root_tree: await storeTree(repoId, commit.files),
      committer: commit.committer,
      author_tz: commit.author_tz,
      committer_tz: commit.committer_tz,
    });
    out.set(commit.key, cs);
  }
  return out;
}

function mockBatch(bodies: DerivedMessage[]): MessageBatch<DerivedMessage> {
  return {
    queue: 'derived-data',
    messages: bodies.map((body, i) => ({
      body,
      attempts: 1,
      id: `m${i}`,
      timestamp: new Date(),
      ack: (): void => {},
      retry: (): void => {},
    })),
    ackAll: (): void => {},
    retryAll: (): void => {},
  } as unknown as MessageBatch<DerivedMessage>;
}

async function count(table: string): Promise<number> {
  const row = await q1<{ n: number }>(dbEnv, `SELECT COUNT(*) AS n FROM ${table}`);
  return row?.n ?? 0;
}

describe('git object encoders', () => {
  it('match the well-known Git IDs', async () => {
    expect(await gitBlobId(new Uint8Array())).toEqual({
      sha1: 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391',
      sha256: '473a0f4c3be8a93681a267e3b1e9a7dcda1185436fe141f7749120a303721813',
    });
    expect((await gitBlobId(enc.encode('hello world\n'))).sha1).toBe(
      '3b18e512dba79e4c8300dd08aeb37f8e728b8dad',
    );
    expect(await gitTreeId([])).toEqual(EMPTY_TREE);
    expect(dec.decode(gitObjectBytes('blob', enc.encode('hi')))).toBe('blob 2\0hi');
  });

  it("sorts entries in Git order: UTF-8 bytes, directories as if suffixed with '/'", () => {
    const ids = EMPTY_TREE;
    const entry = (name: string, mode = '100644'): GitTreeEntry => ({ name, mode, ids });
    const names = (list: GitTreeEntry[]): string[] =>
      sortTreeEntries(list).map((e) => e.name);
    expect(names([entry('a', TREE_MODE), entry('a.b'), entry('a-b')])).toEqual([
      'a-b',
      'a.b',
      'a',
    ]);
    // a file named `a` sorts before `a-b`; the directory `a` after `a.b`
    expect(names([entry('a.b'), entry('a')])).toEqual(['a', 'a.b']);
    // UTF-16 order would put the astral character first
    expect(names([entry('😀'), entry('ｗ')])).toEqual(['ｗ', '😀']);
  });

  it('encodes commits exactly: headers, continuation lines, gpgsig last', () => {
    const sig = {
      name: 'Ada',
      email: 'ada@example.com',
      seconds: 1700000000,
      tz: '+1000',
    };
    const body = encodeCommit(
      {
        tree: EMPTY_TREE,
        parents: [EMPTY_TREE],
        author: sig,
        committer: { ...sig, tz: '-0130' },
        extraHeaders: [['mergetag', 'object x\ntype commit']],
        gpgsig: '-----BEGIN SSH SIGNATURE-----\nabc\n\n-----END SSH SIGNATURE-----',
        message: 'msg\n',
      },
      'sha1',
    );
    expect(dec.decode(body)).toBe(
      [
        `tree ${EMPTY_TREE.sha1}`,
        `parent ${EMPTY_TREE.sha1}`,
        'author Ada <ada@example.com> 1700000000 +1000',
        'committer Ada <ada@example.com> 1700000000 -0130',
        'mergetag object x',
        ' type commit',
        'gpgsig -----BEGIN SSH SIGNATURE-----',
        ' abc',
        ' ',
        ' -----END SSH SIGNATURE-----',
        '',
        'msg',
        '',
      ].join('\n'),
    );
  });

  it('rejects modes Git cannot store', async () => {
    await expect(
      gitTreeId([{ name: 'x', mode: '100664', ids: EMPTY_TREE }]),
    ).rejects.toThrow(/unsupported git mode/);
  });
});

describe('git identities', () => {
  it('maps agents to a fixed, reversible identity', () => {
    const id = gitIdentity({ agent: 'agent-7' });
    expect(id).toEqual({ name: 'agent-7', email: 'agent-7@agents.yuma-agent-git' });
    expect(agentIdFromEmail(id.email)).toBe('agent-7');
    expect(agentIdFromEmail('ada@example.com')).toBeNull();
    expect(gitIdentity({ name: 'A <b>', email: '<a@b>' })).toEqual({
      name: 'A b',
      email: 'a@b',
    });
  });

  it('defaults the committer to the author and time zones to +0000', () => {
    const cs = {
      author,
      created_at: 1_700_000_000_999,
    } as Changeset;
    const { author: a, committer } = commitSignatures(cs);
    expect(a).toEqual({ ...author, seconds: 1_700_000_000, tz: '+0000' });
    expect(committer).toEqual(a);
  });
});

describe('git_ids derived kind and mapping tables', () => {
  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
  });

  it('stores the head SHA-1 that git fast-import + git rev-parse HEAD produce', async () => {
    const repo = await createRepo(dbEnv, { slug: 'acme/git-ids' });
    const history = await seedHistory(repo.id);
    const head = history.get('c5') as Changeset;

    // one call computes every ancestor first (merge parents included)
    const ids = await ensureGitIds(dbEnv, repo.id, head.id);
    expect(ids?.sha1).toBe(GIT_HISTORY_HEAD_SHA1);
    expect((await commitIdsFor(dbEnv, repo.id, head.id))?.sha1).toBe(
      GIT_HISTORY_HEAD_SHA1,
    );
    expect(await count(T.gitCommits)).toBe(GIT_HISTORY.length);
    for (const cs of history.values()) {
      const stored = await commitIdsFor(dbEnv, repo.id, cs.id);
      expect(await changesetForSha1(dbEnv, repo.id, stored?.sha1 as string)).toBe(cs.id);
    }

    // raw objects rebuild from our stores and hash back to their IDs
    const commit = await readGitObject(dbEnv, repo.id, GIT_HISTORY_HEAD_SHA1);
    expect(commit?.type).toBe('commit');
    const merge = await commitIdsFor(dbEnv, repo.id, (history.get('c4') as Changeset).id);
    expect(dec.decode(commit?.body)).toContain(`parent ${merge?.sha1}\n`);
    const mergeBody = dec.decode(
      (await readGitObject(dbEnv, repo.id, merge?.sha1 as string))?.body,
    );
    expect(mergeBody.match(/^parent /gm)).toHaveLength(2);
    expect(mergeBody).toContain('author Ada <ada@example.com> 1700000400 +0000');

    const treeSha1 = /^tree ([0-9a-f]{40})$/m.exec(
      dec.decode(commit?.body),
    )?.[1] as string;
    const tree = await readGitObject(dbEnv, repo.id, treeSha1);
    expect(tree?.type).toBe('tree');
    expect(dec.decode(tree?.body)).toContain('120000 link\0');
    expect(dec.decode(tree?.body)).toContain('40000 bin\0');

    const readme = await gitBlobId(enc.encode('hello from yag\n'));
    const blob = await readGitObject(dbEnv, repo.id, readme.sha1);
    expect(blob?.type).toBe('blob');
    expect(dec.decode(blob?.body)).toBe('hello from yag\n');
    expect(await gitObjectId('blob', blob?.body as Uint8Array, 'sha1')).toBe(readme.sha1);

    // blobs are a global index, but content only reads from the asking repo
    const other = await createRepo(dbEnv, { slug: 'acme/other' });
    expect(await readGitObject(dbEnv, other.id, readme.sha1)).toBeNull();
    expect(await readGitObject(dbEnv, other.id, GIT_HISTORY_HEAD_SHA1)).toBeNull();
    expect(await readGitObject(dbEnv, repo.id, 'f'.repeat(40))).toBeNull();
    expect((await readGitObject(dbEnv, repo.id, EMPTY_TREE.sha1))?.body).toHaveLength(0);
  });

  it('agent commits carry the agent identity', async () => {
    const repo = await createRepo(dbEnv, { slug: 'acme/git-agent' });
    const res = await commitChanges(dbEnv, repo.id, {
      first_parent: null,
      message: 'by an agent',
      author: { agent: 'agent-7' },
      changes: [{ path: 'a.txt', op: 'add', content_b64: b64('a') }],
    });
    const ids = await commitIdsFor(dbEnv, repo.id, res.changeset.id);
    const body = dec.decode(
      (await readGitObject(dbEnv, repo.id, ids?.sha1 as string))?.body,
    );
    expect(body).toMatch(/^author agent-7 <agent-7@agents\.yuma-agent-git> \d+ \+0000$/m);
  });

  it('lookups in both directions are single indexed queries', async () => {
    const repo = await createRepo(dbEnv, { slug: 'acme/git-lookup' });
    const res = await commitChanges(dbEnv, repo.id, {
      first_parent: null,
      message: 'root',
      author,
      changes: [{ path: 'a.txt', op: 'add', content_b64: b64('a') }],
    });
    const ids = await commitIdsFor(dbEnv, repo.id, res.changeset.id);

    const probe = instrumentDb(testEnv);
    expect(await commitIdsFor(probe.env, repo.id, res.changeset.id)).toEqual(ids);
    expect(await changesetForSha1(probe.env, repo.id, ids?.sha1 as string)).toBe(
      res.changeset.id,
    );
    expect(await resolveSha1(probe.env, repo.id, ids?.sha1 as string)).toEqual({
      type: 'commit',
      id: res.changeset.id,
    });
    expect(probe.prepares).toHaveLength(3);

    // and SQLite answers each from an index, never a table scan
    const plans: [string, unknown[]][] = [
      [`SELECT sha1 FROM git_commits WHERE repo_id = ? AND cs_id = ?`, ['r', 'c']],
      [`SELECT cs_id FROM git_commits WHERE repo_id = ? AND sha1 = ?`, ['r', 's']],
      [`SELECT tree_hash FROM git_trees WHERE repo_id = ? AND sha1 = ?`, ['r', 's']],
      [`SELECT sha1 FROM git_trees WHERE repo_id = ? AND tree_hash = ?`, ['r', 't']],
      [`SELECT blob_hash FROM git_blobs WHERE sha1 = ?`, ['s']],
      [`SELECT sha1 FROM git_blobs WHERE blob_hash = ?`, ['b']],
    ];
    for (const [sql, params] of plans) {
      const rows = await q<{ detail: string }>(
        dbEnv,
        `EXPLAIN QUERY PLAN ${sql}`,
        params,
      );
      const detail = rows.map((r) => r.detail).join(' | ');
      expect(detail, sql).toMatch(/USING (COVERING )?(INDEX|PRIMARY KEY)/);
      expect(detail, sql).not.toMatch(/^SCAN/);
    }
  });

  it('computes small commits eagerly in the commit path', async () => {
    const repo = await createRepo(dbEnv, { slug: 'acme/git-eager' });
    const probe = instrumentQueues(testEnv);
    const res = await commitChanges(probe.env, repo.id, {
      first_parent: null,
      message: 'root',
      author,
      changes: [{ path: 'a.txt', op: 'add', content_b64: b64('a') }],
    });
    expect(await commitIdsFor(dbEnv, repo.id, res.changeset.id)).not.toBeNull();
    expect(probe.sends.filter((s) => s.queue === 'DERIVED_QUEUE')).toEqual([]);
    const row = await q1(
      dbEnv,
      `SELECT ${C.derivedData.payload} AS payload FROM ${T.derivedData}
        WHERE ${C.derivedData.kind} = ? AND ${C.derivedData.csId} = ?`,
      [GIT_IDS, res.changeset.id],
    );
    expect(JSON.parse(String(row?.payload))).toEqual(
      await commitIdsFor(dbEnv, repo.id, res.changeset.id),
    );
  });

  it('defers large changes and parents without IDs to the derived-data queue', async () => {
    const repo = await createRepo(dbEnv, { slug: 'acme/git-deferred' });
    const probe = instrumentQueues(testEnv);
    const big = 'x'.repeat(3 * 1024 * 1024);
    const large = await commitChanges(probe.env, repo.id, {
      first_parent: null,
      message: 'large',
      author,
      changes: [1, 2, 3].map((i) => ({
        path: `big${i}.bin`,
        op: 'add' as const,
        content_b64: b64(`${i}${big}`),
      })),
    });
    // a child of a commit without IDs waits for its parent, in the queue too
    const child = await commitChanges(probe.env, repo.id, {
      first_parent: large.changeset.id,
      message: 'child',
      author,
      changes: [{ path: 'small.txt', op: 'add', content_b64: b64('s') }],
    });
    const queued = probe.sends
      .filter((s) => s.queue === 'DERIVED_QUEUE')
      .map((s) => s.body as DerivedMessage)
      .filter((m) => m.kind === GIT_IDS);
    expect(queued.map((m) => m.cs_id)).toEqual([large.changeset.id, child.changeset.id]);
    expect(await count(T.gitCommits)).toBe(0);

    await derivedQueue(mockBatch(queued), dbEnv);
    expect(await commitIdsFor(dbEnv, repo.id, large.changeset.id)).not.toBeNull();
    expect(await commitIdsFor(dbEnv, repo.id, child.changeset.id)).not.toBeNull();
  });

  it('never hashes past the budget: progress is kept and the next run continues', async () => {
    const repo = await createRepo(dbEnv, { slug: 'acme/git-budget' });
    const root = await createChangeset(dbEnv, repo.id, {
      first_parent: null,
      parents: [],
      author,
      message: 'three blobs',
      changed_files: [],
      root_tree: await storeTree(repo.id, {
        'a.txt': { content: 'aaaa' },
        'b.txt': { content: 'bbbb' },
        'c.txt': { content: 'cccc' },
      }),
    });
    let deferred = 0;
    for (;;) {
      try {
        // 5 bytes: one 4-byte blob per run
        await computeGitIds(dbEnv, repo.id, root, 5);
        break;
      } catch (err) {
        expect(err).toBeInstanceOf(DerivedDeferredError);
        deferred++;
        expect(await count(T.gitBlobs)).toBe(deferred);
      }
    }
    expect(deferred).toBe(2);
    const ids = await commitIdsFor(dbEnv, repo.id, root.id);
    expect((await readGitObject(dbEnv, repo.id, ids?.sha1 as string))?.type).toBe(
      'commit',
    );
  });

  it('long histories without IDs continue through the queue, oldest first', async () => {
    const repo = await createRepo(dbEnv, { slug: 'acme/git-long' });
    const n = MAX_WALK + 20;
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < n; i++) {
      const id = `cs${String(i).padStart(4, '0')}`;
      const parent = i === 0 ? null : `cs${String(i - 1).padStart(4, '0')}`;
      stmts.push(
        testEnv.DB.prepare(
          `INSERT INTO ${T.changesets} (${C.changesets.id}, ${C.changesets.repoId}, ${C.changesets.firstParent}, ${C.changesets.parents}, ${C.changesets.author}, ${C.changesets.message}, ${C.changesets.createdAt}, ${C.changesets.changedFiles}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          id,
          repo.id,
          parent,
          JSON.stringify(parent ? [parent] : []),
          JSON.stringify(author),
          `m${i}`,
          1_700_000_000_000 + i * 1000,
          '[]',
        ),
      );
    }
    await testEnv.DB.batch(stmts);
    const tip = `cs${String(n - 1).padStart(4, '0')}`;

    const probe = instrumentQueues(testEnv);
    let pending: DerivedMessage[] = [{ repo_id: repo.id, kind: GIT_IDS, cs_id: tip }];
    for (let round = 0; pending.length > 0 && round < 10; round++) {
      const before = probe.sends.length;
      await derivedQueue(mockBatch(pending), probe.env as unknown as Env);
      pending = probe.sends.slice(before).map((s) => s.body as DerivedMessage);
    }
    expect(pending).toEqual([]);
    expect(await count(T.gitCommits)).toBe(n);
    // the first message deferred to the deepest commit it reached, resuming the tip after
    const first = probe.sends[0]?.body as DerivedMessage;
    expect(first.resume).toEqual([tip]);
    expect(await ensureGitIds(dbEnv, repo.id, tip)).toEqual(
      await commitIdsFor(dbEnv, repo.id, tip),
    );
  });
});

describe('changeset IDs with Git metadata', () => {
  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
  });

  it('keeps pre-migration changeset IDs unchanged', async () => {
    // pinned on main before migration 0010
    expect(
      await computeChangesetId({
        repo_id: 'pilot-repo',
        first_parent: null,
        parents: [],
        author: { name: 'Ada', email: 'ada@example.com' },
        message: 'pilot root',
        changed_files: [{ path: 'README.md', op: 'add', hash: 'a'.repeat(64), size: 7 }],
      }),
    ).toBe('ad705c4e5869da9a4a041c3c392cd3fd89076b8d797113018508a42fe07cdf6d');
    expect(
      await computeChangesetId({
        repo_id: 'pilot-repo',
        first_parent: 'p'.repeat(64),
        parents: ['p'.repeat(64), 'q'.repeat(64)],
        author: { agent: 'agent-7' },
        message: 'merge',
        changed_files: [{ path: 'src/x.ts', op: 'del' }],
      }),
    ).toBe('5a7b99ea8c7035df7e7d2e8da53bda51db19e939f84756e3b8848a9efb5aa34a');

    // a row written without the new columns reads back without Git fields
    const repo = await createRepo(dbEnv, { slug: 'acme/pilot' });
    const fields = {
      repo_id: repo.id,
      first_parent: null,
      parents: [],
      author,
      message: 'pilot',
      changed_files: [],
    };
    const id = await computeChangesetId(fields);
    await run(
      dbEnv,
      `INSERT INTO ${T.changesets} (${C.changesets.id}, ${C.changesets.repoId}, ${C.changesets.firstParent}, ${C.changesets.parents}, ${C.changesets.author}, ${C.changesets.message}, ${C.changesets.createdAt}, ${C.changesets.changedFiles}) VALUES (?, ?, NULL, '[]', ?, 'pilot', 1, '[]')`,
      [id, repo.id, JSON.stringify(author)],
    );
    const stored = (await getChangeset(dbEnv, repo.id, id)) as Changeset;
    expect(Object.keys(stored).sort()).toEqual(
      [
        'author',
        'changed_files',
        'created_at',
        'first_parent',
        'id',
        'message',
        'parents',
        'repo_id',
        'root_tree',
      ].sort(),
    );
    expect(await computeChangesetId(stored)).toBe(id);
  });

  it('hashes Git metadata only when present and round-trips it', async () => {
    const repo = await createRepo(dbEnv, { slug: 'acme/meta' });
    const req = {
      first_parent: null,
      message: 'signed',
      author,
      changes: [{ path: 'a.txt', op: 'add' as const, content_b64: b64('a') }],
    };
    const plain = await commitChanges(dbEnv, repo.id, req);
    const meta = {
      committer: { name: 'Carol', email: 'carol@example.com', at: 1_700_000_300_000 },
      author_tz: '+1000',
      committer_tz: '-0130',
      gpgsig: '-----BEGIN SSH SIGNATURE-----\nabc\n-----END SSH SIGNATURE-----',
      git_extra_headers: [['encoding', 'ISO-8859-1']] as [string, string][],
    };
    const signed = await commitChanges(dbEnv, repo.id, { ...req, ...meta });
    expect(signed.changeset.id).not.toBe(plain.changeset.id);
    expect(await getChangeset(dbEnv, repo.id, signed.changeset.id)).toMatchObject(meta);

    const ids = await commitIdsFor(dbEnv, repo.id, signed.changeset.id);
    const body = dec.decode(
      (await readGitObject(dbEnv, repo.id, ids?.sha1 as string))?.body,
    );
    expect(body).toContain('committer Carol <carol@example.com> 1700000300 -0130\n');
    expect(body).toContain(
      'encoding ISO-8859-1\ngpgsig -----BEGIN SSH SIGNATURE-----\n abc\n',
    );

    await expect(
      commitChanges(dbEnv, repo.id, { ...req, author_tz: '10:00' }),
    ).rejects.toThrow();
    await expect(
      commitChanges(dbEnv, repo.id, { ...req, git_extra_headers: [['parent', 'x']] }),
    ).rejects.toThrow();
  });
});

/**
 * Import → export round trip of a real Git history (issue #30 acceptance,
 * closed by the #72 importer). The source is the shared fixture served by our
 * own upload-pack as a fake github.com repo; the bulk importer fetches it over
 * smart HTTP and stores it through the push path. `GIT_HISTORY_HEAD_SHA1` is
 * what real Git computes for the fixture (CLI Git smoke), so matching it
 * proves authors (agent identity included), committers, time zones, merges,
 * executable and symlink modes, Git sort order and an empty commit all
 * survive; a signed commit with extra headers rides on top.
 */
describe('import → export SHA round trip (#30, #72)', () => {
  let restore: () => void = () => {};
  afterEach(() => restore());

  it('a GitHub import reproduces every commit SHA, chunked or in one fetch', async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
    const { env: qEnv } = capturedQueue(dbEnv);
    const app = makeApp(qEnv);
    const gh = fakeGithub('acme-gh');
    restore = installFakeGithub(gh, app);
    const owner = await loginAs(testEnv, 1, 'owner');
    const orgRes = await app(
      new Request('https://x/api/v1/orgs', {
        method: 'POST',
        headers: { ...owner.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'acme' }),
      }),
    );
    expect(orgRes.status).toBe(201);
    await run(
      dbEnv,
      `INSERT INTO installations (installation_id, account_login, account_id, repos, updated_at)
       VALUES (77, 'acme-gh', 9, '[]', 0)`,
    );

    const source = await createRepo(dbEnv, { slug: 'src/hist', createdBy: owner.userId });
    const byKey = await seedHistory(source.id);
    const c4 = byKey.get('c4') as Changeset;
    const c5 = byKey.get('c5') as Changeset;
    const signed = await createChangeset(dbEnv, source.id, {
      first_parent: c5.id,
      parents: [c5.id],
      author,
      message: 'signed\n',
      changed_files: [],
      created_at: 1_700_000_600_000,
      root_tree: c5.root_tree,
      committer: { name: 'Carol', email: 'carol@example.com', at: 1_700_000_700_000 },
      author_tz: '+0530',
      committer_tz: '-0800',
      gpgsig: '-----BEGIN SSH SIGNATURE-----\nabc\n-----END SSH SIGNATURE-----',
      git_extra_headers: [['encoding', 'ISO-8859-1']],
    });
    await setRef(dbEnv, source.id, 'main', c5.id);
    await setRef(dbEnv, source.id, 'signed', signed.id);
    await setRef(dbEnv, source.id, 'refs/tags/merge', c4.id);
    const token = await createApiToken(dbEnv, owner.userId, { label: 'source' });
    const authorization = `Basic ${btoa(`git:${token.raw}`)}`;
    const sourceShas = await commitShas(dbEnv, source.id, [
      ...[...byKey.values()].map((cs) => cs.id),
      signed.id,
    ]);
    expect(sourceShas.get(c5.id)).toBe(GIT_HISTORY_HEAD_SHA1);
    gh.lists['/orgs/acme-gh/repos'] = [
      {
        id: 1,
        name: 'chunked',
        full_name: 'acme-gh/chunked',
        owner: { login: 'acme-gh' },
      },
      { id: 2, name: 'whole', full_name: 'acme-gh/whole', owner: { login: 'acme-gh' } },
    ];
    gh.git.chunked = { slug: source.slug, authorization };
    gh.git.whole = { slug: source.slug, authorization };
    const org = (await getOrgBySlug(qEnv, 'acme'))!;

    for (const [name, noFilter] of [
      ['chunked', false],
      ['whole', true],
    ] as const) {
      gh.noFilter = noFilter;
      const job = await startBulkImport(qEnv, org, owner.userId, {
        source: 'github',
        github_org: 'acme-gh',
        installation_id: 77,
        repos: [name],
      });
      expect(await driveImport(qEnv, job.id, { chunk: 2 })).toBe('done');
      const target = (await getRepoBySlug(qEnv, `acme/${name}`))!;
      const head = (await getRef(qEnv, target.id, 'main'))!.head;
      expect((await commitIdsFor(qEnv, target.id, head))?.sha1).toBe(
        GIT_HISTORY_HEAD_SHA1,
      );
      for (const sha of sourceShas.values()) {
        expect(await changesetForSha1(qEnv, target.id, sha)).not.toBeNull();
      }
      const imported = (await getChangeset(
        qEnv,
        target.id,
        (await getRef(qEnv, target.id, 'signed'))!.head,
      ))!;
      expect(imported).toMatchObject({
        author_tz: '+0530',
        committer_tz: '-0800',
        gpgsig: signed.gpgsig,
        git_extra_headers: [['encoding', 'ISO-8859-1']],
      });
      const merge = (await getRef(qEnv, target.id, 'refs/tags/merge'))!.head;
      expect((await getChangeset(qEnv, target.id, merge))!.parents).toHaveLength(2);
    }
  });
});
