import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { app as honoApp } from '../src/app';
import { cleanDb, loginAs, makeApp, seedSchema, type TestEnv } from './helpers';
import { createRepo, setRef } from '../src/db/repos';
import { commitChanges } from '../src/core/commit';
import { q, q1, run } from '../src/db/client';
import { createApiToken } from '../src/auth/tokens';
import { appendAudit, type AuditAction } from '../src/audit/record';
import { auditStreamQueue, configuredSink } from '../src/audit/stream';
import { verifyAuditChain } from '../../cli/src/audit';

const testEnv = env as unknown as TestEnv;
const author = { name: 'Ada', email: 'ada@example.com' };
const realFetch = globalThis.fetch;

let admin: Awaited<ReturnType<typeof loginAs>>;
let member: Awaited<ReturnType<typeof loginAs>>;

/** Env with audit admins (and optional stream settings) configured. */
function withAudit(extra: Record<string, unknown> = {}): Env {
  return new Proxy(testEnv, {
    get(target, key, receiver) {
      if (key === 'AUDIT_ADMIN_USER_IDS') return ` other ,${admin.userId}`;
      if (typeof key === 'string' && key in extra) return extra[key];
      return Reflect.get(target, key, receiver);
    },
  });
}

async function call(
  path: string,
  init: RequestInit & { as?: { headers: Record<string, string> } } = {},
  bindings: Env = withAudit(),
): Promise<Response> {
  const headers = {
    'content-type': 'application/json',
    'user-agent': 'audit-test',
    'cf-connecting-ip': '203.0.113.7',
    ...(init.as ?? admin).headers,
    ...(init.headers as Record<string, string> | undefined),
  };
  return makeApp(bindings)(new Request(`https://x${path}`, { ...init, headers }));
}

interface EventRow {
  id: number;
  org_id: string;
  repo_id: string | null;
  actor_kind: string;
  actor_id: string;
  on_behalf_of: string | null;
  action: string;
  target: string;
  ip: string | null;
  user_agent: string | null;
  request_id: string | null;
}

async function events(): Promise<EventRow[]> {
  return q<EventRow>(testEnv, 'SELECT * FROM audit_events ORDER BY id');
}

/** Runs `fn` and asserts it appended exactly one `action` event for this request. */
async function expectOneEvent(
  action: AuditAction,
  fn: () => Promise<Response>,
  status = 200,
): Promise<EventRow & { parsed: Record<string, unknown>; res: Response }> {
  const before = (await events()).length;
  const res = await fn();
  expect(res.status).toBe(status);
  const added = (await events()).slice(before);
  expect(added.map((e) => e.action)).toEqual([action]);
  const event = added[0];
  expect(event.request_id).toMatch(/^[0-9a-f-]{36}$/);
  // raw Response passthroughs (OAuth redirect, ref-lock replies) skip the header
  if (res.headers.has('x-request-id')) {
    expect(event.request_id).toBe(res.headers.get('x-request-id'));
  }
  expect(event.actor_id).not.toBe('');
  return { ...event, parsed: JSON.parse(event.target) as Record<string, unknown>, res };
}

beforeEach(async () => {
  await seedSchema(testEnv);
  await cleanDb(testEnv);
  admin = await loginAs(testEnv, 901, 'auditor');
  member = await loginAs(testEnv, 902, 'member');
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('audit events', () => {
  it('records each security action once with actor, target and request id', async () => {
    const created = await expectOneEvent(
      'repo.create',
      () =>
        call('/api/v1/repos', {
          method: 'POST',
          body: JSON.stringify({ slug: 'acme/app' }),
        }),
      201,
    );
    expect(created).toMatchObject({
      org_id: 'acme',
      actor_kind: 'user',
      actor_id: admin.userId,
      ip: '203.0.113.7',
      user_agent: 'audit-test',
    });
    expect(created.parsed).toMatchObject({ slug: 'acme/app', visibility: 'private' });
    const repoId = created.repo_id as string;

    const init = await expectOneEvent(
      'repo.initialize',
      () => call('/api/v1/repos/acme/app/initialize', { method: 'POST' }),
      201,
    );
    const mainHead = init.parsed.to as string;

    const set = await expectOneEvent('member.set', () =>
      call('/api/v1/repos/acme/app/members', {
        method: 'PUT',
        body: JSON.stringify({ user_id: member.userId, role: 'write' }),
      }),
    );
    expect(set.parsed).toEqual({ user_id: member.userId, role: 'write' });

    const rule = await expectOneEvent(
      'path_rule.create',
      () =>
        call('/api/v1/repos/acme/app/path-rules', {
          method: 'POST',
          body: JSON.stringify({
            path_prefix: 'secrets',
            effect: 'deny',
            principal: '*',
            perms: ['history'],
          }),
        }),
      201,
    );
    expect(rule.parsed).toMatchObject({ path_prefix: 'secrets/', effect: 'deny' });
    const removed = await expectOneEvent('path_rule.delete', () =>
      call(`/api/v1/repos/acme/app/path-rules/${rule.parsed.rule_id as number}`, {
        method: 'DELETE',
      }),
    );
    expect(removed.parsed).toMatchObject({ rule_id: rule.parsed.rule_id });

    const next = await commitChanges(testEnv, repoId, {
      first_parent: mainHead,
      message: 'next',
      author,
      changes: [{ path: 'b.txt', op: 'add', content_b64: btoa('TOP-SECRET-CONTENT') }],
    });
    const moved = await expectOneEvent('ref.move', () =>
      call('/api/v1/repos/acme/app/refs/main', {
        method: 'PUT',
        body: JSON.stringify({ from: mainHead, to: next.changeset.id }),
      }),
    );
    expect(moved.parsed).toEqual({
      ref: 'main',
      from: mainHead,
      to: next.changeset.id,
      force: false,
    });

    const head = await commitChanges(testEnv, repoId, {
      first_parent: next.changeset.id,
      message: 'proposal',
      author,
      changes: [{ path: 'c.txt', op: 'add', content_b64: btoa('more') }],
    });
    const pull = await expectOneEvent(
      'pull.create',
      () =>
        call('/api/v1/repos/acme/app/pulls', {
          method: 'POST',
          body: JSON.stringify({ title: 'Change', head_cs: head.changeset.id }),
        }),
      201,
    );
    const review = await expectOneEvent('pull.review', () =>
      call(`/api/v1/repos/acme/app/pulls/${pull.parsed.pull_id as number}/review`, {
        method: 'POST',
        as: member,
        body: JSON.stringify({
          revision: 1,
          head_cs: head.changeset.id,
          decision: 'approve',
          body: 'ok',
        }),
      }),
    );
    expect(review).toMatchObject({ actor_id: member.userId });
    expect(review.parsed).toMatchObject({ decision: 'approve' });
    await expectOneEvent('pull.merge', () =>
      call(`/api/v1/repos/acme/app/pulls/${pull.parsed.pull_id as number}/merge`, {
        method: 'POST',
        body: JSON.stringify({ revision: 1, head_cs: head.changeset.id }),
      }),
    );

    await expectOneEvent(
      'agent.task.create',
      () =>
        call('/api/v1/repos/acme/app/agents/tasks', {
          method: 'POST',
          body: JSON.stringify({ kind: 'freeform', prompt: 'PROMPT-TEXT' }),
        }),
      202,
    );
    await expectOneEvent('member.remove', () =>
      call(`/api/v1/repos/acme/app/members/${member.userId}`, { method: 'DELETE' }),
    );

    // Repo events chain under the repo owner.
    expect(new Set((await events()).map((e) => e.org_id))).toEqual(new Set(['acme']));
    const dump = JSON.stringify(await events());
    expect(dump).not.toContain('TOP-SECRET-CONTENT');
    expect(dump).not.toContain(btoa('TOP-SECRET-CONTENT'));
    expect(dump).not.toContain('PROMPT-TEXT');
  });

  it('records sign-in, sign-out and token lifecycle without secrets', async () => {
    const start = await call('/auth/github', { as: { headers: {} } });
    const state = new URL(start.headers.get('location') as string).searchParams.get(
      'state',
    ) as string;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new Request(input as RequestInfo, init).url;
      const bodies: Record<string, unknown> = {
        'https://github.com/login/oauth/access_token': {
          access_token: 'gh-access-token',
        },
        'https://api.github.com/user': { id: 4242, login: 'octo' },
        'https://api.github.com/user/emails': [{ email: 'o@example.com', primary: true }],
      };
      if (url in bodies) return Response.json(bodies[url]);
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    const login = await expectOneEvent(
      'auth.login',
      () =>
        call(`/auth/github/callback?code=abc&state=${state}`, { as: { headers: {} } }),
      302,
    );
    expect(login).toMatchObject({ org_id: '_instance', actor_kind: 'user' });
    expect(login.parsed).toMatchObject({ login: 'octo', method: 'github' });
    const session = (login.res.headers.get('set-cookie') as string).split(';')[0];

    const created = await expectOneEvent(
      'token.create',
      () =>
        call('/api/v1/tokens', {
          method: 'POST',
          body: JSON.stringify({ label: 'ci', scopes: ['repo:read'] }),
        }),
      201,
    );
    const raw = ((await created.res.json()) as { token: string }).token;
    expect(created.parsed).toMatchObject({ label: 'ci', scopes: ['repo:read'] });
    await expectOneEvent('token.revoke', () =>
      call(`/api/v1/tokens/${created.parsed.token_id as string}`, { method: 'DELETE' }),
    );
    await expectOneEvent('auth.logout', () => call('/auth/logout', { method: 'POST' }));

    const dump = JSON.stringify(await events());
    expect(dump).not.toContain('gh-access-token');
    expect(dump).not.toContain(raw);
    expect(dump).not.toContain(session.split('=')[1]);
    expect(dump).not.toContain(admin.cookie.split('=')[1]);
  });

  it('records token principals as acting on behalf of their user', async () => {
    const repo = await createRepo(testEnv, { slug: 'acme/tok', createdBy: admin.userId });
    const first = await commitChanges(testEnv, repo.id, {
      first_parent: null,
      message: 'root',
      author,
      changes: [{ path: 'a', op: 'add', content_b64: btoa('a') }],
    });
    await setRef(testEnv, repo.id, 'main', first.changeset.id);
    const second = await commitChanges(testEnv, repo.id, {
      first_parent: first.changeset.id,
      message: 'two',
      author,
      changes: [{ path: 'b', op: 'add', content_b64: btoa('b') }],
    });
    const token = await createApiToken(testEnv, admin.userId, { label: 'bot' });
    const moved = await expectOneEvent('ref.move', () =>
      call('/api/v1/repos/acme/tok/refs/main', {
        method: 'PUT',
        as: { headers: { authorization: `Bearer ${token.raw}` } },
        body: JSON.stringify({ from: first.changeset.id, to: second.changeset.id }),
      }),
    );
    expect(moved).toMatchObject({
      actor_kind: 'token',
      actor_id: token.id,
      on_behalf_of: admin.userId,
    });
  });
});

describe('audit events from orgs, refs and tags (#26, #33)', () => {
  it('chains org events under the org slug and lets org owners and admins read them', async () => {
    const owner = await loginAs(testEnv, 903, 'orgowner');
    const created = await expectOneEvent(
      'org.create',
      () =>
        call('/api/v1/orgs', {
          method: 'POST',
          as: owner,
          body: JSON.stringify({ slug: 'yuma', base_role: 'read' }),
        }),
      201,
    );
    expect(created).toMatchObject({ org_id: 'yuma', actor_id: owner.userId });
    expect(created.parsed).toEqual({ org: 'yuma', base_role: 'read' });

    const set = await expectOneEvent('org.member.set', () =>
      call('/api/v1/orgs/yuma/members', {
        method: 'PUT',
        as: owner,
        body: JSON.stringify({ user_id: member.userId, role: 'member' }),
      }),
    );
    expect(set.parsed).toEqual({
      org: 'yuma',
      user_id: member.userId,
      role: 'member',
      was: null,
    });
    await expectOneEvent(
      'team.create',
      () =>
        call('/api/v1/orgs/yuma/teams', {
          method: 'POST',
          as: owner,
          body: JSON.stringify({ slug: 'core' }),
        }),
      201,
    );
    await expectOneEvent(
      'repo.create',
      () =>
        call('/api/v1/repos', {
          method: 'POST',
          as: owner,
          body: JSON.stringify({ slug: 'yuma/app' }),
        }),
      201,
    );
    const grant = await expectOneEvent('team.repo.set', () =>
      call('/api/v1/orgs/yuma/teams/core/repos', {
        method: 'PUT',
        as: owner,
        body: JSON.stringify({ repo: 'yuma/app', role: 'write' }),
      }),
    );
    expect(grant).toMatchObject({ org_id: 'yuma' });
    expect(grant.repo_id).not.toBeNull();

    // org owner reads the org chain without being an instance audit admin
    const read = await call('/api/v1/orgs/yuma/audit', { as: owner }, testEnv);
    expect(read.status).toBe(200);
    const body = (await read.json()) as { events: { action: string }[] };
    expect(body.events.map((e) => e.action)).toContain('org.create');
    // plain members and other orgs stay closed
    expect((await call('/api/v1/orgs/yuma/audit', { as: member }, testEnv)).status).toBe(
      403,
    );
    expect((await call('/api/v1/orgs/acme/audit', { as: owner }, testEnv)).status).toBe(
      403,
    );
  });

  it('records tag creation and repo settings changes', async () => {
    await call('/api/v1/repos', {
      method: 'POST',
      body: JSON.stringify({ slug: 'acme/tags' }),
    });
    const init = await call('/api/v1/repos/acme/tags/initialize', { method: 'POST' });
    expect(init.status).toBe(201);
    const head = (await (await call('/api/v1/repos/acme/tags/refs/main')).json()) as {
      head: string;
    };
    const tag = await expectOneEvent(
      'tag.create',
      () =>
        call('/api/v1/repos/acme/tags/tags', {
          method: 'POST',
          body: JSON.stringify({ name: 'v1.0.0', target: head.head, message: 'first' }),
        }),
      201,
    );
    expect(tag.parsed).toEqual({
      tag: 'v1.0.0',
      target_cs: head.head,
      annotated: true,
      signed: false,
    });
    const settings = await expectOneEvent('repo.settings.update', () =>
      call('/api/v1/repos/acme/tags', {
        method: 'PUT',
        body: JSON.stringify({ default_branch: 'main' }),
      }),
    );
    expect(settings.parsed).toMatchObject({ default_branch: 'main' });
  });
});

// Every write route must either record an audit event or say why not. Adding
// a POST/PUT/PATCH/DELETE route without updating this table fails the suite.
const AUDITED: Record<string, AuditAction> = {
  'POST /auth/logout': 'auth.logout',
  'POST /api/v1/tokens': 'token.create',
  'DELETE /api/v1/tokens/:id': 'token.revoke',
  'POST /api/v1/cache-token': 'cache_token.create',
  'POST /api/v1/repos': 'repo.create',
  'POST /api/v1/repos/:owner/:name/initialize': 'repo.initialize',
  'POST /api/v1/repos/:repo{.+}/connect': 'repo.connect',
  'POST /api/v1/repos/:repo{.+}/import': 'repo.import',
  'POST /api/v1/repos/:repo{.+}/export/github': 'repo.export',
  'PUT /api/v1/repos/:repo{.+}/members': 'member.set',
  'DELETE /api/v1/repos/:repo{.+}/members/:userId': 'member.remove',
  'POST /api/v1/repos/:repo{.+}/path-rules': 'path_rule.create',
  'DELETE /api/v1/repos/:repo{.+}/path-rules/:id': 'path_rule.delete',
  'PUT /api/v1/repos/:repo{[^/]+/[^/]+}/refs/:name{.+}': 'ref.move',
  'POST /api/v1/repos/:repo{[^/]+/[^/]+}/tags': 'tag.create',
  'PUT /api/v1/repos/:owner/:name': 'repo.settings.update',
  'POST /api/v1/repos/:repo{.+}/pulls': 'pull.create',
  'POST /api/v1/repos/:repo{.+}/pulls/:id/update': 'pull.update',
  'POST /api/v1/repos/:repo{.+}/pulls/:id/review': 'pull.review',
  'POST /api/v1/repos/:repo{.+}/pulls/:id/merge': 'pull.merge',
  'PUT /api/v1/repos/:repo{.+}/ci': 'ci.settings.update',
  'POST /api/v1/repos/:repo{.+}/ci/runs': 'ci.run.create',
  'POST /api/v1/repos/:repo{.+}/ci/runs/:id/cancel': 'ci.run.cancel',
  'POST /api/v1/repos/:repo{.+}/agents/tasks': 'agent.task.create',
  'POST /api/v1/agents/tasks/:id/cancel': 'agent.task.cancel',
  'POST /api/v1/repos/:repo{.+}/agents/superfans': 'agent.superfan.start',
  'DELETE /api/v1/repos/:repo{.+}/agents/superfans/:component': 'agent.superfan.stop',
  'POST /api/v1/orgs': 'org.create',
  'PATCH /api/v1/orgs/:org': 'org.update',
  'PUT /api/v1/orgs/:org/members': 'org.member.set',
  'DELETE /api/v1/orgs/:org/members/:userId': 'org.member.remove',
  'POST /api/v1/orgs/:org/teams': 'team.create',
  'PUT /api/v1/orgs/:org/teams/:team/members': 'team.member.set',
  'DELETE /api/v1/orgs/:org/teams/:team/members/:userId': 'team.member.remove',
  'PUT /api/v1/orgs/:org/teams/:team/repos': 'team.repo.set',
  'DELETE /api/v1/orgs/:org/teams/:team/repos/:repo{.+}': 'team.repo.remove',
  'POST /auth/passkey': 'auth.login',
  'POST /auth/mfa/totp': 'auth.mfa',
  'POST /auth/mfa/passkey': 'auth.mfa',
  'POST /api/v1/me/passkeys': 'mfa.passkey.add',
  'DELETE /api/v1/me/passkeys/:id': 'mfa.passkey.remove',
  'POST /api/v1/me/totp/confirm': 'mfa.totp.enroll',
  'DELETE /api/v1/me/totp': 'mfa.totp.remove',
  'POST /scim/v2/Users': 'scim.user.create',
  'PATCH /scim/v2/Users/:id': 'scim.user.update',
  'DELETE /scim/v2/Users/:id': 'scim.user.deprovision',
  'POST /api/v1/scim/tokens': 'scim_token.create',
  'DELETE /api/v1/scim/tokens/:id': 'scim_token.revoke',
};
const EXEMPT: Record<string, string> = {
  'POST /webhooks/github':
    'GitHub-signed delivery with no principal; deduped in webhook_deliveries',
  'POST /api/v1/repos/:repo{.+}/changesets':
    'content-addressed write; invisible until an audited ref move points at it',
  'PUT /api/v1/repos/:repo{.+}/blob': 'content-addressed blob upload; same as changesets',
  'POST /api/v1/repos/:repo{.+}/fetch-objects': 'read-only batch fetch',
  'POST /api/v1/me/passkeys/options': 'issues a one-time challenge; enrolment is audited',
  'POST /api/v1/me/totp':
    'stores an unconfirmed seed that cannot sign in; confirm is audited',
  'POST /auth/mfa/passkey/options': 'issues a one-time challenge; step-up is audited',
  'POST /auth/passkey/options': 'issues a one-time challenge; sign-in is audited',
  'POST /api/v1/repos/:repo{.+}/agents/mcp':
    'tool calls audit their own state changes (land records ref.move)',
};

describe('audit coverage', () => {
  it('every write route is audited or explicitly exempt', () => {
    const writes = [
      ...new Set(
        honoApp.routes
          .filter((r) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method))
          .map((r) => `${r.method} ${r.path}`),
      ),
    ];
    const missing = writes.filter((route) => !(route in AUDITED) && !(route in EXEMPT));
    expect(missing).toEqual([]);
    const stale = [...Object.keys(AUDITED), ...Object.keys(EXEMPT)].filter(
      (route) => !writes.includes(route),
    );
    expect(stale).toEqual([]);
  });
});

describe('audit search and export', () => {
  async function seed(): Promise<void> {
    const actions: AuditAction[] = ['repo.create', 'ref.move', 'ref.move', 'member.set'];
    for (const [i, action] of actions.entries()) {
      await appendAudit(testEnv, {
        action,
        orgId: 'acme',
        actor: { kind: 'user', id: i % 2 ? member.userId : admin.userId },
        target: { n: i, note: i === 3 ? '=HYPERLINK("x")' : 'plain' },
      });
    }
    await appendAudit(testEnv, {
      action: 'auth.login',
      actor: { kind: 'user', id: admin.userId },
    });
  }

  it('is admin only', async () => {
    expect((await call('/api/v1/orgs/acme/audit', { as: { headers: {} } })).status).toBe(
      401,
    );
    const denied = await call('/api/v1/orgs/acme/audit', { as: member });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: { code: 'forbidden' } });
    expect((await call('/api/v1/orgs/acme/audit', {}, testEnv)).status).toBe(403);

    const plain = await createApiToken(testEnv, admin.userId, { label: 'p' });
    const scoped = await createApiToken(testEnv, admin.userId, {
      label: 's',
      scopes: ['audit:read'],
    });
    expect(plain.metadata.scopes).not.toContain('audit:read');
    const bearer = (raw: string) => ({ headers: { authorization: `Bearer ${raw}` } });
    expect(
      (await call('/api/v1/orgs/acme/audit', { as: bearer(plain.raw) })).status,
    ).toBe(403);
    expect(
      (await call('/api/v1/orgs/acme/audit', { as: bearer(scoped.raw) })).status,
    ).toBe(200);
  });

  it('filters and paginates newest first', async () => {
    await seed();
    const all = (await (await call('/api/v1/orgs/acme/audit?limit=3')).json()) as {
      events: { id: number; action: string; target: unknown }[];
      next_cursor: number | null;
    };
    expect(all.events).toHaveLength(3);
    expect(all.events[0].action).toBe('member.set');
    expect(all.events[0].target).toEqual({ n: 3, note: '=HYPERLINK("x")' });
    const rest = (await (
      await call(`/api/v1/orgs/acme/audit?limit=3&cursor=${all.next_cursor}`)
    ).json()) as { events: { action: string }[]; next_cursor: number | null };
    expect(rest.events.map((e) => e.action)).toEqual(['repo.create']);
    expect(rest.next_cursor).toBeNull();

    const moves = (await (
      await call('/api/v1/orgs/acme/audit?action=ref.move')
    ).json()) as { events: unknown[] };
    expect(moves.events).toHaveLength(2);
    const byMember = (await (
      await call(`/api/v1/orgs/acme/audit?actor=${member.userId}`)
    ).json()) as { events: unknown[] };
    expect(byMember.events).toHaveLength(2);
    const future = (await (
      await call(
        `/api/v1/orgs/acme/audit?from=${new Date(Date.now() + 60_000).toISOString()}`,
      )
    ).json()) as { events: unknown[] };
    expect(future.events).toHaveLength(0);
    expect((await call('/api/v1/orgs/acme/audit?from=yesterday')).status).toBe(400);
    const instance = (await (await call('/api/v1/orgs/_instance/audit')).json()) as {
      events: { action: string }[];
    };
    expect(instance.events.map((e) => e.action)).toEqual(['auth.login']);
  });

  it('exports NDJSON and CSV oldest first', async () => {
    await seed();
    const ndjson = await call('/api/v1/orgs/acme/audit?format=ndjson');
    expect(ndjson.headers.get('content-type')).toBe('application/x-ndjson');
    const lines = (await ndjson.text()).trim().split('\n');
    expect(lines.map((l) => (JSON.parse(l) as { action: string }).action)).toEqual([
      'repo.create',
      'ref.move',
      'ref.move',
      'member.set',
    ]);

    const csv = await call('/api/v1/orgs/acme/audit?format=csv&action=member.set');
    expect(csv.headers.get('content-type')).toContain('text/csv');
    const [header, row, end] = (await csv.text()).split('\n');
    expect(header.startsWith('id,at,org_id,')).toBe(true);
    expect(row).toContain('member.set');
    // the target cell is JSON text, quoted for CSV
    expect(row).toContain('"{""n"":3,""note"":""=HYPERLINK(\\""x\\"")""}"');
    expect(end).toBe('');
  });
});

describe('hash chain', () => {
  it('verifies with yag audit verify and detects a modified event', async () => {
    for (let i = 0; i < 4; i++) {
      await appendAudit(testEnv, {
        action: 'ref.move',
        orgId: 'acme',
        actor: { kind: 'user', id: admin.userId },
        target: { to: `cs${i}` },
      });
    }
    const exportLines = async (): Promise<string[]> =>
      (await (await call('/api/v1/orgs/acme/audit?format=ndjson')).text()).split('\n');
    expect(await verifyAuditChain(await exportLines())).toMatchObject({
      ok: true,
      events: 4,
    });

    const victim = (await events())[1];
    await expect(
      run(testEnv, 'UPDATE audit_events SET target = ? WHERE id = ?', ['{}', victim.id]),
    ).rejects.toThrow(/append-only/);

    // An operator with raw database access can drop the trigger; the chain
    // still exposes the edit.
    await run(testEnv, 'DROP TRIGGER audit_events_no_update');
    try {
      await run(testEnv, 'UPDATE audit_events SET target = ? WHERE id = ?', [
        '{"to":"evil"}',
        victim.id,
      ]);
      expect(await verifyAuditChain(await exportLines())).toEqual({
        ok: false,
        id: victim.id,
        reason: 'event modified: hash mismatch',
      });
      await run(testEnv, 'DELETE FROM audit_events WHERE id = ?', [victim.id]);
      expect(await verifyAuditChain(await exportLines())).toMatchObject({
        ok: false,
        reason: 'chain broken: prev_hash mismatch',
      });
    } finally {
      await run(
        testEnv,
        `CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events
         BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END`,
      );
    }
  });

  it('keeps one chain per org under concurrent appends', async () => {
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        appendAudit(testEnv, {
          action: 'ref.move',
          orgId: 'acme',
          actor: { kind: 'system', id: 'test' },
          target: { i },
        }),
      ),
    );
    const lines = (
      await (await call('/api/v1/orgs/acme/audit?format=ndjson')).text()
    ).split('\n');
    expect(await verifyAuditChain(lines)).toMatchObject({ ok: true, events: 6 });
  });
});

describe('audit streaming', () => {
  const SECRET = 'stream-secret-value';
  const URL_ = 'https://siem.example/ingest';

  function batch(attempts = 1): {
    batch: MessageBatch;
    acked: boolean[];
    retried: (QueueRetryOptions | undefined)[];
  } {
    const acked: boolean[] = [];
    const retried: (QueueRetryOptions | undefined)[] = [];
    return {
      acked,
      retried,
      batch: {
        queue: 'audit-stream',
        messages: [{ id: 'm', timestamp: new Date(), body: { kick: true }, attempts }],
        ackAll: () => acked.push(true),
        retryAll: (options?: QueueRetryOptions) => retried.push(options),
      } as unknown as MessageBatch,
    };
  }

  async function hmac(message: string): Promise<string> {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
    return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  it('delivers in order with HMAC, retries failures and reports status', async () => {
    const kicks: unknown[] = [];
    const streaming = withAudit({
      AUDIT_STREAM_URL: URL_,
      AUDIT_STREAM_SECRET: SECRET,
      AUDIT_QUEUE: { send: async (body: unknown) => void kicks.push(body) },
    });
    for (let i = 0; i < 3; i++) {
      await appendAudit(streaming, {
        action: 'ref.move',
        orgId: i === 1 ? '_instance' : 'acme',
        actor: { kind: 'system', id: 'test' },
        target: { i },
      });
    }
    expect(kicks).toHaveLength(3);

    const received: { id: number }[] = [];
    let fail = true;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input as RequestInfo, init);
      expect(req.url).toBe(URL_);
      const body = await req.text();
      const timestamp = req.headers.get('x-yag-timestamp') as string;
      expect(req.headers.get('x-yag-signature')).toBe(
        `sha256=${await hmac(`${timestamp}.${body}`)}`,
      );
      if (fail) return new Response('down', { status: 503 });
      received.push(...(JSON.parse(body) as { events: { id: number }[] }).events);
      return new Response(null, { status: 202 });
    }) as typeof fetch;

    const first = batch(2);
    await auditStreamQueue(first.batch, streaming);
    expect(first.retried).toEqual([{ delaySeconds: 20 }]);
    const down = (await (
      await call('/api/v1/audit/stream', {}, streaming)
    ).json()) as Record<string, unknown>;
    expect(down).toMatchObject({
      configured: true,
      delivered_through: 0,
      pending: 3,
      last_status: 'http_503',
      failures: 1,
    });
    expect(JSON.stringify(down)).not.toContain(SECRET);
    expect(JSON.stringify(down)).not.toContain('siem.example');

    fail = false;
    const second = batch();
    await auditStreamQueue(second.batch, streaming);
    expect(second.acked).toEqual([true]);
    const ids = (await events()).map((e) => e.id);
    expect(received.map((e) => e.id)).toEqual(ids);
    expect(
      (await (await call('/api/v1/audit/stream', {}, streaming)).json()) as unknown,
    ).toMatchObject({
      delivered_through: ids[2],
      pending: 0,
      failures: 0,
      last_status: 'http_202',
    });

    // nothing new: no further delivery
    await auditStreamQueue(batch().batch, streaming);
    expect(received).toHaveLength(3);
    const state = await q1<{ last_id: number }>(
      testEnv,
      "SELECT last_id FROM audit_stream_state WHERE sink = 'https'",
    );
    expect(state?.last_id).toBe(ids[2]);
  });

  it('refuses plain HTTP sinks and missing secrets', () => {
    expect(
      configuredSink(
        withAudit({ AUDIT_STREAM_URL: 'http://siem', AUDIT_STREAM_SECRET: 's' }),
      ),
    ).toBeNull();
    expect(configuredSink(withAudit({ AUDIT_STREAM_URL: URL_ }))).toBeNull();
    expect(
      configuredSink(withAudit({ AUDIT_STREAM_URL: URL_, AUDIT_STREAM_SECRET: 's' })),
    ).not.toBeNull();
  });
});
