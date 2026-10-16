import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { cleanDb, loginAs, makeApp, seedSchema, type TestEnv } from './helpers';
import type { Env } from '../src/env';
import { createRepo, getRef, setRef } from '../src/db/repos';
import { run } from '../src/db/client';
import { commitChanges, type Change } from '../src/core/commit';
import { getChangeset, type Changeset } from '../src/core/changesets';
import { getBlob } from '../src/core/blobs';
import { getTree } from '../src/core/trees';
import { dagMergeBases } from '../src/core/ancestry';
import { mergeCommit, merge3, threeWay, MAX_MERGE_BYTES } from '../src/core/merge';
import { ensureGitIds } from '../src/core/derived/gitIds';
import type { MergeConflict, Pull } from '../shared/collaboration';
import { MERGE_FIXTURE, MERGE_FIXTURE_SHA1 } from './fixtures/git-history';

/**
 * Server-side merges (issue #42): diff3 line merges, tree merges and their
 * conflicts, DAG merge bases, merge commits with Git's SHA-1, and the three
 * pull request merge methods through the API.
 */

const testEnv = env as unknown as TestEnv;
const dbEnv = testEnv as unknown as Env;
const ada = { name: 'Ada', email: 'ada@example.com' };
const bob = { name: 'Bob', email: 'bob@example.com' };
let repo: Awaited<ReturnType<typeof createRepo>>;

type Files = Record<string, string>;

function b64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

/** Commit the snapshot `files` on top of `parent` (whose snapshot is `before`). */
async function snap(
  parent: Changeset | null,
  before: Files,
  files: Files,
  opts: { author?: Changeset['author']; at?: number; message?: string } = {},
): Promise<Changeset> {
  const changes: Change[] = [];
  for (const path of Object.keys(before))
    if (!(path in files)) changes.push({ path, op: 'del' });
  for (const [path, content] of Object.entries(files)) {
    if (before[path] === content) continue;
    changes.push({ path, op: path in before ? 'mod' : 'add', content_b64: b64(content) });
  }
  return (
    await commitChanges(dbEnv, repo.id, {
      first_parent: parent?.id ?? null,
      message: opts.message ?? 'change',
      author: opts.author ?? ada,
      created_at: opts.at,
      changes,
    })
  ).changeset;
}

/** Every file in a changeset's tree, as text. */
async function filesOf(cs: Changeset): Promise<Files> {
  const out: Files = {};
  const walk = async (hash: string, prefix: string): Promise<void> => {
    for (const e of (await getTree(dbEnv, repo.id, hash))?.entries ?? []) {
      const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
      if (e.kind === 'tree') await walk(e.hash, path);
      else
        out[path] = new TextDecoder().decode(
          (await getBlob(dbEnv, repo.id, e.hash))?.content,
        );
    }
  };
  if (cs.root_tree) await walk(cs.root_tree, '');
  return out;
}

beforeEach(async () => {
  await seedSchema(testEnv);
  await cleanDb(testEnv);
  repo = await createRepo(dbEnv, { slug: 'team/merge' });
});

describe('merge3 (diff3)', () => {
  const base = 'a\nb\nc\nd\ne\n';
  it('takes each side where only that side changed', () => {
    expect(merge3(base, 'a\nB\nc\nd\ne\n', 'a\nb\nc\nD\ne\n')).toEqual({
      text: 'a\nB\nc\nD\ne\n',
      hunks: [],
    });
    expect(merge3(base, 'a\nc\nd\ne\n', 'a\nb\nc\nd\ne\nf\n').text).toBe(
      'a\nc\nd\ne\nf\n',
    );
    expect(merge3('x', 'x', 'y').text).toBe('y');
  });
  it('merges identical changes on both sides', () => {
    expect(merge3(base, 'a\nX\nc\nd\ne\n', 'a\nX\nc\nd\ne\n').hunks).toEqual([]);
  });
  it('reports overlapping and adjacent edits as hunks with all three sides', () => {
    expect(merge3(base, 'a\nX\nc\nd\ne\n', 'a\nY\nc\nd\ne\n').hunks).toEqual([
      {
        base: { start: 2, lines: ['b\n'] },
        ours: { start: 2, lines: ['X\n'] },
        theirs: { start: 2, lines: ['Y\n'] },
      },
    ]);
    // like Git, edits to neighbouring lines conflict
    expect(merge3(base, 'a\nX\nc\nd\ne\n', 'a\nb\nY\nd\ne\n').hunks).toHaveLength(1);
    // different insertions at the same place
    expect(merge3('a\n', 'a\nx\n', 'a\ny\n').hunks).toEqual([
      {
        base: { start: 2, lines: [] },
        ours: { start: 2, lines: ['x\n'] },
        theirs: { start: 2, lines: ['y\n'] },
      },
    ]);
  });
  it('keeps line endings byte for byte', () => {
    expect(merge3('a\r\nb\r\nc', 'A\r\nb\r\nc', 'a\r\nb\r\nC').text).toBe('A\r\nb\r\nC');
  });
});

describe('tree merges', () => {
  it('merges file and line level changes from both sides', async () => {
    const before = { 'a.txt': 'one\ntwo\nthree\n', 'b.txt': 'b\n', 'keep.txt': 'k\n' };
    const base = await snap(null, {}, before);
    const ours = await snap(base, before, { ...before, 'a.txt': 'ONE\ntwo\nthree\n' });
    const theirsFiles = {
      'a.txt': 'one\ntwo\nTHREE\n',
      'keep.txt': 'k\n',
      'd/x.txt': 'x\n',
    };
    const theirs = await snap(base, before, theirsFiles);
    const merged = await mergeCommit(dbEnv, repo.id, ours, theirs, {
      author: ada,
      message: 'merge',
    });
    expect(merged.parents).toEqual([ours.id, theirs.id]);
    expect(await filesOf(merged)).toEqual({
      'a.txt': 'ONE\ntwo\nTHREE\n',
      'keep.txt': 'k\n',
      'd/x.txt': 'x\n',
    });
    // changes are relative to the first parent
    expect(merged.changed_files.map((f) => `${f.op} ${f.path}`).sort()).toEqual([
      'add d/x.txt',
      'del b.txt',
      'mod a.txt',
    ]);
  });

  it('takes a mode change from one side and content from the other', async () => {
    const base = await snap(null, {}, { 'run.sh': 'echo 1\n' });
    const ours = (
      await commitChanges(dbEnv, repo.id, {
        first_parent: base.id,
        message: 'chmod',
        author: ada,
        changes: [
          { path: 'run.sh', op: 'mod', content_b64: b64('echo 1\n'), mode: '100755' },
        ],
      })
    ).changeset;
    const theirs = await snap(base, { 'run.sh': 'echo 1\n' }, { 'run.sh': 'echo 2\n' });
    const merged = await threeWay(dbEnv, repo.id, ours, theirs);
    expect(merged.conflicts).toEqual([]);
    expect(merged.changes).toEqual([
      expect.objectContaining({ path: 'run.sh', op: 'mod', mode: '100755' }),
    ]);
  });

  it('reports every kind of conflict and changes nothing', async () => {
    const before = {
      'edit.txt': 'a\nb\nc\n',
      'gone.txt': 'g\n',
      'bin.dat': 'x\u0000y',
      'f/x.txt': 'x\n',
    };
    const base = await snap(null, {}, before);
    const ours = await snap(base, before, {
      'edit.txt': 'a\nOURS\nc\n',
      'gone.txt': 'g ours\n',
      'bin.dat': 'x\u0000ours',
      'f/x.txt': 'x ours\n',
      'new.txt': 'ours\n',
      'both.txt': 'same\n',
    });
    const theirs = await snap(base, before, {
      'edit.txt': 'a\nTHEIRS\nc\n',
      'bin.dat': 'x\u0000theirs',
      f: 'now a file\n',
      'new.txt': 'theirs\n',
      'both.txt': 'same\n',
    });
    const merged = await threeWay(dbEnv, repo.id, ours, theirs);
    expect(merged.base).toBe(base.id);
    expect(merged.changes).toEqual([]);
    const kinds = Object.fromEntries(
      merged.conflicts.map((c: MergeConflict) => [c.path, c.kind]),
    );
    expect(kinds).toEqual({
      'bin.dat': 'binary',
      'edit.txt': 'content',
      f: 'file_directory',
      'gone.txt': 'modify_delete',
      'new.txt': 'add_add',
    });
    expect(merged.conflicts.find((c) => c.path === 'edit.txt')?.hunks).toEqual([
      {
        base: { start: 2, lines: ['b\n'] },
        ours: { start: 2, lines: ['OURS\n'] },
        theirs: { start: 2, lines: ['THEIRS\n'] },
      },
    ]);
  });

  it('treats a rename as delete plus add', async () => {
    const before = { 'a.txt': 'a\n', 'b.txt': 'b\n' };
    const base = await snap(null, {}, before);
    const renamed = await snap(base, before, { 'a2.txt': 'a\n', 'b.txt': 'b\n' });
    const editedB = await snap(base, before, { 'a.txt': 'a\n', 'b.txt': 'B\n' });
    const clean = await threeWay(dbEnv, repo.id, renamed, editedB);
    expect(clean.conflicts).toEqual([]);
    const editedA = await snap(base, before, { 'a.txt': 'A\n', 'b.txt': 'b\n' });
    expect((await threeWay(dbEnv, repo.id, renamed, editedA)).conflicts).toEqual([
      { path: 'a.txt', kind: 'modify_delete' },
    ]);
  });

  it('reports files over the size bound instead of merging them', async () => {
    const big = `${'x\n'.repeat(MAX_MERGE_BYTES / 2)}`;
    const before = { 'big.txt': big };
    const base = await snap(null, {}, before);
    const ours = await snap(base, before, { 'big.txt': `start\n${big}` });
    const theirs = await snap(base, before, { 'big.txt': `${big}end\n` });
    expect((await threeWay(dbEnv, repo.id, ours, theirs)).conflicts).toEqual([
      { path: 'big.txt', kind: 'too_large' },
    ]);
  });
});

describe('DAG merge bases', () => {
  it('finds the best common ancestors, two after a criss-cross', async () => {
    const root = await snap(null, {}, { 'r.txt': 'r\n' });
    const x = await snap(root, { 'r.txt': 'r\n' }, { 'r.txt': 'r\n', 'x.txt': 'x\n' });
    const y = await snap(root, { 'r.txt': 'r\n' }, { 'r.txt': 'r\n', 'y.txt': 'y\n' });
    expect((await dagMergeBases(dbEnv, repo.id, x.id, y.id)).bases).toEqual([root.id]);
    expect((await dagMergeBases(dbEnv, repo.id, root.id, x.id)).bases).toEqual([root.id]);
    const m1 = await mergeCommit(dbEnv, repo.id, x, y, { author: ada, message: 'm1' });
    const m2 = await mergeCommit(dbEnv, repo.id, y, x, { author: bob, message: 'm2' });
    const walk = await dagMergeBases(dbEnv, repo.id, m1.id, m2.id);
    expect(walk.bases.sort()).toEqual([x.id, y.id].sort());
    expect(walk.onlyB.map((cs) => cs.id)).toEqual([m2.id]);
    expect((await threeWay(dbEnv, repo.id, m1, m2)).conflicts).toEqual([
      { path: '', kind: 'multiple_merge_bases' },
    ]);
  });
});

describe('merge commit Git IDs', () => {
  it('match what git merge --no-ff records for the same inputs', async () => {
    const f = MERGE_FIXTURE;
    const author = f.author;
    const base = await snap(null, {}, f.base.files, {
      at: f.base.at,
      message: f.base.message,
      author,
    });
    const main = await snap(base, f.base.files, f.main.files, {
      at: f.main.at,
      message: f.main.message,
      author,
    });
    const feature = await snap(base, f.base.files, f.feature.files, {
      at: f.feature.at,
      message: f.feature.message,
      author,
    });
    const merged = await mergeCommit(dbEnv, repo.id, main, feature, {
      author,
      message: f.merge.message,
      created_at: f.merge.at,
    });
    expect(await filesOf(merged)).toEqual(f.merged);
    expect((await ensureGitIds(dbEnv, repo.id, merged.id))?.sha1).toBe(
      MERGE_FIXTURE_SHA1,
    );
  });
});

describe('pull request merge methods', () => {
  let owner: Awaited<ReturnType<typeof loginAs>>;
  let reviewer: Awaited<ReturnType<typeof loginAs>>;
  let base: Changeset;
  let first: Changeset;
  let head: Changeset;
  const start = { 'a.txt': 'one\ntwo\nthree\n', 'b.txt': 'b\n' };
  const proposed = { 'a.txt': 'one\ntwo\nTHREE\n', 'b.txt': 'b\n', 'c.txt': 'c\n' };

  async function api(
    tail: string,
    method = 'GET',
    body?: unknown,
    actor = owner,
  ): Promise<Response> {
    return makeApp(dbEnv)(
      new Request(`https://x/api/v1/repos/team/merge${tail}`, {
        method,
        headers: { ...actor.headers, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  }

  /** An open, approved pull request for `head`. */
  async function approvedPull(): Promise<Pull> {
    const res = await api('/pulls', 'POST', {
      title: 'Shout three',
      head_cs: head.id,
    });
    expect(res.status).toBe(201);
    const { pull } = (await res.json()) as { pull: Pull };
    const review = await api(
      `/pulls/${pull.id}/review`,
      'POST',
      { head_cs: head.id, revision: pull.revision, decision: 'approve', body: '' },
      reviewer,
    );
    expect(review.status).toBe(200);
    return pull;
  }

  async function merge(
    pull: Pull,
    extra: Record<string, unknown> = {},
  ): Promise<Response> {
    return api(`/pulls/${pull.id}/merge`, 'POST', {
      head_cs: pull.head_cs,
      revision: pull.revision,
      ...extra,
    });
  }

  async function mainHead(): Promise<Changeset> {
    return (await getChangeset(
      dbEnv,
      repo.id,
      (await getRef(dbEnv, repo.id, 'main'))?.head as string,
    )) as Changeset;
  }

  beforeEach(async () => {
    owner = await loginAs(testEnv, 801, 'owner');
    reviewer = await loginAs(testEnv, 802, 'reviewer');
    await run(testEnv, 'UPDATE repos SET created_by = ? WHERE id = ?', [
      owner.userId,
      repo.id,
    ]);
    await run(
      testEnv,
      "INSERT INTO repo_members(repo_id,user_id,role) VALUES (?,?,'write')",
      [repo.id, reviewer.userId],
    );
    base = await snap(null, {}, start);
    await setRef(dbEnv, repo.id, 'main', base.id);
    first = await snap(base, start, { ...start, 'c.txt': 'c\n' }, { message: 'add c' });
    head = await snap(first, { ...start, 'c.txt': 'c\n' }, proposed, {
      author: bob,
      at: 1_700_000_000_000,
      message: 'shout three\n\nbody',
    });
  });

  it('merge records a merge commit by the merger', async () => {
    const pull = await approvedPull();
    const res = await merge(pull, { method: 'merge' });
    expect(res.status).toBe(200);
    const merged = ((await res.json()) as { pull: Pull }).pull;
    const tip = await mainHead();
    expect(merged).toMatchObject({
      state: 'merged',
      merge_method: 'merge',
      merged_cs: tip.id,
    });
    expect(tip.parents).toEqual([base.id, head.id]);
    expect(tip.author).toEqual({ name: 'owner', email: 'owner@users.yuma-agent-git' });
    expect(tip.message).toBe(`Merge pull request #${pull.number}\n\nShout three\n`);
    expect(await filesOf(tip)).toEqual(proposed);
  });

  it('squash records one commit with the first author and co-author trailers', async () => {
    const pull = await approvedPull();
    expect((await merge(pull, { method: 'squash' })).status).toBe(200);
    const tip = await mainHead();
    expect(tip.parents).toEqual([base.id]);
    expect(tip.author).toEqual(ada);
    expect(tip.committer).toMatchObject({
      name: 'owner',
      email: 'owner@users.yuma-agent-git',
    });
    expect(tip.message).toBe(
      `Shout three (#${pull.number})\n\n* add c\n* shout three\n\nCo-authored-by: Bob <bob@example.com>\n`,
    );
    expect(await filesOf(tip)).toEqual(proposed);
  });

  it('rebase replays each commit with its author onto the target', async () => {
    const pull = await approvedPull();
    // move the target first so the replay has something to rebase onto
    const moved = await snap(base, start, { ...start, 'b.txt': 'B\n' });
    await setRef(dbEnv, repo.id, 'main', moved.id);
    expect((await merge(pull, { method: 'rebase' })).status).toBe(200);
    const tip = await mainHead();
    const parent = (await getChangeset(dbEnv, repo.id, tip.first_parent as string))!;
    expect(tip.parents).toHaveLength(1);
    expect(parent.first_parent).toBe(moved.id);
    expect([parent.author, tip.author]).toEqual([ada, bob]);
    expect(tip.created_at).toBe(head.created_at);
    expect(tip.message).toBe(head.message);
    expect(tip.committer?.name).toBe('owner');
    expect(await filesOf(tip)).toEqual({ ...proposed, 'b.txt': 'B\n' });
  });

  it('merges a moved target without user action when edits do not overlap', async () => {
    const pull = await approvedPull();
    const moved = await snap(base, start, { ...start, 'a.txt': 'ONE\ntwo\nthree\n' });
    await setRef(dbEnv, repo.id, 'main', moved.id);
    const gate = (await (await api(`/pulls/${pull.id}`)).json()) as {
      gate: { mergeable: boolean; reasons: string[] };
    };
    expect(gate.gate).toMatchObject({ mergeable: true, reasons: [] });
    expect((await merge(pull)).status).toBe(200);
    const tip = await mainHead();
    expect(tip.parents).toEqual([moved.id, head.id]);
    expect(await filesOf(tip)).toEqual({ ...proposed, 'a.txt': 'ONE\ntwo\nTHREE\n' });
  });

  it('returns merge_conflict for overlapping edits and moves nothing', async () => {
    const pull = await approvedPull();
    const moved = await snap(base, start, { ...start, 'a.txt': 'one\ntwo\n3\n' });
    await setRef(dbEnv, repo.id, 'main', moved.id);
    const conflict = {
      path: 'a.txt',
      kind: 'content',
      hunks: [
        {
          base: { start: 3, lines: ['three\n'] },
          ours: { start: 3, lines: ['3\n'] },
          theirs: { start: 3, lines: ['THREE\n'] },
        },
      ],
    };
    for (const method of ['merge', 'squash', 'rebase']) {
      const res = await merge(pull, { method });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: Record<string, unknown> };
      expect(body.error).toMatchObject({
        code: 'merge_conflict',
        conflicts: [conflict],
        conflict_count: 1,
      });
    }
    expect((await getRef(dbEnv, repo.id, 'main'))?.head).toBe(moved.id);
    expect(
      (await (await api(`/pulls/${pull.id}`)).json()) as { pull: Pull },
    ).toMatchObject({ pull: { state: 'open', merged_cs: null } });
    const report = await api(`/pulls/${pull.id}/conflicts`);
    expect(report.status).toBe(200);
    expect(await report.json()).toEqual({
      mergeable: false,
      target_cs: moved.id,
      head_cs: head.id,
      merge_base: base.id,
      conflicts: [conflict],
    });
  });

  it('honours the repo allow-list and default method', async () => {
    const pull = await approvedPull();
    expect(
      (await api('', 'PUT', { merge_methods: ['merge'], default_merge_method: 'squash' }))
        .status,
    ).toBe(400);
    const res = await api('', 'PUT', {
      merge_methods: ['squash', 'rebase'],
      default_merge_method: 'squash',
    });
    expect(res.status).toBe(200);
    const detail = (await (await api(`/pulls/${pull.id}`)).json()) as {
      gate: { methods: string[]; method: string };
    };
    expect(detail.gate).toMatchObject({
      methods: ['squash', 'rebase'],
      method: 'squash',
    });
    const refused = await merge(pull, { method: 'merge' });
    expect(refused.status).toBe(409);
    expect(
      ((await refused.json()) as { error: { message: string } }).error.message,
    ).toMatch(/merge merges are turned off/);
    expect((await merge(pull)).status).toBe(200);
    expect((await mainHead()).parents).toEqual([base.id]);
  });

  it('honours a ruleset merge_methods rule, bypass included', async () => {
    const pull = await approvedPull();
    const created = await api('/rulesets', 'POST', {
      name: 'linear main',
      target: 'branch',
      conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
      rules: [{ type: 'merge_methods', allowed: ['rebase', 'squash'] }],
    });
    expect(created.status).toBe(201);
    const detail = (await (await api(`/pulls/${pull.id}`)).json()) as {
      gate: { methods: string[]; method: string; mergeable: boolean };
    };
    expect(detail.gate).toMatchObject({
      methods: ['squash', 'rebase'],
      method: 'squash',
      mergeable: true,
    });
    const refused = await merge(pull, { method: 'merge' });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { message: string } }).error.message).toBe(
      'merge merges are not allowed into main; use rebase or squash.',
    );
    expect((await getRef(dbEnv, repo.id, 'main'))?.head).toBe(base.id);
    expect((await merge(pull, { method: 'rebase' })).status).toBe(200);
  });
});
