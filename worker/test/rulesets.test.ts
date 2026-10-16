import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { cleanDb, loginAs, makeApp, seedSchema, type TestEnv } from './helpers';
import type { Env } from '../src/env';
import { createRepo, getRef, setRef } from '../src/db/repos';
import { commitChanges } from '../src/core/commit';
import { q, run } from '../src/db/client';
import { createApiToken } from '../src/auth/tokens';
import {
  applies,
  canBypass,
  evaluate,
  globMatch,
  rulesetInputSchema,
  type Actor,
  type Ruleset,
} from '../src/policy/rulesets';
import {
  blob,
  commit as gitCommit,
  packOf,
  parseReport,
  pushBody,
  tree,
  ZERO,
} from './git-helpers';
import type { Pull } from '../shared/collaboration';

const testEnv = env as unknown as TestEnv;
const dbEnv = testEnv as unknown as Env;
const app = makeApp(testEnv);
const author = { name: 'Ada', email: 'ada@example.com' };

type User = Awaited<ReturnType<typeof loginAs>>;
let owner: User;
let writer: User;
let repoId: string;
let base: string;

async function cs(
  repo: string,
  parent: string | null,
  name: string,
  body = 'x',
): Promise<string> {
  return (
    await commitChanges(dbEnv, repo, {
      first_parent: parent,
      message: name,
      author,
      changes: [{ path: name, op: 'add', content_b64: btoa(body) }],
    })
  ).changeset.id;
}

async function api(
  path: string,
  method = 'GET',
  body?: unknown,
  who: User = owner,
): Promise<Response> {
  return app(
    new Request(`https://x/api/v1${path}`, {
      method,
      headers: { ...who.headers, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

async function addRuleset(body: unknown, prefix = '/repos/team/app'): Promise<Ruleset> {
  const res = await api(`${prefix}/rulesets`, 'POST', body);
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { ruleset: Ruleset }).ruleset;
}

async function errorOf(res: Response): Promise<{ code: string; message: string }> {
  return ((await res.json()) as { error: { code: string; message: string } }).error;
}

/** `git push` to a fresh repo through the smart HTTP endpoint, as `owner`. */
async function gitPush(
  slug: string,
  body: Uint8Array,
): Promise<ReturnType<typeof parseReport>> {
  const token = await createApiToken(dbEnv, owner.userId, { label: 'git' });
  const res = await app(
    new Request(`https://x/${slug}.git/git-receive-pack`, {
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

/** A root commit holding `files`, as Git objects. */
async function gitTree(
  files: Record<string, string | Uint8Array>,
  parents: string[] = [],
  message = 'm\n',
): Promise<{ objects: Awaited<ReturnType<typeof blob>>[]; sha: string }> {
  const blobs = await Promise.all(Object.values(files).map((f) => blob(f)));
  const root = await tree(
    Object.keys(files).map((name, i) => ({ name, sha: blobs[i]!.sha })),
  );
  const head = await gitCommit(root.sha, parents, message);
  return { objects: [head, root, ...blobs], sha: head.sha };
}

beforeEach(async () => {
  await seedSchema(testEnv);
  await cleanDb(testEnv);
  owner = await loginAs(testEnv, 801, 'owner');
  writer = await loginAs(testEnv, 802, 'writer');
  repoId = (await createRepo(dbEnv, { slug: 'team/app', createdBy: owner.userId })).id;
  await run(
    dbEnv,
    "INSERT INTO repo_members (repo_id, user_id, role) VALUES (?, ?, 'write')",
    [repoId, writer.userId],
  );
  base = await cs(repoId, null, 'base.txt');
  await setRef(dbEnv, repoId, 'main', base);
});

describe('the evaluator', () => {
  const ruleset = (over: Record<string, unknown> & { rules: unknown[] }): Ruleset => ({
    id: 'r1',
    scope: 'repo',
    owner_id: 'repo',
    created_by: 'u',
    created_at: 0,
    updated_at: 0,
    ...rulesetInputSchema.parse({
      name: 'R',
      target: 'branch',
      conditions: { ref_name: { include: ['~DEFAULT_BRANCH', 'release/*'] } },
      ...over,
    }),
  });
  const repo = { slug: 'team/app', default_branch: 'main' };
  const nobody: Actor = {
    principal: { kind: 'user', userId: 'u1' },
    role: 'write',
    teams: [],
  };

  it('matches refs by pattern, target and repository name', () => {
    expect(globMatch('release/*', 'release/1.0')).toBe(true);
    expect(globMatch('release/*', 'release/1/x')).toBe(false);
    expect(globMatch('release/**', 'release/1/x')).toBe(true);
    // no regex backtracking: a hostile pattern stays linear in its length
    expect(globMatch('*a'.repeat(100), `${'a'.repeat(250)}b`)).toBe(false);
    const r = ruleset({ rules: [{ type: 'deletion' }] });
    expect(applies(r, repo, 'main')).toBe(true);
    expect(applies(r, repo, 'release/2')).toBe(true);
    expect(applies(r, repo, 'feature')).toBe(false);
    expect(applies(r, repo, 'refs/tags/main')).toBe(false);
    expect(applies(r, repo, 'refs/agents/a/main')).toBe(false);
    const tag = ruleset({
      target: 'tag',
      conditions: { ref_name: { include: ['refs/tags/v*'] } },
      rules: [{ type: 'deletion' }],
    });
    expect(applies(tag, repo, 'refs/tags/v1')).toBe(true);
    expect(applies(tag, repo, 'v1')).toBe(false);
    const org = {
      ...ruleset({
        conditions: {
          ref_name: { include: ['~ALL'] },
          repository_name: { include: ['app*'], exclude: ['app-legacy'] },
        },
        rules: [{ type: 'deletion' }],
      }),
      scope: 'org' as const,
    };
    expect(applies(org, repo, 'x')).toBe(true);
    expect(applies(org, { ...repo, slug: 'team/app-legacy' }, 'x')).toBe(false);
    expect(applies(org, { ...repo, slug: 'team/docs' }, 'x')).toBe(false);
  });

  it('is deterministic and keeps evaluate mode and bypass apart from blocking', () => {
    const rulesets = [
      ruleset({ rules: [{ type: 'non_fast_forward' }, { type: 'deletion' }] }),
      ruleset({ name: 'E', enforcement: 'evaluate', rules: [{ type: 'update' }] }),
    ];
    const input = {
      repo,
      actor: nobody,
      ref: { name: 'main', kind: 'update' as const, fastForward: false },
    };
    const outcome = evaluate(rulesets, input);
    expect(evaluate(rulesets, input)).toEqual(outcome);
    expect(outcome.allowed).toBe(false);
    expect(outcome.blocking.map((v) => v.rule)).toEqual(['non_fast_forward']);
    expect(outcome.evaluated.map((v) => v.rule)).toEqual(['update']);
    // a merge is not a direct update
    expect(
      evaluate(rulesets, {
        ...input,
        ref: {
          ...input.ref,
          fastForward: true,
          merge: { approvals: 0, checksPassed: false },
        },
      }).evaluated,
    ).toEqual([]);
  });

  it('lets roles, teams, agents and users on the bypass list through', () => {
    const r = ruleset({
      rules: [{ type: 'deletion' }],
      bypass: ['role:admin', 'team:ops', 'agent:t1', 'user:u9'],
    });
    expect(canBypass(r, nobody)).toBe(false);
    expect(canBypass(r, { ...nobody, role: 'admin' })).toBe(true);
    expect(canBypass(r, { ...nobody, teams: ['ops'] })).toBe(true);
    expect(canBypass(r, { ...nobody, principal: { kind: 'user', userId: 'u9' } })).toBe(
      true,
    );
    const token = {
      kind: 'token' as const,
      userId: 'u1',
      tokenId: 't1',
      scopes: [],
      repoId: null,
    };
    expect(canBypass(r, { ...nobody, principal: token })).toBe(true);
    expect(canBypass(r, { principal: null, role: null, teams: [] })).toBe(false);
    const write = ruleset({ rules: [{ type: 'deletion' }], bypass: ['role:write'] });
    expect(canBypass(write, { ...nobody, role: 'admin' })).toBe(true);
    expect(canBypass(write, { ...nobody, role: 'read' })).toBe(false);
  });

  it('rejects rules that do not fit the target', () => {
    expect(
      rulesetInputSchema.safeParse({
        name: 'x',
        target: 'tag',
        conditions: { ref_name: { include: ['*'] } },
        rules: [{ type: 'pull_request', required_approvals: 1 }],
      }).success,
    ).toBe(false);
    expect(
      rulesetInputSchema.safeParse({
        name: 'x',
        target: 'branch',
        rules: [{ type: 'deletion' }],
      }).success,
    ).toBe(false);
    expect(
      rulesetInputSchema.safeParse({
        name: 'x',
        target: 'push',
        rules: [{ type: 'max_file_size', max_bytes: 10 }],
        bypass: ['everyone'],
      }).success,
    ).toBe(false);
  });
});

describe('enforcement', () => {
  it('refuses a force push on main for git push and PUT refs alike, naming the ruleset', async () => {
    await addRuleset({
      name: 'No force on main',
      target: 'branch',
      conditions: { ref_name: { include: ['main'] } },
      rules: [{ type: 'non_fast_forward' }],
    });
    const unrelated = await cs(repoId, null, 'other.txt');
    const forced = await api('/repos/team/app/refs/main', 'PUT', {
      from: base,
      to: unrelated,
      force: true,
    });
    expect(forced.status).toBe(403);
    expect(await errorOf(forced)).toEqual({
      code: 'ruleset_violation',
      message: 'ruleset "No force on main": force pushes to main are not allowed',
      ruleset: 'No force on main',
      rule: 'non_fast_forward',
      violations: [
        {
          ruleset: 'No force on main',
          rule: 'non_fast_forward',
          message: 'force pushes to main are not allowed',
        },
      ],
    });
    expect((await getRef(dbEnv, repoId, 'main'))?.head).toBe(base);
    // force on a fast-forward is not a rewrite
    const child = await cs(repoId, base, 'child.txt');
    expect(
      (
        await api('/repos/team/app/refs/main', 'PUT', {
          from: base,
          to: child,
          force: true,
        })
      ).status,
    ).toBe(200);

    // the same rule through git push
    const pushRepo = await createRepo(dbEnv, {
      slug: 'team/push',
      createdBy: owner.userId,
    });
    await addRuleset(
      {
        name: 'No force on main',
        target: 'branch',
        conditions: { ref_name: { include: ['refs/heads/main'] } },
        rules: [{ type: 'non_fast_forward' }],
      },
      '/repos/team/push',
    );
    const first = await gitTree({ 'a.txt': 'a\n' });
    expect(
      (
        await gitPush(
          'team/push',
          pushBody([[ZERO, first.sha, 'refs/heads/main']], await packOf(first.objects)),
        )
      ).refs['refs/heads/main'],
    ).toBe('ok');
    const other = await gitTree({ 'b.txt': 'b\n' }, [], 'rewrite\n');
    const report = await gitPush(
      'team/push',
      pushBody([[first.sha, other.sha, 'refs/heads/main']], await packOf(other.objects)),
    );
    expect(report.refs['refs/heads/main']).toBe(
      'ruleset "No force on main" non_fast_forward: force pushes to main are not allowed',
    );
    expect(report.messages).toContain('rejected by ruleset "No force on main"');
    expect(await getRef(dbEnv, pushRepo.id, 'main')).not.toBeNull();
  });

  it('logs evaluate-mode violations without blocking', async () => {
    const ruleset = await addRuleset({
      name: 'Trial',
      target: 'branch',
      enforcement: 'evaluate',
      conditions: { ref_name: { include: ['~DEFAULT_BRANCH'] } },
      rules: [{ type: 'non_fast_forward' }, { type: 'update' }],
    });
    const unrelated = await cs(repoId, null, 'other.txt');
    expect(
      (
        await api('/repos/team/app/refs/main', 'PUT', {
          from: base,
          to: unrelated,
          force: true,
        })
      ).status,
    ).toBe(200);
    const res = await api('/repos/team/app/rulesets/evaluations');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      evaluations: {
        ruleset: string;
        ruleset_id: string;
        ref: string;
        via: string;
        actor_id: string;
        violations: { rule: string }[];
      }[];
    };
    expect(body.evaluations).toHaveLength(1);
    expect(body.evaluations[0]).toMatchObject({
      ruleset: 'Trial',
      ruleset_id: ruleset.id,
      ref: 'main',
      via: 'api',
      actor_id: owner.userId,
    });
    expect(body.evaluations[0]!.violations.map((v) => v.rule)).toEqual([
      'non_fast_forward',
      'update',
    ]);
  });

  it('applies an org ruleset to every org repo its repository name condition matches', async () => {
    expect((await api('/orgs', 'POST', { slug: 'yuma' })).status).toBe(201);
    const org = (
      await q<{ id: string }>(dbEnv, "SELECT id FROM orgs WHERE slug = 'yuma'")
    )[0]!;
    const repos: Record<string, string> = {};
    for (const name of ['app-one', 'app-two', 'docs']) {
      const r = await createRepo(dbEnv, {
        slug: `yuma/${name}`,
        createdBy: owner.userId,
        ownerKind: 'org',
        ownerId: org.id,
      });
      repos[name] = r.id;
      await setRef(dbEnv, r.id, 'main', await cs(r.id, null, 'a.txt'));
    }
    await addRuleset(
      {
        name: 'Apps through pull requests',
        target: 'branch',
        conditions: {
          ref_name: { include: ['~DEFAULT_BRANCH'] },
          repository_name: { include: ['app-*'] },
        },
        rules: [{ type: 'update' }],
      },
      '/orgs/yuma',
    );
    for (const [name, id] of Object.entries(repos)) {
      const head = (await getRef(dbEnv, id, 'main'))!.head;
      const res = await api(`/repos/yuma/${name}/refs/main`, 'PUT', {
        from: head,
        to: await cs(id, head, 'b.txt'),
      });
      expect(res.status, name).toBe(name === 'docs' ? 200 : 403);
      if (name !== 'docs')
        expect((await errorOf(res)).message).toBe(
          'ruleset "Apps through pull requests": open a pull request to update main',
        );
    }
    const listed = (await (await api('/repos/yuma/app-one/rulesets')).json()) as {
      inherited: Ruleset[];
    };
    expect(listed.inherited.map((r) => r.name)).toEqual(['Apps through pull requests']);
    const docs = (await (await api('/repos/yuma/docs/rulesets')).json()) as {
      inherited: Ruleset[];
    };
    expect(docs.inherited).toEqual([]);
  });

  it('lets a bypass actor merge with a reason recorded in the audit log', async () => {
    await addRuleset({
      name: 'Two reviews',
      target: 'branch',
      conditions: { ref_name: { include: ['~DEFAULT_BRANCH'] } },
      rules: [{ type: 'pull_request', required_approvals: 2 }],
      bypass: ['role:admin'],
    });
    const head = await cs(repoId, base, 'change.txt');
    const opened = await api(
      '/repos/team/app/pulls',
      'POST',
      { title: 'Change', head_cs: head },
      writer,
    );
    expect(opened.status).toBe(201);
    const pull = ((await opened.json()) as { pull: Pull }).pull;
    const merge = { head_cs: head, revision: 1, bypass_reason: 'incident 42 hotfix' };
    const refused = await api(
      `/repos/team/app/pulls/${pull.id}/merge`,
      'POST',
      merge,
      writer,
    );
    expect(refused.status).toBe(409);
    expect((await errorOf(refused)).message).toBe(
      '2 approvals required for this revision.',
    );
    expect(
      (await api(`/repos/team/app/pulls/${pull.id}/merge`, 'POST', merge)).status,
    ).toBe(200);
    expect((await getRef(dbEnv, repoId, 'main'))?.head).toBe(head);
    const events = await q<{ actor_id: string; target: string }>(
      dbEnv,
      "SELECT actor_id, target FROM audit_events WHERE action = 'ruleset.bypass'",
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.actor_id).toBe(owner.userId);
    expect(JSON.parse(events[0]!.target)).toMatchObject({
      ref: 'main',
      via: 'merge',
      reason: 'incident 42 hotfix',
      violations: [{ ruleset: 'Two reviews', rule: 'pull_request' }],
    });
  });

  it('enforces push rules on git push and on the commit RPC', async () => {
    await addRuleset({
      name: 'Small files',
      target: 'push',
      rules: [
        { type: 'max_file_size', max_bytes: 1024 },
        { type: 'file_path_restriction', paths: ['secrets/**'] },
        { type: 'file_extension_restriction', extensions: ['.exe'] },
      ],
    });
    const commitRpc = (path: string, bytes: number): Promise<Response> =>
      api('/repos/team/app/changesets', 'POST', {
        first_parent: base,
        message: 'add',
        author,
        changes: [{ path, op: 'add', content_b64: btoa('z'.repeat(bytes)) }],
      });
    const big = await commitRpc('big.bin', 2048);
    expect(big.status).toBe(403);
    expect(await errorOf(big)).toMatchObject({
      code: 'ruleset_violation',
      message: 'ruleset "Small files": big.bin is 2048 bytes; the limit is 1024',
    });
    expect((await commitRpc('secrets/key.txt', 10)).status).toBe(403);
    expect((await commitRpc('tool.EXE', 10)).status).toBe(403);
    expect((await commitRpc('small.bin', 512)).status).toBe(201);

    await createRepo(dbEnv, { slug: 'team/push', createdBy: owner.userId });
    await addRuleset(
      {
        name: 'Small files',
        target: 'push',
        rules: [{ type: 'max_file_size', max_bytes: 1024 }],
      },
      '/repos/team/push',
    );
    const large = await gitTree({ 'big.bin': new Uint8Array(2048) });
    const report = await gitPush(
      'team/push',
      pushBody([[ZERO, large.sha, 'refs/heads/main']], await packOf(large.objects)),
    );
    expect(report.refs['refs/heads/main']).toBe(
      'ruleset "Small files" max_file_size: big.bin is 2048 bytes; the limit is 1024',
    );
  });
});

describe('administration', () => {
  it('audits every change and keeps the API contract', async () => {
    const body = {
      name: 'Protect releases',
      target: 'branch',
      conditions: { ref_name: { include: ['release/*'] } },
      rules: [{ type: 'deletion' }],
    };
    expect((await api('/repos/team/app/rulesets', 'POST', body, writer)).status).toBe(
      403,
    );
    const stranger = await loginAs(testEnv, 803, 'stranger');
    expect(
      (await api('/repos/team/app/rulesets', 'GET', undefined, stranger)).status,
    ).toBe(404);
    // tags are never merged, so a tag ruleset cannot ask for reviews
    const tagReviews = await api('/repos/team/app/rulesets', 'POST', {
      ...body,
      target: 'tag',
      rules: [{ type: 'pull_request', required_approvals: 1 }],
    });
    expect(tagReviews.status).toBe(400);
    expect((await errorOf(tagReviews)).code).toBe('invalid_ruleset');
    const created = await addRuleset(body);
    expect((await api('/repos/team/app/rulesets', 'POST', body)).status).toBe(409);
    const updated = await api(`/repos/team/app/rulesets/${created.id}`, 'PUT', {
      ...body,
      enforcement: 'disabled',
    });
    expect(updated.status).toBe(200);
    expect((await api(`/repos/team/app/rulesets/${created.id}`, 'DELETE')).status).toBe(
      200,
    );
    const events = await q<{ action: string; target: string }>(
      dbEnv,
      "SELECT action, target FROM audit_events WHERE action LIKE 'ruleset.%' ORDER BY id",
    );
    expect(events.map((e) => e.action)).toEqual([
      'ruleset.create',
      'ruleset.update',
      'ruleset.delete',
    ]);
    expect(JSON.parse(events[1]!.target)).toMatchObject({
      enforcement: 'disabled',
      previous: { enforcement: 'active' },
    });
  });

  it('maps CI policy protection fields to the same ruleset in the migration and PUT /ci', async () => {
    const other = (
      await createRepo(dbEnv, { slug: 'team/other', createdBy: owner.userId })
    ).id;
    const configs: [string, Record<string, unknown>][] = [
      [
        repoId,
        {
          commands: ['npm test'],
          protect_default: true,
          required_approvals: 2,
          require_checks: false,
        },
      ],
      [
        other,
        {
          commands: ['npm test'],
          protect_default: false,
          required_approvals: 0,
          require_checks: true,
        },
      ],
    ];
    for (const [id, config] of configs) {
      await run(
        dbEnv,
        'INSERT INTO ci_settings (repo_id, version, config, updated_at) VALUES (?, 1, ?, 1)',
        [id, JSON.stringify(config)],
      );
    }
    const migration = testEnv.TEST_MIGRATIONS.find((m) => m.name.startsWith('0016'))!;
    await testEnv.DB.prepare(migration.queries.at(-1)!).run();
    const migrated = async (id: string): Promise<unknown> =>
      JSON.parse(
        (
          await q<{ rules: string }>(
            dbEnv,
            'SELECT rules FROM rulesets WHERE owner_id = ?',
            [id],
          )
        )[0]!.rules,
      );
    expect(await migrated(repoId)).toEqual([
      { type: 'update' },
      { type: 'pull_request', required_approvals: 2 },
    ]);
    expect(await migrated(other)).toEqual([
      { type: 'pull_request', required_approvals: 0 },
      { type: 'required_status_checks' },
    ]);

    // PUT /ci rewrites the same ruleset rather than adding another
    expect(
      (
        await api('/repos/team/app/ci', 'PUT', {
          commands: ['npm test'],
          protect_default: false,
          required_approvals: 1,
        })
      ).status,
    ).toBe(200);
    const listed = (await (await api('/repos/team/app/rulesets')).json()) as {
      rulesets: Ruleset[];
    };
    expect(listed.rulesets).toHaveLength(1);
    expect(listed.rulesets[0]).toMatchObject({
      name: 'CI policy (default branch)',
      conditions: { ref_name: { include: ['~DEFAULT_BRANCH'] } },
      rules: [
        { type: 'pull_request', required_approvals: 1 },
        { type: 'required_status_checks' },
      ],
    });
  });
});
