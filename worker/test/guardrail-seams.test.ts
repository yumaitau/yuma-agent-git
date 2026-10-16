import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { cleanDb, loginAs, makeApp, seedSchema, type TestEnv } from './helpers';
import { createRepo, setRef } from '../src/db/repos';
import { commitChanges } from '../src/core/commit';
import { q1, run } from '../src/db/client';
import { createApiToken } from '../src/auth/tokens';
import type { ForgeEvent } from '../src/webhooks/events';

/**
 * Wave 2b seams: the agent guardrails (#62) judge queue claims and readiness
 * (#59) and update-branch (#42); webhooks (#75) carry work queue and review
 * thread (#39) events; the resolved-threads rule holds for every merge method.
 */

const testEnv = env as unknown as TestEnv;
const dbEnv = testEnv as unknown as Env;
const author = { name: 'Ada', email: 'ada@example.com' };

type Login = Awaited<ReturnType<typeof loginAs>>;
type Actor = { headers: Record<string, string> };
let owner: Login;
let orgId = '';
let repoId = '';
let mainCs = '';
let delegate = '';
let events: ForgeEvent[] = [];

const app = makeApp(
  new Proxy(testEnv, {
    get: (target, key, receiver) =>
      key === 'EVENTS_QUEUE'
        ? { send: async (m: { event: ForgeEvent }) => void events.push(m.event) }
        : Reflect.get(target, key, receiver),
  }),
);

async function call(
  actor: Actor,
  method: string,
  tail: string,
  body?: unknown,
): Promise<Response> {
  return app(
    new Request(`https://x/api/v1/repos/acme/app${tail}`, {
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

/** The org's agent policy (newest version wins). */
async function policy(rules: unknown[]): Promise<void> {
  await run(
    dbEnv,
    'INSERT INTO agent_policies (org_id, version, document, created_by, created_at) VALUES (?, 1, ?, ?, ?)',
    [orgId, JSON.stringify({ version: 1, rules }), owner.userId, Date.now()],
  );
}

async function agent(scope: string): Promise<Actor> {
  const created = await app(
    new Request('https://x/api/v1/agents', {
      method: 'POST',
      headers: { ...owner.headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Worker',
        kind: 'codex',
        max_risk: 'high',
        max_scopes: [
          'contents:read',
          'contents:write',
          'pulls:write',
          'queue:claim',
          'queue:approve',
        ],
      }),
    }),
  );
  const { id } = await json<{ id: string }>(created, 201);
  const res = await app(
    new Request('https://x/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        subject_token: delegate,
        agent_id: id,
        resource: 'acme/app',
        scope,
      }),
    }),
  );
  const token = (await json<{ access_token: string }>(res)).access_token;
  return { headers: { authorization: `Bearer ${token}` } };
}

async function readyIssue(title: string, risk: string): Promise<number> {
  const opened = await call(owner, 'POST', '/issues', { title });
  const { number } = (await json<{ issue: { number: number } }>(opened, 201)).issue;
  await json(await call(owner, 'PUT', `/work/${number}`, { readiness: 'ready', risk }));
  return number;
}

async function openPull(): Promise<{ id: number; head_cs: string; revision: number }> {
  const head = (
    await commitChanges(dbEnv, repoId, {
      first_parent: mainCs,
      message: 'feature',
      author,
      changes: [{ path: 'b.txt', op: 'add', content_b64: btoa('one\ntwo\n') }],
    })
  ).changeset.id;
  const res = await call(owner, 'POST', '/pulls', { title: 'Add b', head_cs: head });
  return (
    await json<{ pull: { id: number; head_cs: string; revision: number } }>(res, 201)
  ).pull;
}

beforeEach(async () => {
  await seedSchema(testEnv);
  await cleanDb(testEnv);
  events = [];
  owner = await loginAs(testEnv, 1, 'owner');
  await json(
    await app(
      new Request('https://x/api/v1/orgs', {
        method: 'POST',
        headers: { ...owner.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'acme' }),
      }),
    ),
    201,
  );
  orgId = (await q1<{ id: string }>(dbEnv, "SELECT id FROM orgs WHERE slug = 'acme'"))!
    .id;
  repoId = (
    await createRepo(dbEnv, {
      slug: 'acme/app',
      createdBy: owner.userId,
      ownerKind: 'org',
      ownerId: orgId,
    })
  ).id;
  mainCs = (
    await commitChanges(dbEnv, repoId, {
      first_parent: null,
      message: 'seed',
      author,
      changes: [{ path: 'README.md', op: 'add', content_b64: btoa('hello\n') }],
    })
  ).changeset.id;
  await setRef(dbEnv, repoId, 'main', mainCs);
  delegate = (
    await createApiToken(dbEnv, owner.userId, {
      label: 'delegate',
      scopes: ['repo:read', 'repo:write', 'agent:run'],
    })
  ).raw;
  // one repo hook for every event; the fake queue records what is emitted
  await run(
    dbEnv,
    `INSERT INTO webhooks (id, scope, owner_id, url, secret_ciphertext, key_owner, key_version,
                           events, created_by, created_at, updated_at)
     VALUES ('hook', 'repo', ?, 'https://hooks.example.com', 'x', 'x', 1, ?, ?, 0, 0)`,
    [
      repoId,
      JSON.stringify(['pull_request_review_thread', 'work_item', 'pull_request']),
      owner.userId,
    ],
  );
});

describe('merge queue and agents (#43 x #57)', () => {
  it('refuses an agent queueing a pull request, as a direct merge does', async () => {
    await json(
      await call(owner, 'POST', '/rulesets', {
        name: 'Merge queue',
        target: 'branch',
        conditions: { ref_name: { include: ['~DEFAULT_BRANCH'] } },
        rules: [{ type: 'merge_queue', mode: 'strict', max_batch: 1 }],
      }),
      201,
    );
    const pull = await openPull();
    // approved by another writer, so a person could queue it
    const reviewer = await loginAs(testEnv, 2, 'reviewer');
    await run(
      dbEnv,
      "INSERT INTO repo_members (repo_id, user_id, role) VALUES (?, ?, 'write')",
      [repoId, reviewer.userId],
    );
    const body = { head_cs: pull.head_cs, revision: pull.revision };
    await json(
      await call(reviewer, 'POST', `/pulls/${pull.id}/review`, {
        ...body,
        decision: 'approve',
        body: 'ok',
      }),
    );
    const worker = await agent('contents:read contents:write pulls:write');
    const queued = await call(worker, 'POST', `/pulls/${pull.id}/queue`, body);
    expect(queued.status, await queued.clone().text()).toBe(403);
    expect(((await queued.json()) as { error: { code: string } }).error.code).toBe(
      'protected_branch',
    );
    const merged = await call(worker, 'POST', `/pulls/${pull.id}/merge`, body);
    expect(merged.status).toBe(403);
    expect(await q1(dbEnv, 'SELECT id FROM merge_queue_entries')).toBeNull();
  });
});

describe('work queue guardrails (#59 x #62)', () => {
  it('holds an agent claim of high risk work until a person approves it', async () => {
    await policy([
      {
        id: 'risky-claims',
        actions: ['queue.claim'],
        effect: 'require_approval',
        when: { risk: ['high'] },
      },
    ]);
    const number = await readyIssue('Rewrite auth', 'high');
    const worker = await agent('contents:read contents:write queue:claim');
    const held = await call(worker, 'POST', '/work/claim', {});
    const error = (
      await json<{ error: { code: string; approval: { id: string } } }>(held, 403)
    ).error;
    expect(error.code).toBe('approval_required');
    // the claim went straight back to the queue
    expect(await q1(dbEnv, 'SELECT readiness, claimed_by FROM work_items')).toMatchObject(
      { readiness: 'ready', claimed_by: null },
    );
    expect(events.filter((e) => e.event === 'work_item')).toHaveLength(0);

    await json(
      await call(owner, 'POST', `/approvals/${error.approval.id}`, {
        decision: 'approve',
      }),
    );
    const claimed = await json<{ item: { number: number; readiness: string } }>(
      await call(worker, 'POST', '/work/claim', {}),
    );
    expect(claimed.item).toMatchObject({ number, readiness: 'claimed' });
    await json(
      await call(worker, 'POST', `/work/${number}/release`, { outcome: 'done' }),
    );
    expect(
      events
        .filter((e) => e.event === 'work_item')
        .map((e) => [
          e.action,
          e.sender.kind,
          (e.data['work_item'] as { number: number }).number,
        ]),
    ).toEqual([
      ['claimed', 'agent', number],
      ['released', 'agent', number],
    ]);
  });

  it('judges an agent marking work ready as issue.ready; people are not judged', async () => {
    await policy([{ id: 'no-ready', actions: ['issue.ready'], effect: 'deny' }]);
    const opened = await call(owner, 'POST', '/issues', { title: 'Task' });
    const { number } = (await json<{ issue: { number: number } }>(opened, 201)).issue;
    const approver = await agent(
      'contents:read contents:write queue:claim queue:approve',
    );
    const denied = await call(approver, 'PUT', `/work/${number}`, { readiness: 'ready' });
    expect((await json<{ error: { code: string } }>(denied, 403)).error.code).toBe(
      'policy_denied',
    );
    await json(await call(owner, 'PUT', `/work/${number}`, { readiness: 'ready' }));
  });
});

describe('update-branch guardrails (#42 x #62)', () => {
  it('judges an agent update-branch as pr.merge', async () => {
    await policy([{ id: 'no-agent-merges', actions: ['pr.merge'], effect: 'deny' }]);
    const pull = await openPull();
    const worker = await agent('contents:read contents:write pulls:write');
    const denied = await call(worker, 'POST', `/pulls/${pull.id}/update-branch`, {
      head_cs: pull.head_cs,
      revision: pull.revision,
      method: 'rebase',
    });
    const error = (await json<{ error: { code: string; message: string } }>(denied, 403))
      .error;
    expect(error).toMatchObject({ code: 'policy_denied' });
    expect(error.message).toContain('no-agent-merges');
  });
});

describe('review threads (#39) with webhooks (#75) and merge methods (#42)', () => {
  it('emits thread events and blocks a squash until every thread is resolved', async () => {
    await json(
      await call(owner, 'POST', '/rulesets', {
        name: 'threads',
        target: 'branch',
        enforcement: 'active',
        conditions: { ref_name: { include: ['main'], exclude: [] } },
        rules: [
          { type: 'required_review_thread_resolution' },
          { type: 'pull_request', required_approvals: 0 },
        ],
        bypass: [],
      }),
      201,
    );
    const pull = await openPull();
    const at = { head_cs: pull.head_cs, revision: pull.revision };
    const created = await call(owner, 'POST', `/pulls/${pull.id}/threads`, {
      ...at,
      path: 'b.txt',
      side: 'head',
      line: 2,
      body: 'Why two?',
    });
    const { thread } = await json<{ thread: { id: number } }>(created, 201);
    await json(
      await call(owner, 'POST', `/pulls/${pull.id}/threads/${thread.id}/replies`, {
        body: 'Because.',
      }),
      201,
    );
    const blocked = await call(owner, 'POST', `/pulls/${pull.id}/merge`, {
      ...at,
      method: 'squash',
    });
    expect(blocked.status).toBe(409);
    expect(await blocked.text()).toContain('Resolve 1 review thread');
    await json(
      await call(owner, 'PUT', `/pulls/${pull.id}/threads/${thread.id}/resolution`, {
        resolved: true,
      }),
    );
    const merged = await json<{ pull: { state: string; merge_method: string } }>(
      await call(owner, 'POST', `/pulls/${pull.id}/merge`, { ...at, method: 'squash' }),
    );
    expect(merged.pull).toMatchObject({ state: 'merged', merge_method: 'squash' });
    expect(
      events
        .filter((e) => e.event === 'pull_request_review_thread')
        .map((e) => [e.action, (e.data['thread'] as { id: number }).id]),
    ).toEqual([
      ['created', thread.id],
      ['replied', thread.id],
      ['resolved', thread.id],
    ]);
    expect(
      events.filter((e) => e.event === 'pull_request').map((e) => e.action),
    ).toContain('closed');
  });
});
