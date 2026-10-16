import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { cleanDb, loginAs, makeApp, seedSchema, type TestEnv } from './helpers';
import { createRepo } from '../src/db/repos';
import { q, run } from '../src/db/client';
import { createApiToken } from '../src/auth/tokens';
import { expireLeases, fieldsFromLabels } from '../src/collab/work';
import type { WorkEvent, WorkItem } from '../shared/work';

const testEnv = env as unknown as TestEnv;
const dbEnv = testEnv as unknown as Env;
const app = makeApp(testEnv);

type Actor = { headers: Record<string, string> };
type Login = Awaited<ReturnType<typeof loginAs>>;
let owner: Login;
let reader: Login;
let triager: Login;
let ownerToken = '';

async function call(
  actor: Actor | null,
  method: string,
  tail: string,
  body?: unknown,
): Promise<Response> {
  return app(
    new Request(`https://x/api/v1/repos/acme/app${tail}`, {
      method,
      headers: { ...(actor?.headers ?? {}), 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

async function json<T>(res: Response, status = 200): Promise<T> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  return JSON.parse(text) as T;
}

async function openIssue(title: string, labels: string[] = []): Promise<number> {
  const res = await call(owner, 'POST', '/issues', { title, labels });
  return (await json<{ issue: { number: number } }>(res, 201)).issue.number;
}

async function setWork(
  number: number,
  fields: Record<string, unknown>,
  actor: Actor = owner,
): Promise<WorkItem> {
  const res = await call(actor, 'PUT', `/work/${number}`, fields);
  return (await json<{ item: WorkItem }>(res)).item;
}

async function claim(actor: Actor, body: Record<string, unknown> = {}) {
  return json<{ item: WorkItem | null }>(await call(actor, 'POST', '/work/claim', body));
}

const bearer = (token: string): Actor => ({
  headers: { authorization: `Bearer ${token}` },
});

/** An agent identity with `maxRisk`, and a delegated token carrying `scope`. */
async function agentActor(
  maxRisk: string,
  scope = 'contents:read contents:write queue:claim',
  kind = 'codex',
): Promise<{ actor: Actor; id: string }> {
  const created = await app(
    new Request('https://x/api/v1/agents', {
      method: 'POST',
      headers: { ...owner.headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Worker',
        kind,
        max_risk: maxRisk,
        max_scopes: ['contents:read', 'contents:write', 'queue:claim', 'queue:approve'],
      }),
    }),
  );
  const agent = await json<{ id: string; max_risk: string }>(created, 201);
  expect(agent.max_risk).toBe(maxRisk);
  const form = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    subject_token: ownerToken,
    agent_id: agent.id,
    resource: 'acme/app',
    scope,
  });
  const res = await app(
    new Request('https://x/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
    }),
  );
  const token = (await json<{ access_token: string }>(res)).access_token;
  return { actor: bearer(token), id: agent.id };
}

async function auditActions(): Promise<string[]> {
  return (
    await q<{ action: string }>(
      dbEnv,
      "SELECT action FROM audit_events WHERE action LIKE 'work.%' ORDER BY id",
    )
  ).map((r) => r.action);
}

beforeEach(async () => {
  await seedSchema(testEnv);
  await cleanDb(testEnv);
  owner = await loginAs(testEnv, 1, 'owner');
  reader = await loginAs(testEnv, 2, 'reader');
  triager = await loginAs(testEnv, 3, 'triager');
  const repo = await createRepo(dbEnv, { slug: 'acme/app', createdBy: owner.userId });
  for (const [user, role] of [
    [reader, 'read'],
    [triager, 'triage'],
  ] as const) {
    await run(dbEnv, 'INSERT INTO repo_members (repo_id, user_id, role) VALUES (?,?,?)', [
      repo.id,
      user.userId,
      role,
    ]);
  }
  ownerToken = (
    await createApiToken(dbEnv, owner.userId, {
      label: 'delegate',
      scopes: ['repo:read', 'repo:write', 'agent:run'],
    })
  ).raw;
});

describe('work queue (#59)', () => {
  it('50 concurrent claims on 10 ready items return 10 distinct items and 40 nulls', async () => {
    for (let i = 0; i < 10; i++) {
      await setWork(await openIssue(`Task ${i}`), { readiness: 'ready', priority: i });
    }
    const results = await Promise.all(
      Array.from({ length: 50 }, () => claim(owner, { lease_seconds: 600 })),
    );
    const claimed = results.flatMap((r) => (r.item ? [r.item.number] : []));
    expect(claimed).toHaveLength(10);
    expect(new Set(claimed).size).toBe(10);
    expect(results.filter((r) => r.item === null)).toHaveLength(40);
    const items = (
      await json<{ items: WorkItem[] }>(
        await call(owner, 'GET', '/work?readiness=claimed'),
      )
    ).items;
    expect(items).toHaveLength(10);
    expect(items.every((i) => i.claimed_by === `user:${owner.userId}`)).toBe(true);
    expect((await auditActions()).filter((a) => a === 'work.claim')).toHaveLength(10);
  });

  it('claims the highest priority first and refuses an unqueued item', async () => {
    const low = await openIssue('Low');
    const high = await openIssue('High');
    await setWork(low, { readiness: 'ready', priority: 1 });
    await setWork(high, { readiness: 'ready', priority: 5 });
    expect((await claim(owner)).item?.number).toBe(high);
    expect((await claim(owner)).item?.number).toBe(low);
    expect((await claim(owner)).item).toBeNull();
    const draft = await openIssue('Not queued');
    expect((await call(owner, 'GET', `/work/${draft}`)).status).toBe(404);
  });

  it('returns a claim whose lease expires without a heartbeat to ready with attempts+1', async () => {
    const n = await openIssue('Flaky');
    await setWork(n, { readiness: 'ready' });
    const first = (await claim(owner, { lease_seconds: 60 })).item!;
    expect(first).toMatchObject({ number: n, readiness: 'claimed', attempts: 0 });

    // a heartbeat extends a live lease; nobody else can renew it
    const beat = await json<{ lease_expires_at: number }>(
      await call(owner, 'POST', `/work/${n}/heartbeat`, { lease_seconds: 120 }),
    );
    expect(beat.lease_expires_at).toBeGreaterThan(first.lease_expires_at!);
    const other = await call(triager, 'POST', `/work/${n}/heartbeat`, {});
    expect(other.status).toBe(403); // triage cannot claim or heartbeat at all

    // the cron sweep runs after the lease ran out
    expect(await expireLeases(dbEnv, beat.lease_expires_at + 1)).toBe(1);
    const back = (
      await json<{ item: WorkItem; events: WorkEvent[] }>(
        await call(owner, 'GET', `/work/${n}`),
      )
    ).item;
    expect(back).toMatchObject({
      readiness: 'ready',
      attempts: 1,
      claimed_by: null,
      lease_expires_at: null,
    });
    const lost = await call(owner, 'POST', `/work/${n}/heartbeat`, {});
    expect(lost.status).toBe(409);
    expect(((await lost.json()) as { error: { code: string } }).error.code).toBe(
      'lease_lost',
    );
    const expiry = await q<{ actor_kind: string; target: string }>(
      dbEnv,
      "SELECT actor_kind, target FROM audit_events WHERE action = 'work.expire'",
    );
    expect(expiry).toHaveLength(1);
    expect(expiry[0]!.actor_kind).toBe('system');
    expect(JSON.parse(expiry[0]!.target)).toMatchObject({ number: n, attempts: 1 });

    // a stale lease also returns on the next claim, which may take it again
    await run(
      dbEnv,
      'UPDATE work_items SET readiness = ?, claimed_by = ?, lease_expires_at = ?',
      ['claimed', 'user:gone', Date.now() - 1],
    );
    expect((await claim(owner)).item).toMatchObject({ number: n, attempts: 2 });
  });

  it('releases a claim to review, done or back to the queue', async () => {
    const n = await openIssue('Ship it');
    await setWork(n, { readiness: 'ready' });
    await claim(owner);
    const reviewed = await json<{ item: WorkItem }>(
      await call(owner, 'POST', `/work/${n}/release`, {
        outcome: 'in-review',
        reason: 'PR opened',
      }),
    );
    expect(reviewed.item).toMatchObject({ readiness: 'in-review', claimed_by: null });
    expect(
      (await call(owner, 'POST', `/work/${n}/release`, { outcome: 'done' })).status,
    ).toBe(409);
    const detail = await json<{ events: WorkEvent[] }>(
      await call(owner, 'GET', `/work/${n}`),
    );
    expect(detail.events[0]).toMatchObject({
      kind: 'released',
      from_readiness: 'claimed',
      to_readiness: 'in-review',
      reason: 'PR opened',
    });
    expect(await auditActions()).toEqual(['work.update', 'work.claim', 'work.release']);
  });

  it('never returns an item with an open dependency', async () => {
    const base = await openIssue('Schema');
    const dependent = await openIssue('API on schema');
    await setWork(dependent, { readiness: 'ready', priority: 10, depends_on: [base] });
    const listed = await json<{ items: WorkItem[] }>(await call(owner, 'GET', '/work'));
    expect(listed.items[0]).toMatchObject({ depends_on: [base], waiting_on: [base] });
    expect((await claim(owner)).item).toBeNull();

    // its dependency's work being done unblocks it, as does closing the issue
    await setWork(base, { readiness: 'done' });
    expect((await claim(owner)).item?.number).toBe(dependent);

    const later = await openIssue('Later');
    const after = await openIssue('After later');
    await setWork(after, { readiness: 'ready', depends_on: [later] });
    expect((await claim(owner)).item).toBeNull();
    await json(await call(owner, 'PATCH', `/issues/${later}`, { state: 'closed' }));
    expect((await claim(owner)).item?.number).toBe(after);

    // no self or circular waits, no unknown issues
    expect(
      (await call(owner, 'PUT', `/work/${later}`, { depends_on: [later] })).status,
    ).toBe(400);
    expect(
      (await call(owner, 'PUT', `/work/${later}`, { depends_on: [after] })).status,
    ).toBe(409);
    expect(
      (await call(owner, 'PUT', `/work/${later}`, { depends_on: [999] })).status,
    ).toBe(400);
  });

  it('never gives an agent allowed risk<=medium a high item', async () => {
    const high = await openIssue('Risky migration');
    const medium = await openIssue('Normal change');
    await setWork(high, { readiness: 'ready', risk: 'high', priority: 100 });
    await setWork(medium, { readiness: 'ready', risk: 'medium' });
    const agent = await agentActor('medium');
    // asking for more than the agent's allowance does not lift it
    const got = await claim(agent.actor, { max_risk: 'high' });
    expect(got.item).toMatchObject({ number: medium, claimed_by: `agent:${agent.id}` });
    expect((await claim(agent.actor, { max_risk: 'high' })).item).toBeNull();
    const audit = await q<{ actor_kind: string; on_behalf_of: string }>(
      dbEnv,
      "SELECT actor_kind, on_behalf_of FROM audit_events WHERE action = 'work.claim'",
    );
    expect(audit).toEqual([{ actor_kind: 'agent', on_behalf_of: owner.userId }]);
    // a person may cap their own claim too
    expect((await claim(owner, { max_risk: 'medium' })).item).toBeNull();
    expect((await claim(owner)).item?.number).toBe(high);
  });

  it('matches the required agent kind and demands queue:claim from agent tokens', async () => {
    const n = await openIssue('Codex only');
    await setWork(n, { readiness: 'ready', risk: 'low', agent_kind: 'codex' });
    const claude = await agentActor('high', undefined, 'claude_code');
    expect((await claim(claude.actor)).item).toBeNull();
    const unscoped = await agentActor('high', 'contents:read contents:write');
    const denied = await call(unscoped.actor, 'POST', '/work/claim', {});
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: { code: string } }).error.code).toBe(
      'insufficient_scope',
    );
    const codex = await agentActor('low');
    expect((await claim(codex.actor)).item?.number).toBe(n);
  });

  it('lets only people with triage or agents with queue:approve mark work ready', async () => {
    const n = await openIssue('Needs approval');
    const agent = await agentActor('high');
    const refused = await call(agent.actor, 'PUT', `/work/${n}`, { readiness: 'ready' });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      'approval_required',
    );
    expect((await call(agent.actor, 'PUT', `/work/${n}`, { risk: 'low' })).status).toBe(
      403,
    );
    // agents may still prepare work
    expect(
      await setWork(n, { readiness: 'needs-prep', priority: 3 }, agent.actor),
    ).toMatchObject({ readiness: 'needs-prep', priority: 3 });
    // an API token is not a person
    expect(
      (await call(bearer(ownerToken), 'PUT', `/work/${n}`, { readiness: 'ready' }))
        .status,
    ).toBe(403);
    // a reader cannot edit work fields at all
    expect((await call(reader, 'PUT', `/work/${n}`, { priority: 1 })).status).toBe(403);
    const approver = await agentActor(
      'high',
      'contents:read contents:write queue:claim queue:approve',
    );
    expect(
      await setWork(n, { readiness: 'ready', reason: 'scoped' }, approver.actor),
    ).toMatchObject({ readiness: 'ready' });
    expect(await setWork(n, { readiness: 'blocked' }, triager)).toMatchObject({
      readiness: 'blocked',
    });
    const detail = await json<{ events: WorkEvent[] }>(
      await call(owner, 'GET', `/work/${n}`),
    );
    expect(
      detail.events.map((e) => [e.from_readiness, e.to_readiness, e.reason]),
    ).toEqual([
      ['ready', 'blocked', null],
      ['needs-prep', 'ready', 'scoped'],
      ['draft', 'needs-prep', null],
    ]);
  });

  it('imports yuma:ready and yuma:risk:low labels as readiness ready and risk low', async () => {
    for (const name of ['yuma:ready', 'yuma:risk:low', 'yuma:plan', 'yuma:waits-on']) {
      await json(await call(owner, 'POST', '/labels', { name, color: '#0e8a16' }), 201);
    }
    const ready = await openIssue('From Factory', ['yuma:ready', 'yuma:risk:low']);
    const waiting = await openIssue('Waiting', [
      'yuma:ready',
      'yuma:waits-on',
      'yuma:plan',
    ]);
    await openIssue('Unlabelled');
    expect((await call(triager, 'POST', '/work/import-labels', {})).status).toBe(200); // triagers approve
    const items = (await json<{ items: WorkItem[] }>(await call(owner, 'GET', '/work')))
      .items;
    expect(items.find((i) => i.number === ready)).toMatchObject({
      readiness: 'ready',
      risk: 'low',
    });
    expect(items.find((i) => i.number === waiting)).toMatchObject({
      readiness: 'blocked',
      risk: 'medium',
      plan: true,
    });
    expect(items).toHaveLength(2);
    // a second import changes nothing
    expect(
      await json<{ imported: number[] }>(
        await call(owner, 'POST', '/work/import-labels', {}),
      ),
    ).toEqual({ imported: [] });
    expect(
      (await call(bearer(ownerToken), 'POST', '/work/import-labels', {})).status,
    ).toBe(403);
    expect(fieldsFromLabels(['Yuma:Risk:High', 'yuma:risk:low', 'yuma:done'])).toEqual({
      readiness: 'done',
      risk: 'high',
      plan: false,
    });
    expect(fieldsFromLabels(['bug'])).toBeNull();
  });

  it('moves a ready item back to needs-prep when a non-approver edits its body', async () => {
    const created = await call(reader, 'POST', '/issues', {
      title: 'Reader idea',
      body: 'v1',
    });
    const n = (await json<{ issue: { number: number } }>(created, 201)).issue.number;
    await setWork(n, { readiness: 'ready' });
    // an approver's edit keeps the approval
    await json(await call(owner, 'PATCH', `/issues/${n}`, { body: 'v2' }));
    expect((await setWork(n, {})).readiness).toBe('ready');
    // the author (read access only) edits it: approval is stale
    await json(await call(reader, 'PATCH', `/issues/${n}`, { body: 'v3, now bigger' }));
    const after = await json<{ item: WorkItem; events: WorkEvent[] }>(
      await call(owner, 'GET', `/work/${n}`),
    );
    expect(after.item.readiness).toBe('needs-prep');
    expect(after.events[0]).toMatchObject({
      actor: `user:${reader.userId}`,
      from_readiness: 'ready',
      to_readiness: 'needs-prep',
      reason: 'body edited after approval',
    });
    // a title-only edit is not a body edit
    await setWork(n, { readiness: 'ready' });
    await json(await call(reader, 'PATCH', `/issues/${n}`, { title: 'Renamed' }));
    expect((await setWork(n, {})).readiness).toBe('ready');
  });

  it('deletes an issue together with its work item and dependencies', async () => {
    const a = await openIssue('A');
    const b = await openIssue('B');
    await setWork(b, { depends_on: [a] });
    await setWork(a, { readiness: 'ready' });
    await json(await call(owner, 'DELETE', `/issues/${a}`));
    expect(
      (await json<{ items: WorkItem[] }>(await call(owner, 'GET', '/work'))).items,
    ).toEqual([expect.objectContaining({ number: b, depends_on: [] })]);
  });
});
