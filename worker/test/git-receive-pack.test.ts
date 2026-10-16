import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { cleanDb, loginAs, makeApp, seedSchema, type TestEnv } from './helpers';
import {
  blob,
  commit,
  dir,
  lines,
  packOf,
  parseReport,
  pushBody,
  retrail,
  tree,
  ZERO,
  type Obj,
} from './git-helpers';
import { createRepo, getRef, listRefs } from '../src/db/repos';
import { q, run } from '../src/db/client';
import { ciPolicyRulesetStatement } from '../src/policy/rulesets';
import { createApiToken } from '../src/auth/tokens';
import { commitShas } from '../src/git/upload-pack';
import { changesetForSha1, readGitObject } from '../src/git/mapping';
import { commitChanges } from '../src/core/commit';
import { getChangeset } from '../src/core/changesets';
import { getTree } from '../src/core/trees';
import { deflate, objectHeader, packHeader } from '../src/git/pack-writer';
import { concatBytes } from '../src/git/pktline';

const testEnv = env as unknown as TestEnv;
const dbEnv = testEnv as unknown as Env;
const app = makeApp(testEnv);
const SLUG = 'acme/push';

let repoId = '';
let auth = '';

async function tokenAuth(userId: string): Promise<string> {
  const token = await createApiToken(dbEnv, userId, { label: 'git' });
  return `Basic ${btoa(`git:${token.raw}`)}`;
}

async function push(
  body: Uint8Array,
  as = auth,
): Promise<ReturnType<typeof parseReport>> {
  const res = await app(
    new Request(`https://x/${SLUG}.git/git-receive-pack`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-git-receive-pack-request',
        authorization: as,
      },
      body,
    }),
  );
  expect(res.status).toBe(200);
  return parseReport(new Uint8Array(await res.arrayBuffer()));
}

/** A one-commit history: README, an executable and a nested file. */
async function rootCommit(): Promise<{ objects: Obj[]; head: Obj }> {
  const readme = await blob('hello\n');
  const script = await blob('#!/bin/sh\necho hi\n');
  const deep = await blob('deep\n');
  const src = await tree([{ name: 'deep.txt', sha: deep.sha }]);
  const root = await tree([
    { name: 'README.md', sha: readme.sha },
    { name: 'run.sh', mode: '100755', sha: script.sha },
    dir('src', src),
  ]);
  const head = await commit(root.sha, [], 'first\n');
  return { objects: [head, root, src, readme, script, deep], head };
}

/** A child of `parent` whose root holds just `files` (path → content). */
async function child(
  parent: string | null,
  files: Record<string, string>,
  message: string,
  seconds?: number,
): Promise<{ objects: Obj[]; head: Obj }> {
  const blobs = await Promise.all(Object.values(files).map((text) => blob(text)));
  const root = await tree(
    Object.keys(files).map((name, i) => ({ name, sha: blobs[i]!.sha })),
  );
  const head = await commit(root.sha, parent ? [parent] : [], message, seconds);
  return { objects: [head, root, ...blobs], head };
}

async function headSha(name: string): Promise<string | null> {
  const ref = await getRef(dbEnv, repoId, name);
  return ref
    ? ((await commitShas(dbEnv, repoId, [ref.head])).get(ref.head) ?? null)
    : null;
}

describe('git receive-pack', () => {
  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
    const owner = await loginAs(testEnv, 1, 'ada');
    repoId = (await createRepo(dbEnv, { slug: SLUG, createdBy: owner.userId })).id;
    auth = await tokenAuth(owner.userId);
  });

  it('pushes a new branch whose changesets rebuild to the pushed SHAs', async () => {
    const { objects, head } = await rootCommit();
    const report = await push(
      pushBody([[ZERO, head.sha, 'refs/heads/main']], await packOf(objects)),
    );
    expect(report).toMatchObject({ unpack: 'ok', refs: { 'refs/heads/main': 'ok' } });
    expect(await headSha('main')).toBe(head.sha);

    // file modes survive: the stored tree keeps run.sh executable
    const cs = await getChangeset(
      dbEnv,
      repoId,
      (await getRef(dbEnv, repoId, 'main'))!.head,
    );
    const stored = await getTree(dbEnv, repoId, cs!.root_tree!);
    expect(stored?.entries.find((e) => e.name === 'run.sh')?.mode).toBe('100755');

    // Basic credentials are for Git paths only, never the API
    const api = await app(
      new Request(`https://x/api/v1/repos/${SLUG}/refs`, {
        headers: { authorization: auth },
      }),
    );
    expect(api.status).toBe(401);

    const audit = await q<{ action: string; target: string }>(
      dbEnv,
      `SELECT action, target FROM audit_events WHERE repo_id = ?`,
      [repoId],
    );
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]!.target)).toMatchObject({ ref: 'main', via: 'git-push' });
  });

  it('resolves thin-pack ref-deltas against stored blobs and accepts merge commits', async () => {
    const first = await rootCommit();
    await push(
      pushBody([[ZERO, first.head.sha, 'refs/heads/main']], await packOf(first.objects)),
    );

    // README "hello\n" + "more\n" sent as a delta against the stored blob
    const base = first.objects[3]!;
    const next = await blob('hello\nmore\n');
    const delta = new Uint8Array([
      6,
      11,
      0x90,
      6,
      5,
      ...new TextEncoder().encode('more\n'),
    ]);
    const root2 = await tree([
      { name: 'README.md', sha: next.sha },
      { name: 'run.sh', mode: '100755', sha: first.objects[4]!.sha },
      { name: 'src', mode: '40000', sha: first.objects[2]!.sha },
    ]);
    const c2 = await commit(root2.sha, [first.head.sha], 'more\n');
    const sideBlob = await blob('side\n');
    const side = await tree([{ name: 'side.txt', sha: sideBlob.sha }]);
    const c3 = await commit(side.sha, [first.head.sha], 'side\n');
    const merge = await commit(root2.sha, [c2.sha, c3.sha], 'merge side\n');

    const entry = async (o: Obj, code: number): Promise<Uint8Array> =>
      concatBytes([objectHeader(code, o.body.length), await deflate(o.body)]);
    const hexBytes = Uint8Array.from(base.sha.match(/../g)!.map((h) => parseInt(h, 16)));
    const pack = await retrail(
      concatBytes([
        packHeader(7),
        await entry(c2, 1),
        await entry(root2, 2),
        concatBytes([objectHeader(7, delta.length), hexBytes, await deflate(delta)]),
        await entry(c3, 1),
        await entry(side, 2),
        await entry(sideBlob, 3),
        await entry(merge, 1),
        new Uint8Array(20),
      ]),
    );
    const report = await push(
      pushBody(
        [
          [first.head.sha, merge.sha, 'refs/heads/main'],
          [ZERO, c3.sha, 'refs/heads/side'],
        ],
        pack,
      ),
    );
    expect(report.refs).toEqual({ 'refs/heads/main': 'ok', 'refs/heads/side': 'ok' });
    expect(await headSha('main')).toBe(merge.sha);
    expect(await headSha('side')).toBe(c3.sha);
  });

  it('rejects corrupt packs and leaves every ref alone', async () => {
    const { objects, head } = await rootCommit();
    const pack = await packOf(objects);
    const badTrailer = pack.slice();
    badTrailer[badTrailer.length - 1]! ^= 1;
    const r1 = await push(pushBody([[ZERO, head.sha, 'refs/heads/main']], badTrailer));
    expect(r1.unpack).toBe('pack checksum mismatch');
    expect(r1.refs['refs/heads/main']).toBe('unpacker error');

    const badBody = pack.slice();
    badBody[40]! ^= 0xff;
    const r2 = await push(
      pushBody([[ZERO, head.sha, 'refs/heads/main']], await retrail(badBody)),
    );
    expect(r2.unpack).not.toBe('ok');
    expect(r2.refs['refs/heads/main']).toBe('unpacker error');
    expect(await listRefs(dbEnv, repoId)).toEqual([]);
  });

  it('protects the default branch from force pushes and, with a CI policy ruleset, from pushes', async () => {
    const first = await rootCommit();
    await push(
      pushBody([[ZERO, first.head.sha, 'refs/heads/main']], await packOf(first.objects)),
    );
    const other = await child(null, { 'x.txt': 'x\n' }, 'unrelated\n');

    const forced = await push(
      pushBody(
        [[first.head.sha, other.head.sha, 'refs/heads/main']],
        await packOf(other.objects),
      ),
    );
    expect(forced.refs['refs/heads/main']).toBe(
      'protected_branch: force pushes to the default branch are not allowed',
    );
    expect(forced.messages).toContain('rejected by protected_branch');
    expect(await headSha('main')).toBe(first.head.sha);
    // the rejected commit was never stored, so nothing can reach it
    expect(await changesetForSha1(dbEnv, repoId, other.head.sha)).toBeNull();

    // other branches take force pushes
    await push(pushBody([[ZERO, first.head.sha, 'refs/heads/topic']], null));
    const topic = await push(
      pushBody(
        [[first.head.sha, other.head.sha, 'refs/heads/topic']],
        await packOf(other.objects),
      ),
    );
    expect(topic.refs['refs/heads/topic']).toBe('ok');

    await ciPolicyRulesetStatement(
      dbEnv,
      repoId,
      { protect_default: true, required_approvals: 1, require_checks: true },
      Date.now(),
    ).run();
    const ff = await child(first.head.sha, { 'y.txt': 'y\n' }, 'ff\n');
    const blocked = await push(
      pushBody(
        [[first.head.sha, ff.head.sha, 'refs/heads/main']],
        await packOf(ff.objects),
      ),
    );
    expect(blocked.refs['refs/heads/main']).toBe(
      'ruleset "CI policy (default branch)" update: open a pull request to update main',
    );
    expect(await headSha('main')).toBe(first.head.sha);
  });

  it('applies path rules to every path a push changes', async () => {
    const first = await rootCommit();
    await push(
      pushBody([[ZERO, first.head.sha, 'refs/heads/main']], await packOf(first.objects)),
    );
    const dev = await loginAs(testEnv, 2, 'dev');
    await run(
      dbEnv,
      'INSERT INTO repo_members (repo_id, user_id, role) VALUES (?, ?, ?)',
      [repoId, dev.userId, 'write'],
    );
    await run(
      dbEnv,
      `INSERT INTO path_rules (repo_id, path_prefix, effect, principal, perms) VALUES (?, 'src/', 'deny', ?, ?)`,
      [repoId, `user:${dev.userId}`, JSON.stringify(['write'])],
    );
    const devAuth = await tokenAuth(dev.userId);
    // drops src/ from the tree: a change under the denied prefix
    const touch = await child(first.head.sha, { 'README.md': 'hello\n' }, 'drop src\n');
    const denied = await push(
      pushBody(
        [[first.head.sha, touch.head.sha, 'refs/heads/main']],
        await packOf(touch.objects),
      ),
      devAuth,
    );
    expect(denied.refs['refs/heads/main']).toMatch(
      /^path_rule \d+: write denied on src\//,
    );

    const readme = await blob('hello\nfrom dev\n');
    const root = await tree([
      { name: 'README.md', sha: readme.sha },
      { name: 'run.sh', mode: '100755', sha: first.objects[4]!.sha },
      { name: 'src', mode: '40000', sha: first.objects[2]!.sha },
    ]);
    const allowed = await commit(root.sha, [first.head.sha], 'readme only\n');
    const ok = await push(
      pushBody(
        [[first.head.sha, allowed.sha, 'refs/heads/main']],
        await packOf([allowed, root, readme]),
      ),
      devAuth,
    );
    expect(ok.refs['refs/heads/main']).toBe('ok');

    // a reader cannot push at all
    const reader = await loginAs(testEnv, 3, 'reader');
    await run(
      dbEnv,
      'INSERT INTO repo_members (repo_id, user_id, role) VALUES (?, ?, ?)',
      [repoId, reader.userId, 'read'],
    );
    const res = await app(
      new Request(`https://x/${SLUG}.git/info/refs?service=git-receive-pack`, {
        headers: { authorization: await tokenAuth(reader.userId) },
      }),
    );
    expect(res.status).toBe(403);
  });

  it('refuses .git paths and names that collide when case is ignored', async () => {
    const first = await rootCommit();
    await push(
      pushBody([[ZERO, first.head.sha, 'refs/heads/main']], await packOf(first.objects)),
    );
    const hook = await blob('#!/bin/sh\n');
    const dotgit = await tree([{ name: 'config', sha: hook.sha }]);
    const evil = await tree([dir('.GIT', dotgit)]);
    const c1 = await commit(evil.sha, [first.head.sha], 'evil\n');
    const r1 = await push(
      pushBody(
        [[ZERO, c1.sha, 'refs/heads/evil']],
        await packOf([c1, evil, dotgit, hook]),
      ),
    );
    expect(r1.refs['refs/heads/evil']).toMatch(/^unsafe_path: /);

    const a = await blob('a\n');
    const twins = await tree([
      { name: 'Readme', sha: a.sha },
      { name: 'readme', sha: a.sha },
    ]);
    const c2 = await commit(twins.sha, [first.head.sha], 'twins\n');
    const r2 = await push(
      pushBody([[ZERO, c2.sha, 'refs/heads/twins']], await packOf([c2, twins, a])),
    );
    expect(r2.refs['refs/heads/twins']).toMatch(/^case_collision: /);
  });

  it('two concurrent pushes to one branch: one lands, the other is refused', async () => {
    const first = await rootCommit();
    await push(
      pushBody([[ZERO, first.head.sha, 'refs/heads/main']], await packOf(first.objects)),
    );
    const a = await child(first.head.sha, { 'a.txt': 'a\n' }, 'a\n');
    const b = await child(first.head.sha, { 'b.txt': 'b\n' }, 'b\n');
    const [ra, rb] = await Promise.all([
      push(
        pushBody(
          [[first.head.sha, a.head.sha, 'refs/heads/main']],
          await packOf(a.objects),
        ),
      ),
      push(
        pushBody(
          [[first.head.sha, b.head.sha, 'refs/heads/main']],
          await packOf(b.objects),
        ),
      ),
    ]);
    const results = [ra!.refs['refs/heads/main'], rb!.refs['refs/heads/main']];
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    const winner = results[0] === 'ok' ? a.head.sha : b.head.sha;
    expect(await headSha('main')).toBe(winner);
  });

  it('atomic pushes move every ref or none', async () => {
    const first = await rootCommit();
    await push(
      pushBody([[ZERO, first.head.sha, 'refs/heads/main']], await packOf(first.objects)),
    );
    const next = await child(first.head.sha, { 'n.txt': 'n\n' }, 'next\n');
    const report = await push(
      pushBody(
        [
          [first.head.sha, next.head.sha, 'refs/heads/main'],
          [ZERO, next.head.sha, 'refs/pull/1/head'],
        ],
        await packOf(next.objects),
        'report-status atomic',
      ),
    );
    expect(report.refs['refs/heads/main']).toBe('atomic push failed');
    expect(report.refs['refs/pull/1/head']).toMatch(/can be pushed/);
    expect(await headSha('main')).toBe(first.head.sha);
  });

  it('deletes refs and refuses to delete the default branch', async () => {
    const first = await rootCommit();
    await push(
      pushBody(
        [
          [ZERO, first.head.sha, 'refs/heads/main'],
          [ZERO, first.head.sha, 'refs/tags/v1'],
        ],
        await packOf(first.objects),
      ),
    );
    const report = await push(
      pushBody(
        [
          [first.head.sha, ZERO, 'refs/tags/v1'],
          [first.head.sha, ZERO, 'refs/heads/main'],
        ],
        null,
      ),
    );
    expect(report.refs['refs/tags/v1']).toBe('ok');
    expect(report.refs['refs/heads/main']).toMatch(/^protected_branch: /);
    expect((await listRefs(dbEnv, repoId)).map((r) => r.name)).toEqual(['main']);
  });

  it('advertises refs for push and gates anonymous, unknown and read-only callers', async () => {
    const first = await rootCommit();
    await push(
      pushBody([[ZERO, first.head.sha, 'refs/heads/main']], await packOf(first.objects)),
    );
    const advert = await app(
      new Request(`https://x/${SLUG}.git/info/refs?service=git-receive-pack`, {
        headers: { authorization: auth },
      }),
    );
    const body = lines(new Uint8Array(await advert.arrayBuffer()));
    expect(body[0]).toBe('# service=git-receive-pack');
    expect(body[2]).toMatch(
      new RegExp(`^${first.head.sha} refs/heads/main\0report-status `),
    );

    const anon = await app(
      new Request(`https://x/${SLUG}.git/info/refs?service=git-receive-pack`),
    );
    expect(anon.status).toBe(401);
    expect(anon.headers.get('www-authenticate')).toMatch(/^Basic /);
    const stranger = await loginAs(testEnv, 9, 'mallory');
    const hidden = await app(
      new Request(`https://x/${SLUG}.git/info/refs?service=git-receive-pack`, {
        headers: { authorization: await tokenAuth(stranger.userId) },
      }),
    );
    expect(hidden.status).toBe(404);
  });

  it('reuses changesets for pushed commits that already map to one', async () => {
    const api = await commitChanges(dbEnv, repoId, {
      first_parent: null,
      message: 'via api\n',
      author: { name: 'Ada', email: 'ada@example.com' },
      changes: [{ path: 'a.txt', op: 'add', content_b64: btoa('a\n') }],
    });
    const id = api.changeset.id;
    const sha = (await commitShas(dbEnv, repoId, [id])).get(id) as string;
    const object = await readGitObject(dbEnv, repoId, sha);
    const report = await push(
      pushBody(
        [[ZERO, sha, 'refs/heads/feature']],
        await packOf([{ type: 'commit', body: object!.body }]),
      ),
    );
    expect(report.refs['refs/heads/feature']).toBe('ok');
    expect((await getRef(dbEnv, repoId, 'feature'))?.head).toBe(id);
  });

  it('stores commits that turn a file into a directory and a directory into a file', async () => {
    const first = await rootCommit();
    await push(
      pushBody([[ZERO, first.head.sha, 'refs/heads/main']], await packOf(first.objects)),
    );
    const inner = await blob('inner\n');
    const readmeDir = await tree([{ name: 'index.md', sha: inner.sha }]);
    const srcFile = await blob('now a file\n');
    const root2 = await tree([
      dir('README.md', readmeDir),
      { name: 'run.sh', mode: '100755', sha: first.objects[4]!.sha },
      { name: 'src', sha: srcFile.sha },
    ]);
    const c2 = await commit(root2.sha, [first.head.sha], 'swap\n');
    const report = await push(
      pushBody(
        [[first.head.sha, c2.sha, 'refs/heads/main']],
        await packOf([c2, root2, readmeDir, inner, srcFile]),
      ),
    );
    expect(report.refs['refs/heads/main']).toBe('ok');
    expect(await headSha('main')).toBe(c2.sha);
  });

  it('refuses branch names that alias tags or agent refs', async () => {
    const { objects, head } = await rootCommit();
    const report = await push(
      pushBody(
        [
          [ZERO, head.sha, 'refs/heads/refs/tags/v1'],
          [ZERO, head.sha, 'refs/heads/refs/agents/x/work'],
        ],
        await packOf(objects),
      ),
    );
    expect(report.refs['refs/heads/refs/tags/v1']).toMatch(/^invalid_ref_name: /);
    expect(report.refs['refs/heads/refs/agents/x/work']).toMatch(/^invalid_ref_name: /);
    expect(await listRefs(dbEnv, repoId)).toEqual([]);
  });

  it('stores empty messages and refuses over-wide commits before storing any', async () => {
    const one = await blob('x\n');
    const root = await tree([{ name: 'a.txt', sha: one.sha }]);
    const empty = await commit(root.sha, [], '');
    const r1 = await push(
      pushBody([[ZERO, empty.sha, 'refs/heads/main']], await packOf([empty, root, one])),
    );
    expect(r1.refs['refs/heads/main']).toBe('ok');
    expect(await headSha('main')).toBe(empty.sha);

    const wide = await tree(
      Array.from({ length: 5001 }, (_, i) => ({ name: `f${i}`, sha: one.sha })),
    );
    const middle = await commit(root.sha, [empty.sha], 'middle\n', 1_700_000_100);
    const big = await commit(wide.sha, [middle.sha], 'wide\n');
    const r2 = await push(
      pushBody(
        [[empty.sha, big.sha, 'refs/heads/main']],
        await packOf([middle, big, wide]),
      ),
    );
    expect(r2.refs['refs/heads/main']).toMatch(/at most 5000 per commit can be stored$/);
    expect(await changesetForSha1(dbEnv, repoId, middle.sha)).toBeNull();
    expect(await headSha('main')).toBe(empty.sha);
  });
});
