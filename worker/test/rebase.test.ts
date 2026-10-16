import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { cleanDb, loginAs, makeApp, seedSchema, type TestEnv } from './helpers';
import type { Env } from '../src/env';
import { createRepo, getRef, setRef } from '../src/db/repos';
import { run } from '../src/db/client';
import { commitChanges } from '../src/core/commit';
import { getChangeset, type Changeset } from '../src/core/changesets';
import { mergeCommit } from '../src/core/merge';
import { resolvePath } from '../src/core/trees';
import { rebaseOnto, replayable } from '../src/core/rebase';
import { ApiError } from '../src/core/errors';
import type { Pull } from '../shared/collaboration';

/**
 * Rebase (issue #42): replaying changesets onto a new base, stopping at the
 * first conflict, and `POST …/pulls/:id/update-branch`, which replaces the
 * old "rebase required" dead end.
 */

const testEnv = env as unknown as TestEnv;
const dbEnv = testEnv as unknown as Env;
const ada = { name: 'Ada', email: 'ada@example.com' };
const bob = { name: 'Bob', email: 'bob@example.com' };
const committer = { name: 'Cy', email: 'cy@example.com', at: 1_800_000_000_000 };
let repo: Awaited<ReturnType<typeof createRepo>>;

async function edit(
  parent: Changeset | null,
  path: string,
  content: string,
  opts: { author?: Changeset['author']; at?: number; tz?: string } = {},
): Promise<Changeset> {
  const exists =
    parent?.root_tree != null &&
    (await resolvePath(dbEnv, repo.id, parent.root_tree, path.split('/'))) !== null;
  return (
    await commitChanges(dbEnv, repo.id, {
      first_parent: parent?.id ?? null,
      message: `${path}: ${content}`,
      author: opts.author ?? ada,
      created_at: opts.at,
      ...(opts.tz ? { author_tz: opts.tz } : {}),
      changes: [{ path, op: exists ? 'mod' : 'add', content_b64: btoa(content) }],
    })
  ).changeset;
}

async function load(id: string): Promise<Changeset> {
  return (await getChangeset(dbEnv, repo.id, id)) as Changeset;
}

beforeEach(async () => {
  await seedSchema(testEnv);
  await cleanDb(testEnv);
  repo = await createRepo(dbEnv, { slug: 'team/rebase' });
});

describe('replaying changesets', () => {
  it('keeps author, author time, time zone and message; the caller commits', async () => {
    const base = await edit(null, 'a.txt', '1\n2\n3\n');
    const one = await edit(base, 'b.txt', 'b\n', { at: 1_700_000_000_000, tz: '+1000' });
    const two = await edit(one, 'a.txt', '1\n2\nthree\n', { author: bob });
    const onto = await edit(base, 'a.txt', 'one\n2\n3\n');
    expect((await replayable(dbEnv, repo.id, onto.id, two.id)).map((c) => c.id)).toEqual([
      one.id,
      two.id,
    ]);
    const tip = await rebaseOnto(dbEnv, repo.id, onto, two.id, committer);
    const first = await load(tip.first_parent as string);
    expect(first.first_parent).toBe(onto.id);
    expect(first).toMatchObject({
      author: ada,
      created_at: 1_700_000_000_000,
      author_tz: '+1000',
      message: one.message,
      committer,
    });
    expect(tip).toMatchObject({ author: bob, message: two.message, committer });
    expect(tip.changed_files.map((f) => f.path)).toEqual(['a.txt']);
  });

  it('skips a changeset whose change is already there', async () => {
    const base = await edit(null, 'a.txt', 'a\n');
    const one = await edit(base, 'b.txt', 'b\n');
    const onto = await edit(base, 'b.txt', 'b\n', { author: bob });
    expect((await rebaseOnto(dbEnv, repo.id, onto, one.id, committer)).id).toBe(onto.id);
  });

  it('stops at the first conflict and names the changeset', async () => {
    const base = await edit(null, 'a.txt', 'a\n');
    const one = await edit(base, 'a.txt', 'ours\n');
    const two = await edit(one, 'b.txt', 'b\n');
    const onto = await edit(base, 'a.txt', 'theirs\n');
    const err = await rebaseOnto(dbEnv, repo.id, onto, two.id, committer).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 409,
      code: 'merge_conflict',
      details: { at: one.id, conflicts: [{ path: 'a.txt', kind: 'content' }] },
    });
  });

  it('refuses merge commits instead of dropping what they resolved', async () => {
    const base = await edit(null, 'a.txt', 'a\n');
    const side = await edit(base, 'b.txt', 'b\n');
    const main = await edit(base, 'c.txt', 'c\n');
    const merged = await mergeCommit(dbEnv, repo.id, side, main, {
      author: ada,
      message: 'merge',
    });
    const onto = await edit(main, 'd.txt', 'd\n');
    await expect(replayable(dbEnv, repo.id, onto.id, merged.id)).rejects.toMatchObject({
      code: 'rebase_unsupported',
    });
  });
});

describe('POST …/pulls/:id/update-branch', () => {
  let owner: Awaited<ReturnType<typeof loginAs>>;
  let reviewer: Awaited<ReturnType<typeof loginAs>>;
  let base: Changeset;
  let head: Changeset;

  async function api(
    tail: string,
    method = 'GET',
    body?: unknown,
    actor = owner,
  ): Promise<Response> {
    return makeApp(dbEnv)(
      new Request(`https://x/api/v1/repos/team/rebase${tail}`, {
        method,
        headers: { ...actor.headers, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  }

  async function openPull(): Promise<Pull> {
    const res = await api('/pulls', 'POST', { title: 'Change b', head_cs: head.id });
    expect(res.status).toBe(201);
    return ((await res.json()) as { pull: Pull }).pull;
  }

  async function update(pull: Pull, method?: string, actor = owner): Promise<Response> {
    return api(
      `/pulls/${pull.id}/update-branch`,
      'POST',
      { head_cs: pull.head_cs, revision: pull.revision, ...(method ? { method } : {}) },
      actor,
    );
  }

  beforeEach(async () => {
    owner = await loginAs(testEnv, 901, 'owner');
    reviewer = await loginAs(testEnv, 902, 'reviewer');
    await run(testEnv, 'UPDATE repos SET created_by = ? WHERE id = ?', [
      owner.userId,
      repo.id,
    ]);
    await run(
      testEnv,
      "INSERT INTO repo_members(repo_id,user_id,role) VALUES (?,?,'write')",
      [repo.id, reviewer.userId],
    );
    base = await edit(null, 'a.txt', 'a\n');
    await setRef(dbEnv, repo.id, 'main', base.id);
    head = await edit(base, 'b.txt', 'b\n', { author: bob });
  });

  it('merges the moved target into the pull request as a new revision', async () => {
    const pull = await openPull();
    expect((await update(pull)).status).toBe(409); // already up to date
    const moved = await edit(base, 'c.txt', 'c\n');
    await setRef(dbEnv, repo.id, 'main', moved.id);
    const res = await update(pull);
    expect(res.status).toBe(200);
    const updated = ((await res.json()) as { pull: Pull }).pull;
    expect(updated).toMatchObject({ base_cs: moved.id, revision: pull.revision + 1 });
    const tip = await load(updated.head_cs);
    expect(tip.parents).toEqual([head.id, moved.id]);
    expect(tip.author).toEqual({ name: 'owner', email: 'owner@users.yuma-agent-git' });
    // the target never moved, and the stale revision can no longer be used
    expect((await getRef(dbEnv, repo.id, 'main'))?.head).toBe(moved.id);
    expect((await update(pull)).status).toBe(409);
    const audit = await testEnv.DB.prepare(
      "SELECT target FROM audit_events WHERE action = 'pull.update_branch'",
    ).first<{ target: string }>();
    expect(JSON.parse(audit?.target ?? '{}')).toMatchObject({ head_cs: updated.head_cs });
  });

  it('rebases the pull request onto the target and resets approvals', async () => {
    const pull = await openPull();
    await api(
      `/pulls/${pull.id}/review`,
      'POST',
      { head_cs: head.id, revision: pull.revision, decision: 'approve', body: '' },
      reviewer,
    );
    const moved = await edit(base, 'c.txt', 'c\n');
    await setRef(dbEnv, repo.id, 'main', moved.id);
    const res = await update(pull, 'rebase', reviewer);
    expect(res.status).toBe(200);
    const updated = ((await res.json()) as { pull: Pull }).pull;
    const tip = await load(updated.head_cs);
    expect(tip.parents).toEqual([moved.id]);
    expect(tip.author).toEqual(bob);
    expect(tip.committer?.name).toBe('reviewer');
    const detail = (await (await api(`/pulls/${pull.id}`)).json()) as {
      gate: { mergeable: boolean; reasons: string[] };
    };
    expect(detail.gate.reasons).toContain('1 approval required for this revision.');
  });

  it('reports conflicts and leaves the pull request alone', async () => {
    const pull = await openPull();
    const moved = await edit(base, 'b.txt', 'other\n');
    await setRef(dbEnv, repo.id, 'main', moved.id);
    for (const method of ['merge', 'rebase']) {
      const res = await update(pull, method);
      expect(res.status).toBe(409);
      expect(
        ((await res.json()) as { error: Record<string, unknown> }).error,
      ).toMatchObject({
        code: 'merge_conflict',
        conflicts: [{ path: 'b.txt', kind: 'add_add' }],
      });
    }
    const after = ((await (await api(`/pulls/${pull.id}`)).json()) as { pull: Pull })
      .pull;
    expect(after).toMatchObject({ head_cs: head.id, revision: pull.revision });
  });

  it('hides private pull requests from strangers and refuses readers', async () => {
    const pull = await openPull();
    const stranger = await loginAs(testEnv, 903, 'stranger');
    expect((await update(pull, undefined, stranger)).status).toBe(404);
    expect(
      (await api(`/pulls/${pull.id}/conflicts`, 'GET', undefined, stranger)).status,
    ).toBe(404);
    const reader = await loginAs(testEnv, 904, 'reader');
    await run(
      testEnv,
      "INSERT INTO repo_members(repo_id,user_id,role) VALUES (?,?,'read')",
      [repo.id, reader.userId],
    );
    expect((await update(pull, undefined, reader)).status).toBe(403);
    expect(
      (await api(`/pulls/${pull.id}/conflicts`, 'GET', undefined, reader)).status,
    ).toBe(200);
  });
});
