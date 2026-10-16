import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { cleanDb, loginAs, makeApp, seedSchema, type TestEnv } from './helpers';
import { blob, commit, packOf, parseReport, pushBody, tree, ZERO } from './git-helpers';
import { createRepo, getRef } from '../src/db/repos';
import { q, run } from '../src/db/client';
import { createApiToken } from '../src/auth/tokens';
import { gitIdentity } from '../src/git/identity';

const testEnv = env as unknown as TestEnv;
const dbEnv = testEnv as unknown as Env;
const app = makeApp(testEnv);

const EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS = 'urn:ietf:params:oauth:token-type:access_token';

type Login = Awaited<ReturnType<typeof loginAs>>;
let owner: Login;
let repoId = '';
let otherId = '';
let ownerToken = '';
let mainSha = '';

async function call(
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<Response> {
  return app(
    new Request(`https://x${path}`, {
      method: init.method ?? 'GET',
      headers: { 'content-type': 'application/json', ...init.headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
  );
}

const bearer = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
});

async function createAgent(as: Login, body: Record<string, unknown>): Promise<string> {
  const res = await call('/api/v1/agents', {
    method: 'POST',
    headers: as.headers,
    body: { name: 'Codex', kind: 'codex', ...body },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/** RFC 8693 exchange with a form body, as an OAuth client sends it. */
async function exchange(fields: Record<string, string | string[]>): Promise<Response> {
  const form = new URLSearchParams();
  const all: Record<string, string | string[]> = {
    grant_type: EXCHANGE,
    subject_token_type: ACCESS,
    ...fields,
  };
  for (const [key, value] of Object.entries(all)) {
    for (const v of [value].flat()) form.append(key, v);
  }
  return app(
    new Request('https://x/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
    }),
  );
}

async function agentToken(fields: Record<string, string | string[]>): Promise<string> {
  const res = await exchange(fields);
  expect(res.status).toBe(200);
  return ((await res.json()) as { access_token: string }).access_token;
}

async function push(
  token: string,
  commands: [string, string, string][],
  objects: Awaited<ReturnType<typeof blob>>[],
  slug = 'acme/app',
): Promise<ReturnType<typeof parseReport>> {
  const res = await app(
    new Request(`https://x/${slug}.git/git-receive-pack`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-git-receive-pack-request',
        authorization: `Basic ${btoa(`git:${token}`)}`,
      },
      body: pushBody(commands, await packOf(objects)),
    }),
  );
  expect(res.status).toBe(200);
  return parseReport(new Uint8Array(await res.arrayBuffer()));
}

/** A one-file commit on top of `parent`. */
async function change(parent: string | null, text: string) {
  const file = await blob(text);
  const root = await tree([{ name: 'README.md', sha: file.sha }]);
  const head = await commit(root.sha, parent ? [parent] : [], `${text}\n`);
  return { head, objects: [head, root, file] };
}

describe('agent identities (#57)', () => {
  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
    owner = await loginAs(testEnv, 1, 'justin');
    repoId = (await createRepo(dbEnv, { slug: 'acme/app', createdBy: owner.userId })).id;
    otherId = (await createRepo(dbEnv, { slug: 'acme/other', createdBy: owner.userId }))
      .id;
    ownerToken = (
      await createApiToken(dbEnv, owner.userId, {
        label: 'delegate',
        scopes: ['repo:read', 'repo:write', 'agent:run'],
      })
    ).raw;
    const root = await change(null, 'v1');
    const report = await push(
      ownerToken,
      [[ZERO, root.head.sha, 'refs/heads/main']],
      root.objects,
    );
    expect(report.refs['refs/heads/main']).toBe('ok');
    mainSha = root.head.sha;
  });

  it('exchanges a delegation for a 15-minute repo-bound token that pushes a branch and opens a PR', async () => {
    const agentId = await createAgent(owner, {});
    const res = await exchange({
      subject_token: ownerToken,
      agent_id: agentId,
      resource: 'acme/app',
      task_id: '42',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const issued = (await res.json()) as {
      access_token: string;
      token_type: string;
      issued_token_type: string;
      expires_in: number;
      scope: string;
    };
    expect(issued).toMatchObject({
      token_type: 'Bearer',
      issued_token_type: ACCESS,
      expires_in: 900,
      scope: 'contents:read contents:write pulls:write',
    });
    const token = issued.access_token;
    expect(token.startsWith('yagat_')).toBe(true);

    // clone (ref advertisement) works on the bound repo
    const clone = await app(
      new Request('https://x/acme/app.git/info/refs?service=git-upload-pack', {
        headers: { authorization: `Basic ${btoa(`git:${token}`)}` },
      }),
    );
    expect(clone.status).toBe(200);

    const next = await change(mainSha, 'v2');
    const report = await push(
      token,
      [[ZERO, next.head.sha, 'refs/heads/feature']],
      next.objects,
    );
    expect(report.refs['refs/heads/feature']).toBe('ok');
    const feature = (await getRef(dbEnv, repoId, 'feature'))!.head;

    const pr = await call('/api/v1/repos/acme/app/pulls', {
      method: 'POST',
      headers: bearer(token),
      body: { title: 'Agent change', head_cs: feature },
    });
    expect(pr.status).toBe(201);

    // the pushed changeset records the agent, the human and the task
    const cs = await call(`/api/v1/repos/acme/app/changesets/${feature}`, {
      headers: owner.headers,
    });
    expect(((await cs.json()) as { provenance: unknown }).provenance).toEqual({
      agent_id: agentId,
      agent_name: 'Codex',
      agent_kind: 'codex',
      on_behalf_of: owner.userId,
      on_behalf_of_login: 'justin',
      task_id: '42',
    });

    const audit = await q<{ action: string; actor_kind: string; actor_id: string }>(
      dbEnv,
      "SELECT action, actor_kind, actor_id FROM audit_events WHERE action IN ('agent.token.issue', 'pull.create') ORDER BY id",
    );
    expect(audit).toEqual([
      { action: 'agent.token.issue', actor_kind: 'token', actor_id: expect.any(String) },
      { action: 'pull.create', actor_kind: 'agent', actor_id: agentId },
    ]);
  });

  it('cannot push to main, read another repo or create API tokens', async () => {
    const agentId = await createAgent(owner, {});
    const token = await agentToken({
      subject_token: ownerToken,
      agent_id: agentId,
      resource: 'acme/app',
    });

    const next = await change(mainSha, 'v2');
    const report = await push(
      token,
      [[mainSha, next.head.sha, 'refs/heads/main']],
      next.objects,
    );
    expect(report.refs['refs/heads/main']).toMatch(/^agent_default_branch/);

    const csRes = await call('/api/v1/repos/acme/app/changesets', {
      method: 'POST',
      headers: bearer(token),
      body: {
        first_parent: 'ref:main',
        message: 'm',
        author: { name: 'Justin', email: 'j@example.com' },
        changes: [{ path: 'b.txt', op: 'add', content_b64: btoa('b') }],
      },
    });
    expect(csRes.status).toBe(201);
    const cs = ((await csRes.json()) as { changeset: { id: string; author: unknown } })
      .changeset;
    // agent commits are stamped with the agent id, whatever author was sent
    expect(cs.author).toEqual({ agent: agentId });
    expect(gitIdentity({ agent: agentId }).email).toBe(
      `${agentId}@agents.yuma-agent-git`,
    );
    const move = await call('/api/v1/repos/acme/app/refs/main', {
      method: 'PUT',
      headers: bearer(token),
      body: { from: (await getRef(dbEnv, repoId, 'main'))!.head, to: cs.id },
    });
    expect(move.status).toBe(403);
    expect(((await move.json()) as { error: { code: string } }).error.code).toBe(
      'protected_branch',
    );
    // its own agent ref namespace is writable, another agent's is not
    const own = await call(`/api/v1/repos/acme/app/refs/refs/agents/${agentId}/wip`, {
      method: 'PUT',
      headers: bearer(token),
      body: { from: null, to: cs.id },
    });
    expect(own.status).toBe(200);
    const foreign = await call('/api/v1/repos/acme/app/refs/refs/agents/agt_other/wip', {
      method: 'PUT',
      headers: bearer(token),
      body: { from: null, to: cs.id },
    });
    expect(foreign.status).toBe(403);

    expect(
      (await call('/api/v1/repos/acme/other', { headers: bearer(token) })).status,
    ).toBe(404);
    const otherClone = await app(
      new Request('https://x/acme/other.git/info/refs?service=git-upload-pack', {
        headers: { authorization: `Basic ${btoa(`git:${token}`)}` },
      }),
    );
    expect(otherClone.status).toBe(404);
    const repos = (await (
      await call('/api/v1/repos', { headers: bearer(token) })
    ).json()) as { repos: { id: string }[] };
    expect(repos.repos.map((r) => r.id)).toEqual([repoId]);
    expect(otherId).not.toBe(repoId);

    const minted = await call('/api/v1/tokens', {
      method: 'POST',
      headers: bearer(token),
      body: { label: 'escalate' },
    });
    expect(minted.status).toBe(401);
    // nor exchange itself for another token (one hop only)
    expect(
      (await exchange({ subject_token: token, agent_id: agentId, resource: 'acme/app' }))
        .status,
    ).toBe(400);
    // nor administer the repo or read the audit log
    const settings = await call('/api/v1/repos/acme/app', {
      method: 'PUT',
      headers: bearer(token),
      body: { visibility: 'public' },
    });
    expect(settings.status).toBe(403);
    expect((await call('/api/v1/audit/stream', { headers: bearer(token) })).status).toBe(
      403,
    );
  });

  it('applies rulesets to agent refs, and lets an agent bypass only when named and its human may', async () => {
    const agentId = await createAgent(owner, {});
    const token = await agentToken({
      subject_token: ownerToken,
      agent_id: agentId,
      resource: 'acme/app',
    });
    const ref = `refs/agents/${agentId}/wip`;
    const rules = {
      name: 'Agent refs',
      target: 'branch',
      conditions: { ref_name: { include: ['refs/agents/**'] } },
      rules: [{ type: 'non_fast_forward' }],
    };
    const created = await call('/api/v1/repos/acme/app/rulesets', {
      method: 'POST',
      headers: owner.headers,
      body: rules,
    });
    expect(created.status).toBe(201);
    const { id } = ((await created.json()) as { ruleset: { id: string } }).ruleset;

    const first = await change(mainSha, 'a');
    expect(
      (await push(token, [[ZERO, first.head.sha, ref]], first.objects)).refs[ref],
    ).toBe('ok');
    const rewrite = await change(mainSha, 'b');
    const forced = async () =>
      (await push(token, [[first.head.sha, rewrite.head.sha, ref]], rewrite.objects))
        .refs[ref];
    expect(await forced()).toBe(
      `ruleset "Agent refs" non_fast_forward: force pushes to ${ref} are not allowed`,
    );
    // the human's admin role does not carry over to the agent
    const bypass = async (entry: string) => {
      const res = await call(`/api/v1/repos/acme/app/rulesets/${id}`, {
        method: 'PUT',
        headers: owner.headers,
        body: { ...rules, bypass: [entry] },
      });
      expect(res.status).toBe(200);
    };
    await bypass('role:admin');
    expect(await forced()).toMatch(/^ruleset "Agent refs" non_fast_forward/);
    // named alone is not enough: the human it acts for must be able to bypass too
    await bypass(`agent:${agentId}`);
    expect(await forced()).toMatch(/^ruleset "Agent refs" non_fast_forward/);
    const res = await call(`/api/v1/repos/acme/app/rulesets/${id}`, {
      method: 'PUT',
      headers: owner.headers,
      body: { ...rules, bypass: [`agent:${agentId}`, 'role:admin'] },
    });
    expect(res.status).toBe(200);
    expect(await forced()).toBe('ok');
  });

  it('intersects the agent grant with the human role', async () => {
    const reader = await loginAs(testEnv, 2, 'reader');
    await run(
      dbEnv,
      "INSERT INTO repo_members (repo_id, user_id, role) VALUES (?, ?, 'read')",
      [repoId, reader.userId],
    );
    const readerToken = (
      await createApiToken(dbEnv, reader.userId, {
        label: 'delegate',
        scopes: ['repo:read', 'repo:write', 'agent:run'],
      })
    ).raw;
    const agentId = await createAgent(reader, {
      max_scopes: ['contents:read', 'contents:write'],
    });
    const token = await agentToken({
      subject_token: readerToken,
      agent_id: agentId,
      resource: 'acme/app',
      scope: 'contents:read contents:write',
    });

    expect(
      (await call('/api/v1/repos/acme/app/changesets', { headers: bearer(token) }))
        .status,
    ).toBe(200);
    const write = await call('/api/v1/repos/acme/app/changesets', {
      method: 'POST',
      headers: bearer(token),
      body: {
        first_parent: 'ref:main',
        message: 'm',
        author: { agent: agentId },
        changes: [{ path: 'b.txt', op: 'add', content_b64: btoa('b') }],
      },
    });
    expect(write.status).toBe(403);
    const next = await change(mainSha, 'v2');
    const pushed = await app(
      new Request('https://x/acme/app.git/git-receive-pack', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-git-receive-pack-request',
          authorization: `Basic ${btoa(`git:${token}`)}`,
        },
        body: pushBody(
          [[ZERO, next.head.sha, 'refs/heads/f']],
          await packOf(next.objects),
        ),
      }),
    );
    expect(pushed.status).toBe(403);
  });

  it('disabling an agent fails its next request and revokes its tokens', async () => {
    const agentId = await createAgent(owner, {});
    const token = await agentToken({
      subject_token: ownerToken,
      agent_id: agentId,
      resource: 'acme/app',
    });
    expect(
      (await call('/api/v1/repos/acme/app', { headers: bearer(token) })).status,
    ).toBe(200);
    const listed = (await (
      await call('/api/v1/agents', { headers: owner.headers })
    ).json()) as { agents: { id: string; live_tokens: number }[] };
    expect(listed.agents).toMatchObject([{ id: agentId, live_tokens: 1 }]);

    const off = await call(`/api/v1/agents/${agentId}`, {
      method: 'PATCH',
      headers: owner.headers,
      body: { disabled: true },
    });
    expect(off.status).toBe(200);
    expect(
      (await call('/api/v1/repos/acme/app', { headers: bearer(token) })).status,
    ).toBe(401);
    expect(await q(dbEnv, 'SELECT jti FROM agent_tokens')).toEqual([]);
    // a disabled agent cannot be delegated to
    expect(
      (
        await exchange({
          subject_token: ownerToken,
          agent_id: agentId,
          resource: 'acme/app',
        })
      ).status,
    ).toBe(400);
    const actions = await q<{ action: string }>(
      dbEnv,
      "SELECT action FROM audit_events WHERE action LIKE 'agent.%' ORDER BY id",
    );
    expect(actions.map((a) => a.action)).toEqual([
      'agent.create',
      'agent.token.issue',
      'agent.disable',
    ]);
  });

  it('revokes live tokens without disabling and expires tokens', async () => {
    const agentId = await createAgent(owner, {});
    const token = await agentToken({
      subject_token: ownerToken,
      agent_id: agentId,
      resource: 'acme/app',
    });
    const revoke = await call(`/api/v1/agents/${agentId}/tokens`, {
      method: 'DELETE',
      headers: owner.headers,
    });
    expect(revoke.status).toBe(200);
    expect(
      (await call('/api/v1/repos/acme/app', { headers: bearer(token) })).status,
    ).toBe(401);

    const short = await agentToken({
      subject_token: ownerToken,
      agent_id: agentId,
      resource: 'acme/app',
      expires_in: '60',
    });
    await run(dbEnv, 'UPDATE agent_tokens SET expires_at = ?', [Date.now() - 1]);
    expect(
      (await call('/api/v1/repos/acme/app', { headers: bearer(short) })).status,
    ).toBe(401);
  });

  it('revoking or expiring the delegating API token revokes its agent tokens', async () => {
    const agentId = await createAgent(owner, {});
    const delegate = await createApiToken(dbEnv, owner.userId, {
      label: 'delegate',
      scopes: ['repo:read', 'repo:write', 'agent:run'],
    });
    const token = await agentToken({
      subject_token: delegate.raw,
      agent_id: agentId,
      resource: 'acme/app',
      expires_in: '3600',
    });
    const repo = () => call('/api/v1/repos/acme/app', { headers: bearer(token) });
    expect((await repo()).status).toBe(200);
    await run(dbEnv, 'UPDATE api_tokens SET expires_at = ? WHERE id = ?', [
      Date.now() - 1,
      delegate.id,
    ]);
    expect((await repo()).status).toBe(401);
    await run(dbEnv, 'UPDATE api_tokens SET expires_at = NULL WHERE id = ?', [
      delegate.id,
    ]);
    expect((await repo()).status).toBe(200);
    const revoked = await call(`/api/v1/tokens/${delegate.id}`, {
      method: 'DELETE',
      headers: owner.headers,
    });
    expect(revoked.status).toBe(200);
    expect((await repo()).status).toBe(401);
    expect(await q(dbEnv, 'SELECT jti FROM agent_tokens')).toEqual([]);
  });

  it('needs ci:run for pipeline runs and contents:write for issue writes', async () => {
    const agentId = await createAgent(owner, {});
    const token = await agentToken({
      subject_token: ownerToken,
      agent_id: agentId,
      resource: 'acme/app',
      scope: 'contents:read contents:write',
    });
    for (const path of ['/ci/pipelines/runs', '/ci/pipelines/runs/x/cancel']) {
      const res = await call(`/api/v1/repos/acme/app${path}`, {
        method: 'POST',
        headers: bearer(token),
        body: { pipeline: '.yuma/pipelines/ci.yml' },
      });
      expect(res.status, path).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code, path).toBe(
        'insufficient_scope',
      );
    }
    const reader = await agentToken({
      subject_token: ownerToken,
      agent_id: agentId,
      resource: 'acme/app',
      scope: 'contents:read',
    });
    const issue = await call('/api/v1/repos/acme/app/issues', {
      method: 'POST',
      headers: bearer(reader),
      body: { title: 'From a read-only agent' },
    });
    expect(issue.status).toBe(403);
    expect(((await issue.json()) as { error: { code: string } }).error.code).toBe(
      'insufficient_scope',
    );
    expect(
      (
        await call('/api/v1/repos/acme/app/issues', {
          method: 'POST',
          headers: bearer(token),
          body: { title: 'From a writing agent' },
        })
      ).status,
    ).toBe(201);
  });

  it('refuses exchanges outside the grant', async () => {
    const agentId = await createAgent(owner, {
      max_scopes: ['contents:read'],
      allowed_repos: ['acme/app'],
    });
    const base = { subject_token: ownerToken, agent_id: agentId, resource: 'acme/app' };
    const code = async (fields: Record<string, string | string[]>): Promise<string> => {
      const res = await exchange(fields);
      expect(res.status).toBe(400);
      return ((await res.json()) as { error: { code: string } }).error.code;
    };
    expect(await code({ ...base, grant_type: 'client_credentials' })).toBe(
      'unsupported_grant_type',
    );
    expect(await code({ ...base, expires_in: '3601' })).toBe('invalid_request');
    expect(await code({ ...base, scope: 'contents:write' })).toBe('invalid_scope');
    expect(await code({ ...base, scope: 'admin:*' })).toBe('invalid_scope');
    expect(await code({ ...base, resource: ['acme/app', 'acme/other'] })).toBe(
      'invalid_target',
    );
    expect(await code({ ...base, resource: 'acme/missing' })).toBe('invalid_target');

    const noRun = (
      await createApiToken(dbEnv, owner.userId, { label: 'x', scopes: ['repo:read'] })
    ).raw;
    expect(await code({ ...base, subject_token: noRun })).toBe('invalid_grant');
    // a read-only delegating token cannot hand out write
    const readOnly = (
      await createApiToken(dbEnv, owner.userId, {
        label: 'ro',
        scopes: ['repo:read', 'agent:run'],
      })
    ).raw;
    const writer = await createAgent(owner, {});
    expect(
      await code({
        subject_token: readOnly,
        agent_id: writer,
        resource: 'acme/app',
        scope: 'contents:write',
      }),
    ).toBe('invalid_scope');

    // someone else's agent cannot be delegated to
    const mallory = await loginAs(testEnv, 3, 'mallory');
    const malloryToken = (
      await createApiToken(dbEnv, mallory.userId, {
        label: 'm',
        scopes: ['repo:read', 'repo:write', 'agent:run'],
      })
    ).raw;
    expect(await code({ ...base, subject_token: malloryToken })).toBe('invalid_grant');
    // and only the owner sees or disables it
    expect(
      (
        await call(`/api/v1/agents/${agentId}`, {
          method: 'PATCH',
          headers: mallory.headers,
          body: { disabled: true },
        })
      ).status,
    ).toBe(404);
  });

  it('lets org members delegate to an org agent', async () => {
    const member = await loginAs(testEnv, 4, 'max');
    const stranger = await loginAs(testEnv, 5, 'eve');
    expect(
      (
        await call('/api/v1/orgs', {
          method: 'POST',
          headers: owner.headers,
          body: { slug: 'yuma', base_role: 'read' },
        })
      ).status,
    ).toBe(201);
    await call('/api/v1/orgs/yuma/members', {
      method: 'PUT',
      headers: owner.headers,
      body: { user_login: 'max', role: 'member' },
    });
    await call('/api/v1/repos', {
      method: 'POST',
      headers: owner.headers,
      body: { slug: 'yuma/core', org: 'yuma' },
    });
    const agentId = await createAgent(owner, { org: 'yuma', kind: 'factory' });
    const tokenOf = async (userId: string): Promise<string> =>
      (
        await createApiToken(dbEnv, userId, {
          label: 'd',
          scopes: ['repo:read', 'repo:write', 'agent:run'],
        })
      ).raw;
    expect(
      (
        await exchange({
          subject_token: await tokenOf(member.userId),
          agent_id: agentId,
          resource: 'yuma/core',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await exchange({
          subject_token: await tokenOf(stranger.userId),
          agent_id: agentId,
          resource: 'yuma/core',
        })
      ).status,
    ).toBe(400);
    // members delegate; only owners and admins manage
    expect(
      (
        await call(`/api/v1/agents/${agentId}`, {
          method: 'PATCH',
          headers: member.headers,
          body: { disabled: true },
        })
      ).status,
    ).toBe(404);
    expect(
      await q(dbEnv, "SELECT org_id FROM audit_events WHERE action = 'agent.create'"),
    ).toEqual([{ org_id: 'yuma' }]);
  });

  it('keeps agent:run API tokens owning refs/agents/<token id>/', async () => {
    const legacy = await createApiToken(dbEnv, owner.userId, {
      label: 'legacy',
      scopes: ['repo:write', 'agent:run'],
    });
    const head = (await getRef(dbEnv, repoId, 'main'))!.head;
    const res = await call(`/api/v1/repos/acme/app/refs/refs/agents/${legacy.id}/wip`, {
      method: 'PUT',
      headers: bearer(legacy.raw),
      body: { from: null, to: head },
    });
    expect(res.status).toBe(200);
  });
});
