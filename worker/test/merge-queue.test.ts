import { beforeEach, describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import type { Env } from '../src/env';
import { cleanDb, loginAs, makeApp, seedSchema, type TestEnv } from './helpers';
import {
  blob,
  commit as gitCommit,
  packOf,
  parseReport,
  pushBody,
  tree,
  ZERO,
} from './git-helpers';
import { createRepo, getRef, setRef } from '../src/db/repos';
import { commitChanges } from '../src/core/commit';
import { getChangeset } from '../src/core/changesets';
import { getTree } from '../src/core/trees';
import { q, q1, run } from '../src/db/client';
import { createApiToken } from '../src/auth/tokens';
import { advancePipelines } from '../src/ci/planner';
import { MergeQueueDO, queueName, type QueueView } from '../src/queue/mergeQueue';
import type { ForgeEvent } from '../src/webhooks/events';
import type { Pull } from '../shared/collaboration';

/**
 * Merge queue (issue #43): batched strict groups tested by `merge_group`
 * pipelines, bisection on failure, optimistic landing with automatic revert,
 * the `merge_queue` ruleset rule on every ref-moving path, and queue state
 * that outlives the Durable Object instance.
 */

const testEnv = env as unknown as TestEnv;
const dbEnv = testEnv as unknown as Env;
const SPEC = '.yuma/pipelines/queue.yml';
const GROUP_PIPELINE = `on: [merge_group]
jobs:
  test:
    steps: [{ run: npm test }]
`;
const author = { name: 'Ada', email: 'ada@example.com' };
type Login = Awaited<ReturnType<typeof loginAs>>;
let owner: Login;
let reviewer: Login;
let repoId = '';
let seed = '';
let events: ForgeEvent[] = [];

/** CI on: queue sends are dropped (tests finish runs by hand), runner calls succeed. */
function ci(): Env {
  return new Proxy(dbEnv, {
    get(target, key, receiver) {
      if (key === 'CI_ENABLED') return 'true';
      if (key === 'CI_QUEUE') return { send: async () => undefined };
      if (key === 'CI_RUNNER')
        return {
          idFromName: (id: string) => id,
          get: () => ({ fetch: async () => Response.json({ ok: true }) }),
        };
      if (key === 'EVENTS_QUEUE')
        return { send: async (m: { event: ForgeEvent }) => void events.push(m.event) };
      return Reflect.get(target, key, receiver);
    },
  });
}

/** The API with CI off, as the merge queue's own Durable Object sees it in tests. */
const app = makeApp(
  new Proxy(dbEnv, {
    get: (target, key, receiver) =>
      key === 'EVENTS_QUEUE'
        ? { send: async (m: { event: ForgeEvent }) => void events.push(m.event) }
        : Reflect.get(target, key, receiver),
  }),
);

async function api(
  tail: string,
  method = 'GET',
  body?: unknown,
  actor: { headers: Record<string, string> } = owner,
): Promise<Response> {
  return app(
    new Request(`https://x/api/v1/repos/team/queue${tail}`, {
      method,
      headers: { ...actor.headers, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

async function json<T>(res: Response, status = 200): Promise<T> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  return JSON.parse(text) as T;
}

async function commit(parent: string | null, files: Record<string, string>) {
  return (
    await commitChanges(dbEnv, repoId, {
      first_parent: parent,
      message: `add ${Object.keys(files).join(', ')}`,
      author,
      changes: Object.entries(files).map(([path, text]) => ({
        path,
        op: 'add' as const,
        content_b64: btoa(text),
      })),
    })
  ).changeset.id;
}

async function queueRule(mode: 'strict' | 'optimistic', maxBatch: number) {
  await json(
    await api('/rulesets', 'POST', {
      name: 'Merge queue',
      target: 'branch',
      conditions: { ref_name: { include: ['~DEFAULT_BRANCH'] } },
      rules: [{ type: 'merge_queue', mode, max_batch: maxBatch }],
    }),
    201,
  );
}

/** An approved pull request that adds `file` to the seed revision. */
async function approved(file: string, body = ''): Promise<Pull> {
  const head = await commit(seed, { [file]: `${file}\n` });
  const { pull } = await json<{ pull: Pull }>(
    await api('/pulls', 'POST', { title: `Add ${file}`, body, head_cs: head }),
    201,
  );
  await json(
    await api(
      `/pulls/${pull.id}/review`,
      'POST',
      { head_cs: head, revision: 1, decision: 'approve', body: 'ok' },
      reviewer,
    ),
  );
  return pull;
}

async function enqueue(pull: Pull, priority = 0): Promise<void> {
  await json(
    await api(`/pulls/${pull.id}/queue`, 'POST', {
      head_cs: pull.head_cs,
      revision: pull.revision,
      priority,
    }),
    201,
  );
}

function stub(): DurableObjectStub {
  const ns = testEnv.MERGE_QUEUE;
  return ns.get(ns.idFromName(queueName(repoId, 'main')));
}

/**
 * One alarm of the queue with CI on, in a fresh `MergeQueueDO` instance on the
 * queue's own storage: what a restarted Durable Object does.
 */
async function tick(): Promise<void> {
  await runInDurableObject(stub(), async (_old, state) => {
    await new MergeQueueDO(state, ci()).alarm();
  });
}

async function hasFile(cs: string, name: string): Promise<boolean> {
  const root = (await getChangeset(dbEnv, repoId, cs))?.root_tree ?? null;
  const entries = root ? ((await getTree(dbEnv, repoId, root))?.entries ?? []) : [];
  return entries.some((e) => e.name === name);
}

/** Finish every running `merge_group` job as the runner would: failing when `bad.txt` is in. */
async function finishChecks(): Promise<number> {
  const jobs = await q<{ id: string; head_cs: string }>(
    dbEnv,
    `SELECT r.id, p.head_cs FROM ci_runs r JOIN ci_pipeline_runs p ON p.id = r.pipeline_run_id
      WHERE p.event = 'merge_group' AND r.state IN ('queued','running')`,
  );
  for (const job of jobs)
    await run(dbEnv, 'UPDATE ci_runs SET state = ?, finished_at = ? WHERE id = ?', [
      (await hasFile(job.head_cs, 'bad.txt')) ? 'failed' : 'passed',
      Date.now(),
      job.id,
    ]);
  await advancePipelines(ci());
  return jobs.length;
}

/** Run checks and ticks until the queue is empty. */
async function drain(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await tick();
    const busy = await q1(
      dbEnv,
      `SELECT 1 FROM merge_queue_entries WHERE state IN ('queued','testing')
       UNION ALL SELECT 1 FROM merge_groups WHERE finished_at IS NULL`,
    );
    if (!busy) return;
    await finishChecks();
  }
  throw new Error('the queue did not drain');
}

async function view(): Promise<QueueView> {
  return json<QueueView>(await api('/merge-queue'));
}

const groupRuns = async (): Promise<number> =>
  (await q1<{ n: number }>(
    dbEnv,
    "SELECT COUNT(*) AS n FROM ci_pipeline_runs WHERE event = 'merge_group'",
  ))!.n;

const pullOf = async (id: number): Promise<Pull> =>
  (await json<{ pull: Pull }>(await api(`/pulls/${id}`))).pull;

beforeEach(async () => {
  await seedSchema(testEnv);
  await cleanDb(testEnv);
  events = [];
  owner = await loginAs(testEnv, 901, 'owner');
  reviewer = await loginAs(testEnv, 902, 'reviewer');
  repoId = (await createRepo(dbEnv, { slug: 'team/queue', createdBy: owner.userId })).id;
  await run(
    dbEnv,
    "INSERT INTO repo_members(repo_id,user_id,role) VALUES (?,?,'write')",
    [repoId, reviewer.userId],
  );
  seed = await commit(null, { 'README.md': 'hello\n', [SPEC]: GROUP_PIPELINE });
  await setRef(dbEnv, repoId, 'main', seed);
  await run(
    dbEnv,
    `INSERT INTO webhooks (id, scope, owner_id, url, secret_ciphertext, key_owner, key_version,
                           events, created_by, created_at, updated_at)
     VALUES ('hook', 'repo', ?, 'https://hooks.example.com', 'x', 'x', 1, ?, ?, 0, 0)`,
    [repoId, JSON.stringify(['pull_request', 'merge_group']), owner.userId],
  );
});

describe('strict merge queue', () => {
  it('lands 20 approved pull requests in fewer CI runs than pull requests, green on the final head', async () => {
    await queueRule('strict', 10);
    const pulls: Pull[] = [];
    for (let i = 1; i <= 20; i++) pulls.push(await approved(`f${i}.txt`));
    for (const pull of pulls) await enqueue(pull);
    // CI is off for the queue's own instance: nothing is built until checks can run
    expect(await groupRuns()).toBe(0);
    const queued = await view();
    expect(queued.enabled).toBe(true);
    expect(queued.entries.map((e) => e.state)).toEqual(Array(20).fill('queued'));

    await drain();
    expect(await groupRuns()).toBe(2);
    for (const pull of pulls) expect((await pullOf(pull.id)).state).toBe('merged');
    const head = (await getRef(dbEnv, repoId, 'main'))!.head;
    for (let i = 1; i <= 20; i++) expect(await hasFile(head, `f${i}.txt`)).toBe(true);
    // the last group's checks ran on exactly what main now points at, and passed
    const last = await q<{ id: string }>(
      dbEnv,
      "SELECT id FROM ci_pipeline_runs WHERE event = 'merge_group' AND head_cs = ?",
      [head],
    );
    expect(last).toHaveLength(1);
    const runs = (
      await json<{ runs: { id: string; state: string; event: string }[] }>(
        await api(`/ci/pipelines?head=${head}`),
      )
    ).runs;
    expect(runs.find((r) => r.id === last[0]!.id)).toMatchObject({
      state: 'passed',
      event: 'merge_group',
    });
    const groups = (await view()).groups;
    expect(groups.map((g) => [g.state, g.pull_ids.length])).toEqual([
      ['merged', 10],
      ['merged', 10],
    ]);
    // one audit event per land, webhooks for groups and pull requests
    expect(
      (await q(dbEnv, "SELECT id FROM audit_events WHERE action = 'merge_queue.land'"))
        .length,
    ).toBe(2);
    expect(
      (await q(dbEnv, "SELECT id FROM audit_events WHERE action = 'merge_queue.enqueue'"))
        .length,
    ).toBe(20);
    expect(events.filter((e) => e.event === 'merge_group').map((e) => e.action)).toEqual([
      'checks_requested',
      'destroyed',
      'checks_requested',
      'destroyed',
    ]);
    expect(
      events.filter((e) => e.event === 'pull_request' && e.action === 'enqueued'),
    ).toHaveLength(20);
    expect(
      events.filter((e) => e.event === 'pull_request' && e.action === 'closed'),
    ).toHaveLength(20);
  }, 120_000);

  it('bisects a failing group of five, ejects the one failing pull request and lands the other four', async () => {
    await queueRule('strict', 5);
    const issue = (
      await json<{ issue: { number: number } }>(
        await api('/issues', 'POST', { title: 'Break the build' }),
        201,
      )
    ).issue.number;
    await json(await api(`/work/${issue}`, 'PUT', { readiness: 'ready' }));
    await run(dbEnv, "UPDATE work_items SET readiness = 'in-review' WHERE repo_id = ?", [
      repoId,
    ]);
    const pulls = [
      await approved('a.txt'),
      await approved('b.txt'),
      await approved('bad.txt', `Closes #${issue}`),
      await approved('c.txt'),
      await approved('d.txt'),
    ];
    for (const pull of pulls) await enqueue(pull);
    await drain();

    const states = await Promise.all(pulls.map(async (p) => (await pullOf(p.id)).state));
    expect(states).toEqual(['merged', 'merged', 'open', 'merged', 'merged']);
    const head = (await getRef(dbEnv, repoId, 'main'))!.head;
    expect(await hasFile(head, 'bad.txt')).toBe(false);
    for (const f of ['a.txt', 'b.txt', 'c.txt', 'd.txt'])
      expect(await hasFile(head, f)).toBe(true);
    // [a..d] fails, [a,b] lands, [bad,c] fails, [bad] fails and leaves, [c,d] lands
    expect(
      (await view()).groups.map((g) => [g.state, g.pull_ids.length]).reverse(),
    ).toEqual([
      ['failed', 5],
      ['merged', 2],
      ['failed', 2],
      ['failed', 1],
      ['merged', 2],
    ]);
    const ejected = (await view()).entries.find((e) => e.pull_id === pulls[2]!.id)!;
    expect(ejected).toMatchObject({ state: 'ejected' });
    expect(ejected.reason).toContain('checks failed');
    const comment = await q1<{ author_id: string; body: string }>(
      dbEnv,
      "SELECT author_id, body FROM pull_reviews WHERE pull_id = ? AND decision = 'comment'",
      [pulls[2]!.id],
    );
    expect(comment).toMatchObject({ author_id: 'merge-queue' });
    expect(comment!.body).toContain('Removed from the merge queue');
    // the work it was closing goes back to the work queue
    expect(
      await q1(dbEnv, 'SELECT readiness FROM work_items WHERE repo_id = ?', [repoId]),
    ).toEqual({ readiness: 'ready' });
    expect(
      await q1(
        dbEnv,
        "SELECT 1 AS n FROM audit_events WHERE action = 'merge_queue.eject'",
      ),
    ).not.toBeNull();
  }, 120_000);

  it('orders by priority, then position, and dequeues on request', async () => {
    await queueRule('strict', 1);
    const [a, b, c] = [
      await approved('a.txt'),
      await approved('b.txt'),
      await approved('c.txt'),
    ];
    await enqueue(a!);
    await enqueue(b!);
    await enqueue(c!, 5);
    expect((await view()).entries.map((e) => e.pull_id)).toEqual([c!.id, a!.id, b!.id]);
    await json(await api(`/pulls/${b!.id}/queue`, 'DELETE'));
    expect(
      (
        await json<{ error: { code: string } }>(
          await api(`/pulls/${b!.id}/queue`, 'DELETE'),
          404,
        )
      ).error.code,
    ).toBe('not_queued');
    await drain();
    const groups = (await view()).groups.reverse();
    expect(groups.map((g) => g.pull_ids)).toEqual([[c!.id], [a!.id]]);
    expect((await pullOf(b!.id)).state).toBe('open');
    expect(
      await q1(
        dbEnv,
        "SELECT 1 AS n FROM audit_events WHERE action = 'merge_queue.dequeue'",
      ),
    ).not.toBeNull();
  }, 60_000);

  it('ejects a pull request whose revision changes while it waits', async () => {
    await queueRule('strict', 5);
    const pull = await approved('a.txt');
    await enqueue(pull);
    const next = await commit(pull.head_cs, { 'a2.txt': 'more\n' });
    await json(await api(`/pulls/${pull.id}/update`, 'POST', { head_cs: next }));
    await tick();
    const entry = (await view()).entries[0]!;
    expect(entry).toMatchObject({ state: 'ejected', pull_id: pull.id });
    expect(await groupRuns()).toBe(0);
  });
});

describe('optimistic merge queue', () => {
  it('lands at once and reverts a post-land failure within one check cycle', async () => {
    await queueRule('optimistic', 5);
    const good = await approved('good.txt');
    await enqueue(good);
    await tick();
    // landed before any check finished
    let head = (await getRef(dbEnv, repoId, 'main'))!.head;
    expect(await hasFile(head, 'good.txt')).toBe(true);
    expect((await pullOf(good.id)).state).toBe('merged');
    expect((await view()).groups[0]).toMatchObject({ state: 'landed' });
    await finishChecks();
    await tick();
    expect((await view()).groups[0]).toMatchObject({ state: 'merged' });

    const bad = await approved('bad.txt');
    await enqueue(bad);
    await tick();
    const landed = (await getRef(dbEnv, repoId, 'main'))!.head;
    expect(await hasFile(landed, 'bad.txt')).toBe(true);
    expect(await finishChecks()).toBe(1);
    await tick();

    const group = (await view()).groups[0]!;
    expect(group.state).toBe('reverted');
    expect(group.revert_cs).not.toBeNull();
    head = (await getRef(dbEnv, repoId, 'main'))!.head;
    expect(head).toBe(group.revert_cs);
    const revert = (await getChangeset(dbEnv, repoId, head))!;
    expect(revert.first_parent).toBe(landed);
    expect(revert.message).toContain('Post-land checks failed');
    expect(await hasFile(head, 'bad.txt')).toBe(false);
    expect(await hasFile(head, 'good.txt')).toBe(true);
    const reopened = await pullOf(bad.id);
    expect(reopened).toMatchObject({ state: 'open', revision: 2, merged_cs: null });
    expect(
      events.some(
        (e) =>
          e.event === 'pull_request' &&
          e.action === 'reopened' &&
          (e.data['pull_request'] as Pull).id === bad.id,
      ),
    ).toBe(true);
    expect(
      await q1(
        dbEnv,
        "SELECT 1 AS n FROM audit_events WHERE action = 'merge_queue.revert'",
      ),
    ).not.toBeNull();
  }, 60_000);
});

describe('the merge_queue rule', () => {
  async function gitPush(body: Uint8Array): Promise<ReturnType<typeof parseReport>> {
    const token = await createApiToken(dbEnv, owner.userId, { label: 'git' });
    const res = await app(
      new Request('https://x/team/pushed.git/git-receive-pack', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-git-receive-pack-request',
          authorization: `Basic ${btoa(`git:${token.raw}`)}`,
        },
        body,
      }),
    );
    expect(res.status).toBe(200);
    return parseReport(new Uint8Array(await res.arrayBuffer()));
  }

  it('leaves no ref move around the queue: merges, ref updates and pushes are refused', async () => {
    await queueRule('strict', 5);
    const pull = await approved('a.txt');
    const merge = await json<{ error: { code: string; message: string } }>(
      await api(`/pulls/${pull.id}/merge`, 'POST', {
        head_cs: pull.head_cs,
        revision: pull.revision,
      }),
      409,
    );
    expect(merge.error.code).toBe('merge_blocked');
    expect(merge.error.message).toContain('merge queue');
    expect((await pullOf(pull.id)).state).toBe('open');
    const gate = await json<{ gate: { merge_queue: boolean } }>(
      await api(`/pulls/${pull.id}`),
    );
    expect(gate.gate.merge_queue).toBe(true);

    const moved = await json<{ error: { code: string; rule: string } }>(
      await api('/refs/main', 'PUT', { from: seed, to: pull.head_cs }),
      403,
    );
    expect(moved.error).toMatchObject({ code: 'ruleset_violation', rule: 'merge_queue' });
    expect((await getRef(dbEnv, repoId, 'main'))!.head).toBe(seed);

    // git push: creating the branch is fine, updating it is not
    await createRepo(dbEnv, { slug: 'team/pushed', createdBy: owner.userId });
    await app(
      new Request('https://x/api/v1/repos/team/pushed/rulesets', {
        method: 'POST',
        headers: { ...owner.headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Merge queue',
          target: 'branch',
          conditions: { ref_name: { include: ['main'] } },
          rules: [{ type: 'merge_queue' }],
        }),
      }),
    );
    const one = await blob('one\n');
    const root = await tree([{ name: 'a.txt', sha: one.sha }]);
    const first = await gitCommit(root.sha, [], 'first\n');
    expect(
      (
        await gitPush(
          pushBody(
            [[ZERO, first.sha, 'refs/heads/main']],
            await packOf([first, root, one]),
          ),
        )
      ).refs['refs/heads/main'],
    ).toBe('ok');
    const second = await gitCommit(root.sha, [first.sha], 'second\n');
    const report = await gitPush(
      pushBody([[first.sha, second.sha, 'refs/heads/main']], await packOf([second])),
    );
    expect(report.refs['refs/heads/main']).toContain('merge queue');

    // through the queue it lands: no merge_group pipelines on main here
    await run(dbEnv, 'DELETE FROM ci_pipeline_runs');
    const plain = await commit(null, { 'README.md': 'plain\n' });
    await setRef(dbEnv, repoId, 'main', plain);
    const other = await commit(plain, { 'b.txt': 'b\n' });
    const { pull: queued } = await json<{ pull: Pull }>(
      await api('/pulls', 'POST', { title: 'b', head_cs: other }),
      201,
    );
    await json(
      await api(
        `/pulls/${queued.id}/review`,
        'POST',
        { head_cs: other, revision: 1, decision: 'approve', body: '' },
        reviewer,
      ),
    );
    await enqueue(queued);
    // the queue's own instance lands it on enqueue: nothing to test
    expect((await pullOf(queued.id)).state).toBe('merged');
    expect(await hasFile((await getRef(dbEnv, repoId, 'main'))!.head, 'b.txt')).toBe(
      true,
    );
  }, 60_000);

  it('refuses to queue without the rule, unapproved, stale or with a read-only token', async () => {
    const pull = await approved('a.txt');
    const off = await json<{ error: { code: string } }>(
      await api(`/pulls/${pull.id}/queue`, 'POST', {
        head_cs: pull.head_cs,
        revision: pull.revision,
      }),
      409,
    );
    expect(off.error.code).toBe('merge_queue_off');
    await queueRule('strict', 5);
    const head = await commit(seed, { 'x.txt': 'x\n' });
    const { pull: unapproved } = await json<{ pull: Pull }>(
      await api('/pulls', 'POST', { title: 'x', head_cs: head }),
      201,
    );
    const blocked = await json<{ error: { code: string; message: string } }>(
      await api(`/pulls/${unapproved.id}/queue`, 'POST', { head_cs: head, revision: 1 }),
      409,
    );
    expect(blocked.error).toMatchObject({ code: 'merge_blocked' });
    expect(blocked.error.message).toContain('approval');
    expect(
      (
        await json<{ error: { code: string } }>(
          await api(`/pulls/${pull.id}/queue`, 'POST', { head_cs: 'stale', revision: 1 }),
          409,
        )
      ).error.code,
    ).toBe('pull_stale');
    const reader = await createApiToken(dbEnv, owner.userId, {
      label: 'read',
      scopes: ['repo:read'],
    });
    expect(
      (
        await api(
          `/pulls/${pull.id}/queue`,
          'POST',
          { head_cs: pull.head_cs, revision: pull.revision },
          { headers: { authorization: `Bearer ${reader.raw}` } },
        )
      ).status,
    ).toBe(403);
  });
});

describe('code owners and secret scanning in the queue (#40, #66)', () => {
  it('refuses to queue until a code owner approves', async () => {
    const carol = await loginAs(testEnv, 903, 'carol');
    await run(
      dbEnv,
      "INSERT INTO repo_members(repo_id,user_id,role) VALUES (?,?,'write')",
      [repoId, carol.userId],
    );
    seed = await commit(seed, { '.yuma/CODEOWNERS': '*.txt @carol\n' });
    await setRef(dbEnv, repoId, 'main', seed);
    await json(
      await api('/rulesets', 'POST', {
        name: 'Queue with owners',
        target: 'branch',
        conditions: { ref_name: { include: ['~DEFAULT_BRANCH'] } },
        rules: [
          { type: 'merge_queue', mode: 'strict', max_batch: 5 },
          { type: 'require_code_owner_review' },
        ],
      }),
      201,
    );
    const pull = await approved('owned.txt');
    const refused = await json<{ error: { code: string; message: string } }>(
      await api(`/pulls/${pull.id}/queue`, 'POST', {
        head_cs: pull.head_cs,
        revision: pull.revision,
      }),
      409,
    );
    expect(refused.error.code).toBe('merge_blocked');
    expect(refused.error.message).toContain('Code owner approval required');
    await json(
      await api(
        `/pulls/${pull.id}/review`,
        'POST',
        { head_cs: pull.head_cs, revision: 1, decision: 'approve', body: 'owner ok' },
        carol,
      ),
    );
    await enqueue(pull);
  });

  it('keeps a pull request with an open secret alert on its commits out, and ejects one raised while queued', async () => {
    await queueRule('strict', 5);
    const alert = async (cs: string): Promise<void> =>
      run(
        dbEnv,
        `INSERT INTO secret_alerts (repo_id, detector, secret_hash, path, line, changeset_id, source,
           state, created_by, created_at) VALUES (?, 'aws_access_key_id', ?, 'a.txt', 1, ?, 'history', 'open', 'import', 0)`,
        [repoId, cs, cs],
      );
    const leaked = await approved('leaked.txt');
    await alert(leaked.head_cs);
    const refused = await json<{ error: { code: string; message: string } }>(
      await api(`/pulls/${leaked.id}/queue`, 'POST', {
        head_cs: leaked.head_cs,
        revision: leaked.revision,
      }),
      409,
    );
    expect(refused.error.message).toContain('open secret scanning alert');
    await run(
      dbEnv,
      "UPDATE secret_alerts SET state = 'resolved', resolution = 'revoked'",
    );
    await enqueue(leaked);

    // an alert raised while it waits (a history scan, say) ejects it
    const later = await approved('later.txt');
    await enqueue(later);
    await alert(later.head_cs);
    await tick();
    const entries = (await view()).entries;
    expect(entries.find((e) => e.pull_id === later.id)).toMatchObject({
      state: 'ejected',
    });
    expect((await pullOf(later.id)).state).toBe('open');
  }, 60_000);
});

describe('durability', () => {
  it('keeps the queue in storage: a new Durable Object instance finishes what the last one started', async () => {
    await queueRule('strict', 5);
    const pulls = [await approved('a.txt'), await approved('b.txt')];
    for (const pull of pulls) await enqueue(pull);
    await tick();
    expect((await view()).groups[0]).toMatchObject({ state: 'testing' });
    // the queue's key and its next alarm live in Durable Object storage
    await runInDurableObject(stub(), async (_instance, state) => {
      expect(await state.storage.get('key')).toEqual({
        repo_id: repoId,
        base_ref: 'main',
      });
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
    await finishChecks();
    // `tick` builds a brand-new instance: nothing it needs was held in memory
    await tick();
    for (const pull of pulls) expect((await pullOf(pull.id)).state).toBe('merged');
    expect((await view()).groups[0]).toMatchObject({ state: 'merged' });
  });
});
