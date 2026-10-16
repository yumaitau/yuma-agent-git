import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import type { Principal } from '../src/auth/principal';
import { cleanDb, loginAs, makeApp, seedSchema, type TestEnv } from './helpers';
import {
  blob,
  commit,
  dir,
  packOf,
  parseReport,
  pushBody,
  tree,
  ZERO,
  type Obj,
} from './git-helpers';
import { createRepo, getRef } from '../src/db/repos';
import { commitChanges } from '../src/core/commit';
import { q, run } from '../src/db/client';
import { createApiToken } from '../src/auth/tokens';
import { commitShas } from '../src/git/upload-pack';
import { executeTool } from '../src/agents/tools';
import { newBudget } from '../src/agents/budget';
import {
  evaluatePolicy,
  npmDependencies,
  npmRegistryOf,
  policyInputSchema,
  policySchema,
} from '../src/policy/engine';
import { DEFAULT_POLICY } from '../src/policy/guardrails';
import cases from './fixtures/policy/default.json';

const testEnv = env as unknown as TestEnv;
const dbEnv = testEnv as unknown as Env;
const app = makeApp(testEnv);

const EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS = 'urn:ietf:params:oauth:token-type:access_token';
const WORKFLOW = '.github/workflows/ci.yml';

type Login = Awaited<ReturnType<typeof loginAs>>;
let owner: Login;
let orgId = '';
let repoId = '';
let humanToken = '';
let delegateToken = '';
let agentId = '';
let agentToken = '';
let mainSha = '';
let readme: Obj;

async function call(
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
  fetch = app,
): Promise<Response> {
  return fetch(
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

async function errorOf(res: Response): Promise<Record<string, unknown>> {
  return ((await res.json()) as { error: Record<string, unknown> }).error;
}

async function exchange(agent = agentId): Promise<Response> {
  const form = new URLSearchParams({
    grant_type: EXCHANGE,
    subject_token_type: ACCESS,
    subject_token: delegateToken,
    agent_id: agent,
    resource: 'acme/app',
  });
  return app(
    new Request('https://x/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
    }),
  );
}

async function push(
  token: string,
  commands: [string, string, string][],
  objects: Obj[],
): Promise<ReturnType<typeof parseReport>> {
  const res = await app(
    new Request('https://x/acme/app.git/git-receive-pack', {
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

/** A child of main whose root holds README.md plus `files` (path → content). */
async function change(files: Record<string, string>, parent = mainSha) {
  const objects: Obj[] = [readme];
  const root: { name: string; mode?: string; sha: string }[] = [
    { name: 'README.md', sha: readme.sha },
  ];
  // one level of nesting per file is enough for these tests
  const dirs = new Map<string, { name: string; sha: string }[]>();
  for (const [path, text] of Object.entries(files)) {
    const b = await blob(text);
    objects.push(b);
    const parts = path.split('/');
    if (parts.length === 1) root.push({ name: path, sha: b.sha });
    else {
      const top = parts.slice(0, -1).join('/');
      dirs.set(top, [...(dirs.get(top) ?? []), { name: parts.at(-1)!, sha: b.sha }]);
    }
  }
  const tops = new Map<string, { name: string; mode: string; sha: string }[]>();
  for (const [path, entries] of dirs) {
    const t = await tree(entries);
    objects.push(t);
    const [top, sub] = path.split('/') as [string, string | undefined];
    if (sub === undefined) root.push(dir(top, t));
    else tops.set(top, [...(tops.get(top) ?? []), dir(sub, t)]);
  }
  for (const [top, entries] of tops) {
    const t = await tree(entries);
    objects.push(t);
    root.push(dir(top, t));
  }
  const rootTree = await tree(root.sort((a, b) => a.name.localeCompare(b.name)));
  const head = await commit(
    rootTree.sha,
    [parent],
    `change ${Object.keys(files).join(' ')}\n`,
  );
  return { head, objects: [head, rootTree, ...objects] };
}

async function headSha(name: string): Promise<string | null> {
  const ref = await getRef(dbEnv, repoId, name);
  return ref
    ? ((await commitShas(dbEnv, repoId, [ref.head])).get(ref.head) ?? null)
    : null;
}

interface Approval {
  id: string;
  action: string;
  principal: string;
  decision: string;
  payload_hash: string;
  payload: { ref?: string; files?: string[] };
  reasons: { rule: string }[];
  decided_by_login: string | null;
}

async function approvals(state = 'pending'): Promise<Approval[]> {
  const res = await call(`/api/v1/repos/acme/app/approvals?state=${state}`, {
    headers: owner.headers,
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { approvals: Approval[] }).approvals;
}

async function decide(id: string, decision: 'approve' | 'reject'): Promise<Response> {
  return call(`/api/v1/repos/acme/app/approvals/${id}`, {
    method: 'POST',
    headers: owner.headers,
    body: { decision },
  });
}

async function auditActions(): Promise<string[]> {
  return (
    await q<{ action: string }>(dbEnv, 'SELECT action FROM audit_events ORDER BY id')
  ).map((r) => r.action);
}

const b64 = (text: string): string => btoa(text);

describe('policy engine', () => {
  it('runs every fixture against the default pack', () => {
    for (const t of cases) {
      const input = policyInputSchema.parse(t.input);
      expect(evaluatePolicy(DEFAULT_POLICY, input).outcome, t.name).toBe(t.expect);
    }
  });

  it('names the rule and the reason, and the strictest effect wins', () => {
    const result = evaluatePolicy(DEFAULT_POLICY, {
      action: 'push',
      ref: 'feature',
      force_push: true,
      files: [{ path: WORKFLOW, op: 'mod' }],
    });
    expect(result.outcome).toBe('deny');
    expect(result.matches).toEqual([
      {
        rule: 'ci-workflows',
        effect: 'require_approval',
        message: `policy ci-workflows needs approval: changes ${WORKFLOW}`,
      },
      {
        rule: 'force-push',
        effect: 'deny',
        message: 'policy force-push denies: targets feature, is a force push',
      },
    ]);
  });

  it('judges pipeline file changes as pipeline.edit too', () => {
    const policy = policySchema.parse({
      version: 1,
      rules: [{ id: 'p', actions: ['pipeline.edit'], effect: 'deny' }],
    });
    const files = [{ path: '.yuma/pipelines/ci.yml', op: 'add' as const }];
    expect(evaluatePolicy(policy, { action: 'push', files }).outcome).toBe('deny');
    expect(evaluatePolicy(policy, { action: 'ref.move', files }).outcome).toBe('allow');
  });

  it('rejects malformed policies', () => {
    const rule = { id: 'a', actions: ['push'], effect: 'deny' };
    expect(policySchema.safeParse({ version: 1, rules: [rule, rule] }).success).toBe(
      false,
    );
    expect(
      policySchema.safeParse({ version: 1, rules: [{ ...rule, when: { size: 1 } }] })
        .success,
    ).toBe(false);
    expect(
      policySchema.safeParse({ version: 1, rules: [{ ...rule, actions: ['delete'] }] })
        .success,
    ).toBe(false);
  });

  it('works out where npm dependencies come from', () => {
    expect(npmRegistryOf('^4.1.0')).toBe('registry.npmjs.org');
    expect(npmRegistryOf('npm:zod@4')).toBe('registry.npmjs.org');
    expect(npmRegistryOf('workspace:*')).toBe('local');
    expect(npmRegistryOf('file:../sdk')).toBe('local');
    expect(npmRegistryOf('github:evil/pad')).toBe('github.com');
    expect(npmRegistryOf('evil/pad#main')).toBe('github.com');
    expect(npmRegistryOf('git+ssh://git@gitlab.example.com/x.git')).toBe(
      'gitlab.example.com',
    );
    expect(npmRegistryOf('git@bitbucket.org:x/y.git')).toBe('bitbucket.org');
    expect(npmRegistryOf('https://cdn.example.com/pad.tgz')).toBe('cdn.example.com');
    expect(
      npmDependencies(
        JSON.stringify({
          dependencies: { zod: '^4' },
          devDependencies: { pad: 'evil/pad' },
        }),
      ),
    ).toEqual([
      { name: 'zod', registry: 'registry.npmjs.org' },
      { name: 'pad', registry: 'github.com' },
    ]);
    expect(npmDependencies('{')).toEqual([{ name: 'package.json', registry: 'invalid' }]);
  });
});

describe('agent guardrails (#62)', () => {
  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
    owner = await loginAs(testEnv, 1, 'justin');
    const org = await call('/api/v1/orgs', {
      method: 'POST',
      headers: owner.headers,
      body: { slug: 'acme' },
    });
    expect(org.status).toBe(201);
    orgId = (
      await q<{ id: string }>(dbEnv, "SELECT id FROM orgs WHERE slug = 'acme'")
    )[0]!.id;
    repoId = (
      await createRepo(dbEnv, {
        slug: 'acme/app',
        createdBy: owner.userId,
        ownerKind: 'org',
        ownerId: orgId,
      })
    ).id;
    humanToken = (
      await createApiToken(dbEnv, owner.userId, {
        label: 'human',
        scopes: ['repo:read', 'repo:write'],
      })
    ).raw;
    delegateToken = (
      await createApiToken(dbEnv, owner.userId, {
        label: 'delegate',
        scopes: ['repo:read', 'repo:write', 'agent:run'],
      })
    ).raw;
    readme = await blob('hello\n');
    const rootTree = await tree([{ name: 'README.md', sha: readme.sha }]);
    const root = await commit(rootTree.sha, [], 'root\n');
    const report = await push(
      humanToken,
      [[ZERO, root.sha, 'refs/heads/main']],
      [root, rootTree, readme],
    );
    expect(report.refs['refs/heads/main']).toBe('ok');
    mainSha = root.sha;
    const created = await call('/api/v1/agents', {
      method: 'POST',
      headers: owner.headers,
      body: { name: 'Codex', kind: 'codex' },
    });
    agentId = ((await created.json()) as { id: string }).id;
    const issued = await exchange();
    expect(issued.status).toBe(200);
    agentToken = ((await issued.json()) as { access_token: string }).access_token;
  });

  it('holds an agent push that edits a CI workflow until a human approves that exact payload', async () => {
    const first = await change({ [WORKFLOW]: 'on: push\n' });
    const held = await push(
      agentToken,
      [[ZERO, first.head.sha, 'refs/heads/feature']],
      first.objects,
    );
    expect(held.refs['refs/heads/feature']).toMatch(
      /^approval_required: policy ci-workflows needs approval: changes \.github\/workflows\/ci\.yml; approval \w+ waits for a human/,
    );
    expect(await headSha('feature')).toBeNull();

    const [pending] = await approvals();
    expect(pending).toMatchObject({
      action: 'push',
      decision: 'pending',
      payload: { ref: 'feature', files: [WORKFLOW] },
      reasons: [{ rule: 'ci-workflows' }],
    });

    // pushing it again waits on the same request
    await push(agentToken, [[ZERO, first.head.sha, 'refs/heads/feature']], first.objects);
    expect(await approvals()).toHaveLength(1);

    // a different payload is a different request
    const other = await change({ [WORKFLOW]: 'on: [push, pull_request]\n' });
    const otherHeld = await push(
      agentToken,
      [[ZERO, other.head.sha, 'refs/heads/feature']],
      other.objects,
    );
    expect(otherHeld.refs['refs/heads/feature']).toMatch(/^approval_required/);
    expect(await approvals()).toHaveLength(2);

    // tokens never decide: the agent cannot approve its own change
    const self = await call(`/api/v1/repos/acme/app/approvals/${pending!.id}`, {
      method: 'POST',
      headers: bearer(agentToken),
      body: { decision: 'approve' },
    });
    expect(self.status).toBe(401);

    const approved = await decide(pending!.id, 'approve');
    expect(approved.status).toBe(200);
    expect(((await approved.json()) as { approval: Approval }).approval).toMatchObject({
      decision: 'approved',
      decided_by_login: 'justin',
    });
    expect((await decide(pending!.id, 'reject')).status).toBe(409);

    // the approved payload lands; the other one is still held
    const landed = await push(
      agentToken,
      [[ZERO, first.head.sha, 'refs/heads/feature']],
      first.objects,
    );
    expect(landed.refs['refs/heads/feature']).toBe('ok');
    expect(await headSha('feature')).toBe(first.head.sha);
    const otherBranch = await push(
      agentToken,
      [[ZERO, other.head.sha, 'refs/heads/other']],
      other.objects,
    );
    expect(otherBranch.refs['refs/heads/other']).toMatch(/^approval_required/);

    const actions = await auditActions();
    expect(actions.filter((a) => a === 'policy.approval.request')).toHaveLength(3);
    expect(actions).toContain('policy.approval.approve');
  });

  it('refuses a rejected payload and lets agents push ordinary changes', async () => {
    const plain = await change({ 'notes.txt': 'hi\n' });
    const ok = await push(
      agentToken,
      [[ZERO, plain.head.sha, 'refs/heads/plain']],
      plain.objects,
    );
    expect(ok.refs['refs/heads/plain']).toBe('ok');

    const wf = await change({ [WORKFLOW]: 'on: push\n' });
    await push(agentToken, [[ZERO, wf.head.sha, 'refs/heads/wf']], wf.objects);
    const [pending] = await approvals();
    expect((await decide(pending!.id, 'reject')).status).toBe(200);
    const again = await push(
      agentToken,
      [[ZERO, wf.head.sha, 'refs/heads/wf']],
      wf.objects,
    );
    expect(again.refs['refs/heads/wf']).toMatch(
      /^approval_rejected: a human rejected approval/,
    );
    expect(await auditActions()).toContain('policy.approval.reject');

    // humans are not judged by agent policies
    const human = await push(
      humanToken,
      [[ZERO, wf.head.sha, 'refs/heads/wf']],
      wf.objects,
    );
    expect(human.refs['refs/heads/wf']).toBe('ok');
  });

  it('denies agent force pushes and holds dependencies from outside the registry', async () => {
    const v1 = await change({ 'a.txt': '1\n' });
    expect(
      (await push(agentToken, [[ZERO, v1.head.sha, 'refs/heads/f']], v1.objects)).refs[
        'refs/heads/f'
      ],
    ).toBe('ok');
    const sibling = await change({ 'a.txt': '2\n' });
    const forced = await push(
      agentToken,
      [[v1.head.sha, sibling.head.sha, 'refs/heads/f']],
      sibling.objects,
    );
    expect(forced.refs['refs/heads/f']).toBe(
      'policy_denied: policy force-push denies: targets f, is a force push',
    );
    expect(await auditActions()).toContain('policy.deny');
    // an agent rewrites its own work refs freely
    const own = `refs/agents/${agentId}/wip`;
    expect((await push(agentToken, [[ZERO, v1.head.sha, own]], [])).refs[own]).toBe('ok');
    expect(
      (await push(agentToken, [[v1.head.sha, sibling.head.sha, own]], sibling.objects))
        .refs[own],
    ).toBe('ok');

    const dep = await change({
      'package.json': JSON.stringify({ dependencies: { pad: 'github:evil/pad' } }),
    });
    const held = await push(
      agentToken,
      [[ZERO, dep.head.sha, 'refs/heads/dep']],
      dep.objects,
    );
    expect(held.refs['refs/heads/dep']).toMatch(
      /^approval_required: policy untrusted-dependencies needs approval: adds pad from github\.com/,
    );
  });

  it('holds agent commits through the API and lets the identical request through once approved', async () => {
    const mainCs = (await getRef(dbEnv, repoId, 'main'))!.head;
    const request = {
      first_parent: mainCs,
      message: 'ci',
      author: { name: 'Codex', email: 'c@example.com' },
      changes: [{ path: WORKFLOW, op: 'add', content_b64: b64('on: push\n') }],
    };
    const held = await call('/api/v1/repos/acme/app/changesets', {
      method: 'POST',
      headers: bearer(agentToken),
      body: request,
    });
    expect(held.status).toBe(403);
    const error = await errorOf(held);
    expect(error).toMatchObject({
      code: 'approval_required',
      approval: { decision: 'pending' },
      policy: { version: 0, matches: [{ rule: 'ci-workflows' }] },
    });
    const id = (error.approval as { id: string }).id;
    expect((await decide(id, 'approve')).status).toBe(200);

    const changed = await call('/api/v1/repos/acme/app/changesets', {
      method: 'POST',
      headers: bearer(agentToken),
      body: { ...request, message: 'ci, reworded' },
    });
    expect(changed.status).toBe(403); // a different payload needs its own approval
    const landed = await call('/api/v1/repos/acme/app/changesets', {
      method: 'POST',
      headers: bearer(agentToken),
      body: request,
    });
    expect(landed.status).toBe(201);
  });

  it('holds an agent applying a review suggestion to a CI workflow', async () => {
    const mainCs = (await getRef(dbEnv, repoId, 'main'))!.head;
    const head = (
      await commitChanges(dbEnv, repoId, {
        first_parent: mainCs,
        message: 'ci',
        author: { name: 'Ada', email: 'ada@example.com' },
        changes: [{ path: WORKFLOW, op: 'add', content_b64: b64('on: push\n') }],
      })
    ).changeset.id;
    const opened = await call('/api/v1/repos/acme/app/pulls', {
      method: 'POST',
      headers: owner.headers,
      body: { title: 'CI', head_cs: head },
    });
    expect(opened.status).toBe(201);
    const pull = ((await opened.json()) as { pull: { id: number; revision: number } })
      .pull;
    const posted = await call(`/api/v1/repos/acme/app/pulls/${pull.id}/threads`, {
      method: 'POST',
      headers: bearer(agentToken),
      body: {
        path: WORKFLOW,
        head_cs: head,
        revision: pull.revision,
        line: 1,
        body: '```suggestion\non: [push, pull_request]\n```',
      },
    });
    expect(posted.status).toBe(201);
    const { thread } = (await posted.json()) as {
      thread: { comments: { id: number }[] };
    };
    const apply = () =>
      call(`/api/v1/repos/acme/app/pulls/${pull.id}/suggestions/apply`, {
        method: 'POST',
        headers: bearer(agentToken),
        body: {
          comment_ids: [thread.comments[0]!.id],
          head_cs: head,
          revision: pull.revision,
        },
      });
    const held = await apply();
    expect(held.status).toBe(403);
    const error = await errorOf(held);
    expect(error).toMatchObject({
      code: 'approval_required',
      policy: { matches: [{ rule: 'ci-workflows' }] },
    });
    expect((await decide((error.approval as { id: string }).id, 'approve')).status).toBe(
      200,
    );
    expect((await apply()).status).toBe(200);
  });

  it('judges built-in agent runs through their tools', async () => {
    const mainCs = (await getRef(dbEnv, repoId, 'main'))!.head;
    const ctx = {
      repo_id: repoId,
      principal: {
        kind: 'token',
        userId: owner.userId,
        tokenId: 'task-9',
        scopes: ['repo:read', 'repo:write', 'agent:run'],
        repoId,
      } as Principal,
      base_cs: mainCs,
      head_cs: mainCs,
      budget: newBudget(),
      task_id: 'task-9',
    };
    const input = {
      message: 'ci',
      changes: [{ path: WORKFLOW, op: 'add', content_b64: b64('on: push\n') }],
    };
    const held = await executeTool(dbEnv, ctx, 'commit', input);
    expect(held).toMatchObject({
      error: 'approval_required',
      approval: { decision: 'pending' },
    });
    const [pending] = await approvals();
    expect(pending).toMatchObject({
      action: 'changeset.create',
      principal: 'task:task-9',
    });
    expect((await decide(pending!.id, 'approve')).status).toBe(200);
    const done = await executeTool(dbEnv, ctx, 'commit', input);
    expect(done).toMatchObject({ changed_files: [{ path: WORKFLOW }] });
  });

  it('judges agent settings runs and retries as pipeline runs', async () => {
    await run(
      dbEnv,
      'INSERT INTO agent_policies (org_id, version, document, created_by, created_at) VALUES (?, 1, ?, ?, ?)',
      [
        orgId,
        JSON.stringify({
          version: 1,
          rules: [{ id: 'no-runs', actions: ['pipeline.run'], effect: 'deny' }],
        }),
        owner.userId,
        Date.now(),
      ],
    );
    const created = await call('/api/v1/agents', {
      method: 'POST',
      headers: owner.headers,
      body: {
        name: 'Runner',
        kind: 'factory',
        max_scopes: ['contents:read', 'contents:write', 'ci:run'],
      },
    });
    const issued = await exchange(((await created.json()) as { id: string }).id);
    const token = ((await issued.json()) as { access_token: string }).access_token;
    const mainCs = (await getRef(dbEnv, repoId, 'main'))!.head;
    await run(
      dbEnv,
      `INSERT INTO ci_runs (id, repo_id, head_cs, settings_version, config, requested_by,
                            state, publish, month, reserved_micros, created_at)
       VALUES ('old-run', ?, ?, 1, '{}', ?, 'passed', 0, '2026-10', 0, 0)`,
      [repoId, mainCs, owner.userId],
    );
    for (const path of ['/ci/runs', '/ci/runs/old-run/retry']) {
      const res = await call(`/api/v1/repos/acme/app${path}`, {
        method: 'POST',
        headers: bearer(token),
        body: {},
      });
      expect(res.status).toBe(403);
      expect((await errorOf(res)).code).toBe('policy_denied');
    }
  });

  it('holds agent tags as releases', async () => {
    const created = await call('/api/v1/agents', {
      method: 'POST',
      headers: owner.headers,
      body: {
        name: 'Releaser',
        kind: 'factory',
        max_scopes: ['contents:read', 'contents:write', 'releases:write'],
      },
    });
    const releaser = ((await created.json()) as { id: string }).id;
    const issued = await exchange(releaser);
    const token = ((await issued.json()) as { access_token: string }).access_token;
    const mainCs = (await getRef(dbEnv, repoId, 'main'))!.head;
    const tag = await call('/api/v1/repos/acme/app/tags', {
      method: 'POST',
      headers: bearer(token),
      body: { name: 'v1.0.0', target: mainCs },
    });
    expect(tag.status).toBe(403);
    expect(await errorOf(tag)).toMatchObject({
      code: 'approval_required',
      policy: { matches: [{ rule: 'releases' }] },
    });
    const pushed = await push(token, [[ZERO, mainSha, 'refs/tags/v1.0.0']], []);
    expect(pushed.refs['refs/tags/v1.0.0']).toMatch(
      /^approval_required: policy releases/,
    );
    // a person's API token (agent:run is a default scope) is not an agent
    const human = await call('/api/v1/repos/acme/app/tags', {
      method: 'POST',
      headers: bearer(delegateToken),
      body: { name: 'v1.0.0', target: mainCs },
    });
    expect(human.status).toBe(201);
  });

  it('pauses every agent in the org at once and shows who paused it', async () => {
    const before = await call('/api/v1/repos/acme/app/refs', {
      headers: bearer(agentToken),
    });
    expect(before.status).toBe(200);
    const now = Date.now();
    await run(
      dbEnv,
      `INSERT INTO agent_tasks (id, repo_id, kind, prompt, status, created_by, created_at, updated_at)
       VALUES ('task-1', ?, 'freeform', 'x', 'queued', ?, ?, ?)`,
      [repoId, owner.userId, now, now],
    );

    const paused = await call('/api/v1/orgs/acme/agents/pause', {
      method: 'POST',
      headers: owner.headers,
      body: { reason: 'incident 7' },
    });
    expect(paused.status).toBe(200);
    expect(((await paused.json()) as { paused: unknown }).paused).toMatchObject({
      paused_by: owner.userId,
      paused_by_login: 'justin',
      reason: 'incident 7',
    });

    // the very next request: tokens revoked, runs cancelled, writes refused
    const after = await call('/api/v1/repos/acme/app/refs', {
      headers: bearer(agentToken),
    });
    expect(after.status).toBe(401);
    expect(await q(dbEnv, 'SELECT jti FROM agent_tokens')).toEqual([]);
    expect(await q(dbEnv, "SELECT status FROM agent_tasks WHERE id = 'task-1'")).toEqual([
      { status: 'cancelled' },
    ]);
    const plain = await change({ 'notes.txt': 'hi\n' });
    const minted = await exchange();
    expect(minted.status).toBe(403);
    expect((await errorOf(minted)).code).toBe('agents_paused');
    const tool = await executeTool(
      dbEnv,
      {
        repo_id: repoId,
        principal: {
          kind: 'token',
          userId: owner.userId,
          tokenId: 'task-2',
          scopes: ['repo:read', 'repo:write', 'agent:run'],
          repoId,
        } as Principal,
        base_cs: mainSha,
        head_cs: mainSha,
        budget: newBudget(),
        task_id: 'task-2',
      },
      'read_file',
      { path: 'README.md' },
    );
    expect(tool).toEqual({
      error: 'agents_paused',
      message: 'agents are paused in this org by justin: incident 7',
      terminal: 'failure',
      reason: 'agents are paused in this org by justin: incident 7',
    });
    // people keep working
    expect(
      (await push(humanToken, [[ZERO, plain.head.sha, 'refs/heads/p']], plain.objects))
        .refs['refs/heads/p'],
    ).toBe('ok');

    const status = await call('/api/v1/orgs/acme/agents/pause', {
      headers: owner.headers,
    });
    expect(((await status.json()) as { paused: unknown }).paused).toMatchObject({
      paused_by_login: 'justin',
    });

    expect(
      (
        await call('/api/v1/orgs/acme/agents/pause', {
          method: 'DELETE',
          headers: owner.headers,
        })
      ).status,
    ).toBe(200);
    expect((await exchange()).status).toBe(200);
    const actions = await auditActions();
    expect(actions).toContain('agents.pause');
    expect(actions).toContain('agents.resume');
  });

  it('refuses agent tokens while paused even before they are revoked', async () => {
    await run(
      dbEnv,
      "INSERT INTO agent_pauses (scope_id, paused_by, reason, paused_at) VALUES (?, ?, '', ?)",
      [orgId, owner.userId, Date.now()],
    );
    const res = await call('/api/v1/repos/acme/app/refs', {
      headers: bearer(agentToken),
    });
    expect(res.status).toBe(401);
  });

  it('lets only agents admins pause the whole instance', async () => {
    const denied = await call('/api/v1/admin/agents/pause', {
      method: 'POST',
      headers: owner.headers,
      body: {},
    });
    expect(denied.status).toBe(403);
    const admin = makeApp({ ...testEnv, AGENTS_ADMIN_USER_IDS: owner.userId } as Env);
    const paused = await call(
      '/api/v1/admin/agents/pause',
      { method: 'POST', headers: owner.headers, body: { reason: 'all stop' } },
      admin,
    );
    expect(paused.status).toBe(200);
    expect(
      (await call('/api/v1/repos/acme/app/refs', { headers: bearer(agentToken) })).status,
    ).toBe(401);
    const org = await call('/api/v1/orgs/acme/agents/pause', { headers: owner.headers });
    expect(((await org.json()) as { instance: unknown }).instance).toMatchObject({
      reason: 'all stop',
    });
    expect(
      (
        await call(
          '/api/v1/admin/agents/pause',
          { method: 'DELETE', headers: owner.headers },
          admin,
        )
      ).status,
    ).toBe(200);
  });

  it('versions and audits org policies, and fails closed when one cannot be read', async () => {
    const initial = await call('/api/v1/orgs/acme/policy', { headers: owner.headers });
    expect(await initial.json()).toMatchObject({ version: 0, default: true });

    const bad = await call('/api/v1/orgs/acme/policy', {
      method: 'PUT',
      headers: owner.headers,
      body: { version: 1, rules: [{ id: 'x', actions: ['nope'], effect: 'deny' }] },
    });
    expect(bad.status).toBe(400);
    expect((await errorOf(bad)).code).toBe('invalid_policy');

    const docs = {
      version: 1,
      rules: [
        {
          id: 'no-docs',
          actions: ['changeset.create'],
          effect: 'deny',
          when: { paths: ['docs/**'] },
        },
      ],
    };
    for (const policy of [{ version: 1, rules: [] }, docs]) {
      const res = await call('/api/v1/orgs/acme/policy', {
        method: 'PUT',
        headers: owner.headers,
        body: policy,
      });
      expect(res.status).toBe(200);
    }
    const versions = await call('/api/v1/orgs/acme/policy/versions', {
      headers: owner.headers,
    });
    expect(
      (
        (await versions.json()) as {
          versions: { version: number; created_by_login: string }[];
        }
      ).versions,
    ).toMatchObject([
      { version: 2, created_by_login: 'justin' },
      { version: 1, created_by_login: 'justin' },
    ]);
    expect((await auditActions()).filter((a) => a === 'policy.update')).toHaveLength(2);

    const mainCs = (await getRef(dbEnv, repoId, 'main'))!.head;
    const commitAs = (token: string, path: string): Promise<Response> =>
      call('/api/v1/repos/acme/app/changesets', {
        method: 'POST',
        headers: bearer(token),
        body: {
          first_parent: mainCs,
          message: path,
          author: { name: 'Codex', email: 'c@example.com' },
          changes: [{ path, op: 'add', content_b64: b64('x\n') }],
        },
      });
    const denied = await commitAs(agentToken, 'docs/a.md');
    expect(denied.status).toBe(403);
    expect(await errorOf(denied)).toMatchObject({
      code: 'policy_denied',
      message: 'policy no-docs denies: changes docs/a.md',
      policy: { version: 2 },
    });
    // the org policy replaced the default pack, so workflows pass now
    expect((await commitAs(agentToken, WORKFLOW)).status).toBe(201);

    await run(dbEnv, "UPDATE agent_policies SET document = '{' WHERE version = 2");
    const closed = await commitAs(agentToken, 'src/a.ts');
    expect(closed.status).toBe(403);
    expect((await errorOf(closed)).code).toBe('policy_unavailable');
    expect((await commitAs(humanToken, 'src/a.ts')).status).toBe(201);
  });

  it('tests a policy against fixtures without storing anything', async () => {
    const run = async (body: unknown): Promise<{ passed: number; failed: number }> => {
      const res = await call('/api/v1/policy/test', {
        method: 'POST',
        headers: bearer(humanToken),
        body,
      });
      expect(res.status).toBe(200);
      return (await res.json()) as { passed: number; failed: number };
    };
    expect(await run({ cases })).toEqual(
      expect.objectContaining({ passed: cases.length, failed: 0 }),
    );
    expect(await run({ policy: { version: 1, rules: [] }, cases })).toEqual(
      expect.objectContaining({
        failed: cases.filter((c) => c.expect !== 'allow').length,
      }),
    );
    const anonymous = await call('/api/v1/policy/test', {
      method: 'POST',
      body: { cases },
    });
    expect(anonymous.status).toBe(401);
  });
});
