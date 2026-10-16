import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { cleanDb, loginAs, makeApp, seedSchema } from './helpers';
import type { TestEnv } from './helpers';
import { can } from '../src/auth/rbac';
import { getRepoBySlug } from '../src/db/repos';

const testEnv = env as unknown as TestEnv;
const dbEnv = testEnv as unknown as Env;

type Login = Awaited<ReturnType<typeof loginAs>>;

async function call(
  who: Login | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = { ...(who?.headers ?? {}) };
  if (body !== undefined) headers['content-type'] = 'application/json';
  return makeApp(testEnv)(
    new Request(`https://x${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

async function expectStatus(res: Promise<Response>, status: number): Promise<unknown> {
  const r = await res;
  const body: unknown = await r.json();
  expect(r.status, JSON.stringify(body)).toBe(status);
  return body;
}

function commitBody(path: string): unknown {
  return {
    first_parent: null,
    message: `add ${path}`,
    author: { name: 'a', email: 'a@b.c' },
    changes: [{ path, op: 'add', content_b64: btoa(path) }],
  };
}

// Runs first in this file, on a database that has not seen 0012 yet.
describe('migration 0012 on a pre-org fixture database', () => {
  it('backfills owners and keeps user-owned repos working unchanged', async () => {
    const pre = testEnv.TEST_MIGRATIONS.filter((m) => m.name < '0012');
    expect(pre.length).toBeLessThan(testEnv.TEST_MIGRATIONS.length);
    await applyD1Migrations(testEnv.DB, pre);
    const applied = await testEnv.DB.prepare('SELECT name FROM d1_migrations').all<{
      name: string;
    }>();
    expect(applied.results.some((r) => r.name.startsWith('0012'))).toBe(false);

    const ada = await loginAs(testEnv, 1, 'ada');
    const bob = await loginAs(testEnv, 2, 'bob');
    const eve = await loginAs(testEnv, 3, 'eve');
    // legacy rows written with the pre-org column set
    await testEnv.DB.prepare(
      `INSERT INTO repos (id, slug, default_branch, created_at, visibility, created_by)
       VALUES ('legacy1', 'acme/legacy', 'main', 1, 'private', ?)`,
    )
      .bind(ada.userId)
      .run();
    await testEnv.DB.prepare(
      `INSERT INTO repo_members (repo_id, user_id, role) VALUES ('legacy1', ?, 'write')`,
    )
      .bind(bob.userId)
      .run();

    await seedSchema(testEnv); // applies 0012 on top

    const repo = await getRepoBySlug(dbEnv, 'acme/legacy');
    expect(repo).toMatchObject({ owner_kind: 'user', owner_id: 'acme' });
    await expectStatus(
      call(bob, 'POST', '/api/v1/repos/acme/legacy/changesets', commitBody('a.txt')),
      201,
    );
    await expectStatus(call(ada, 'GET', '/api/v1/repos/acme/legacy'), 200);
    await expectStatus(call(eve, 'GET', '/api/v1/repos/acme/legacy'), 404);
    await expectStatus(call(null, 'GET', '/api/v1/repos/acme/legacy'), 401);
  });
});

describe('organisations, teams and org-level roles', () => {
  let owner: Login;
  let member: Login;
  let outsider: Login;

  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
    owner = await loginAs(testEnv, 1, 'olive');
    member = await loginAs(testEnv, 2, 'max');
    outsider = await loginAs(testEnv, 3, 'otto');
  });

  async function setupOrg(baseRole: 'none' | 'read' = 'none'): Promise<void> {
    await expectStatus(
      call(owner, 'POST', '/api/v1/orgs', { slug: 'yuma', base_role: baseRole }),
      201,
    );
    await expectStatus(
      call(owner, 'PUT', '/api/v1/orgs/yuma/members', {
        user_login: 'max',
        role: 'member',
      }),
      200,
    );
    await expectStatus(
      call(owner, 'POST', '/api/v1/repos', { slug: 'yuma/core', org: 'yuma' }),
      201,
    );
  }

  it('owner creates org, member, team and grant; the member can commit', async () => {
    await setupOrg();
    await expectStatus(
      call(owner, 'POST', '/api/v1/orgs/yuma/teams', { slug: 'platform' }),
      201,
    );
    await expectStatus(
      call(owner, 'PUT', '/api/v1/orgs/yuma/teams/platform/repos', {
        repo: 'yuma/core',
        role: 'write',
      }),
      200,
    );
    // org member without a team grant and base role none: repo is invisible
    await expectStatus(
      call(member, 'POST', '/api/v1/repos/yuma/core/changesets', commitBody('a.txt')),
      404,
    );
    await expectStatus(
      call(owner, 'PUT', '/api/v1/orgs/yuma/teams/platform/members', {
        user_login: 'max',
      }),
      200,
    );
    await expectStatus(
      call(member, 'POST', '/api/v1/repos/yuma/core/changesets', commitBody('a.txt')),
      201,
    );
    const team = (await expectStatus(
      call(member, 'GET', '/api/v1/orgs/yuma/teams/platform'),
      200,
    )) as { members: { login: string }[]; repos: { repo: string; role: string }[] };
    expect(team.members.map((m) => m.login)).toEqual(['max']);
    expect(team.repos).toEqual([{ repo: 'yuma/core', role: 'write' }]);
    // the repo index lists team-granted org repos
    const list = (await expectStatus(call(member, 'GET', '/api/v1/repos'), 200)) as {
      repos: { slug: string }[];
    };
    expect(list.repos.map((r) => r.slug)).toEqual(['yuma/core']);
  });

  it('removing the member from the team revokes write on the next request', async () => {
    await setupOrg('read');
    await call(owner, 'POST', '/api/v1/orgs/yuma/teams', { slug: 'platform' });
    await call(owner, 'PUT', '/api/v1/orgs/yuma/teams/platform/repos', {
      repo: 'yuma/core',
      role: 'write',
    });
    await call(owner, 'PUT', '/api/v1/orgs/yuma/teams/platform/members', {
      user_login: 'max',
    });
    await expectStatus(
      call(member, 'POST', '/api/v1/repos/yuma/core/changesets', commitBody('a.txt')),
      201,
    );
    await expectStatus(
      call(owner, 'DELETE', `/api/v1/orgs/yuma/teams/platform/members/${member.userId}`),
      200,
    );
    // base role read still shows the repo, so the denial is a 403 not a 404
    await expectStatus(
      call(member, 'POST', '/api/v1/repos/yuma/core/changesets', commitBody('b.txt')),
      403,
    );
    await expectStatus(call(member, 'GET', '/api/v1/repos/yuma/core'), 200);
  });

  it('removing an org member also removes their team memberships', async () => {
    await setupOrg();
    await call(owner, 'POST', '/api/v1/orgs/yuma/teams', { slug: 'platform' });
    await call(owner, 'PUT', '/api/v1/orgs/yuma/teams/platform/repos', {
      repo: 'yuma/core',
      role: 'write',
    });
    await call(owner, 'PUT', '/api/v1/orgs/yuma/teams/platform/members', {
      user_login: 'max',
    });
    await expectStatus(call(member, 'GET', '/api/v1/repos/yuma/core'), 200);
    await expectStatus(
      call(owner, 'DELETE', `/api/v1/orgs/yuma/members/${member.userId}`),
      200,
    );
    await expectStatus(call(member, 'GET', '/api/v1/repos/yuma/core'), 404);
    await expectStatus(call(member, 'GET', '/api/v1/orgs/yuma'), 404);
    // re-joining the org does not restore the old team seat
    await call(owner, 'PUT', '/api/v1/orgs/yuma/members', {
      user_login: 'max',
      role: 'member',
    });
    await expectStatus(call(member, 'GET', '/api/v1/repos/yuma/core'), 404);
  });

  it('nested teams inherit parent grants two levels deep', async () => {
    await setupOrg();
    await call(owner, 'POST', '/api/v1/orgs/yuma/teams', { slug: 'eng' });
    await expectStatus(
      call(owner, 'POST', '/api/v1/orgs/yuma/teams', { slug: 'backend', parent: 'eng' }),
      201,
    );
    await expectStatus(
      call(owner, 'POST', '/api/v1/orgs/yuma/teams', { slug: 'db', parent: 'backend' }),
      201,
    );
    await call(owner, 'PUT', '/api/v1/orgs/yuma/teams/eng/repos', {
      repo: 'yuma/core',
      role: 'write',
    });
    await call(owner, 'PUT', '/api/v1/orgs/yuma/teams/db/members', { user_login: 'max' });
    await expectStatus(
      call(member, 'POST', '/api/v1/repos/yuma/core/changesets', commitBody('a.txt')),
      201,
    );
    const teams = (await expectStatus(
      call(member, 'GET', '/api/v1/orgs/yuma/teams'),
      200,
    )) as { teams: { slug: string; parent: string | null }[] };
    expect(teams.teams.map((t) => [t.slug, t.parent])).toEqual([
      ['backend', 'eng'],
      ['db', 'backend'],
      ['eng', null],
    ]);
  });

  it('team nesting is capped at five levels', async () => {
    await setupOrg();
    let parent: string | undefined;
    for (const slug of ['t0', 't1', 't2', 't3', 't4', 't5']) {
      await expectStatus(
        call(owner, 'POST', '/api/v1/orgs/yuma/teams', { slug, parent }),
        201,
      );
      parent = slug;
    }
    const body = (await expectStatus(
      call(owner, 'POST', '/api/v1/orgs/yuma/teams', { slug: 't6', parent: 't5' }),
      400,
    )) as { error: { code: string } };
    expect(body.error.code).toBe('team_too_deep');
    // the deepest allowed team still reaches the top-level grant
    await call(owner, 'PUT', '/api/v1/orgs/yuma/teams/t0/repos', {
      repo: 'yuma/core',
      role: 'read',
    });
    await call(owner, 'PUT', '/api/v1/orgs/yuma/teams/t5/members', { user_login: 'max' });
    await expectStatus(call(member, 'GET', '/api/v1/repos/yuma/core'), 200);
  });

  it('base role read gives members read on private org repos; none gives nothing', async () => {
    await setupOrg('none');
    await expectStatus(call(member, 'GET', '/api/v1/repos/yuma/core'), 404);
    const list = (await expectStatus(
      call(member, 'GET', '/api/v1/orgs/yuma/repos'),
      200,
    )) as { repos: unknown[] };
    expect(list.repos).toEqual([]);

    await expectStatus(
      call(owner, 'PATCH', '/api/v1/orgs/yuma', { base_role: 'read' }),
      200,
    );
    await expectStatus(call(member, 'GET', '/api/v1/repos/yuma/core'), 200);
    await expectStatus(
      call(member, 'POST', '/api/v1/repos/yuma/core/changesets', commitBody('a.txt')),
      403,
    );
    const visible = (await expectStatus(
      call(member, 'GET', '/api/v1/orgs/yuma/repos'),
      200,
    )) as { repos: { slug: string }[] };
    expect(visible.repos.map((r) => r.slug)).toEqual(['yuma/core']);
    // outsiders and billing managers get nothing
    await expectStatus(call(outsider, 'GET', '/api/v1/repos/yuma/core'), 404);
    await call(owner, 'PUT', '/api/v1/orgs/yuma/members', {
      user_login: 'otto',
      role: 'billing',
    });
    await expectStatus(call(outsider, 'GET', '/api/v1/repos/yuma/core'), 404);
  });

  it('path rule denies still win over a team grant', async () => {
    await setupOrg();
    await call(owner, 'POST', '/api/v1/orgs/yuma/teams', { slug: 'platform' });
    await call(owner, 'PUT', '/api/v1/orgs/yuma/teams/platform/repos', {
      repo: 'yuma/core',
      role: 'admin',
    });
    await call(owner, 'PUT', '/api/v1/orgs/yuma/teams/platform/members', {
      user_login: 'max',
    });
    await expectStatus(
      call(owner, 'POST', '/api/v1/repos/yuma/core/path-rules', {
        path_prefix: 'secrets',
        effect: 'deny',
        principal: 'role:admin',
        perms: ['read', 'write', 'history'],
      }),
      201,
    );
    const denied = (await expectStatus(
      call(
        member,
        'GET',
        '/api/v1/repos/yuma/core/file?cs=aaaaaaaa&path=secrets/key.txt',
      ),
      403,
    )) as { error: { denied_by: { path_prefix: string } } };
    expect(denied.error.denied_by.path_prefix).toBe('secrets/');
    const repo = await getRepoBySlug(dbEnv, 'yuma/core');
    if (!repo) throw new Error('repo missing');
    const p = { kind: 'user' as const, userId: member.userId };
    expect(await can(dbEnv, repo, p, 'write', 'secrets/key.txt')).toBe(false);
    expect(await can(dbEnv, repo, p, 'write', 'src/main.ts')).toBe(true);
  });

  it('org owners are admins on every org repo, without being the creator', async () => {
    await setupOrg();
    await call(owner, 'PUT', '/api/v1/orgs/yuma/members', {
      user_login: 'otto',
      role: 'owner',
    });
    const body = (await expectStatus(
      call(outsider, 'GET', '/api/v1/repos/yuma/core'),
      200,
    )) as { can_admin: boolean };
    expect(body.can_admin).toBe(true);
  });

  it('only owners, admins and allowed members create org repos', async () => {
    await setupOrg();
    await expectStatus(
      call(member, 'POST', '/api/v1/repos', { slug: 'yuma/mine', org: 'yuma' }),
      403,
    );
    // the slug prefix alone makes it an org repo
    await expectStatus(call(member, 'POST', '/api/v1/repos', { slug: 'yuma/mine' }), 403);
    await expectStatus(
      call(outsider, 'POST', '/api/v1/repos', { slug: 'yuma/mine' }),
      404,
    );
    await expectStatus(
      call(owner, 'POST', '/api/v1/repos', { slug: 'other/x', org: 'yuma' }),
      400,
    );
    // a differently cased prefix cannot sidestep the org
    await expectStatus(
      call(outsider, 'POST', '/api/v1/repos', { slug: 'Yuma/mine' }),
      400,
    );
    await call(owner, 'PATCH', '/api/v1/orgs/yuma', { members_can_create_repos: true });
    const created = (await expectStatus(
      call(member, 'POST', '/api/v1/repos', { slug: 'yuma/mine' }),
      201,
    )) as { repo: { owner_kind: string } };
    expect(created.repo.owner_kind).toBe('org');
    // user-owned repos still need no org
    await expectStatus(call(outsider, 'POST', '/api/v1/repos', { slug: 'otto/x' }), 201);
  });

  it('enforces org roles, owner rules and the error contract', async () => {
    await setupOrg();
    await expectStatus(call(null, 'GET', '/api/v1/orgs/yuma'), 401);
    await expectStatus(call(outsider, 'GET', '/api/v1/orgs/yuma'), 404);
    await expectStatus(call(owner, 'POST', '/api/v1/orgs', { slug: 'yuma' }), 409);
    await expectStatus(call(owner, 'POST', '/api/v1/orgs', { slug: 'Bad--Slug' }), 400);
    await expectStatus(
      call(owner, 'POST', '/api/v1/orgs', { slug: 'a'.repeat(40) }),
      400,
    );
    // plain members cannot manage
    await expectStatus(
      call(member, 'POST', '/api/v1/orgs/yuma/teams', { slug: 'x' }),
      403,
    );
    await expectStatus(
      call(member, 'PATCH', '/api/v1/orgs/yuma', { base_role: 'admin' }),
      403,
    );
    // org admins manage members but cannot touch owners
    await call(owner, 'PUT', '/api/v1/orgs/yuma/members', {
      user_login: 'max',
      role: 'admin',
    });
    await expectStatus(
      call(member, 'PUT', '/api/v1/orgs/yuma/members', {
        user_login: 'otto',
        role: 'owner',
      }),
      403,
    );
    await expectStatus(
      call(member, 'DELETE', `/api/v1/orgs/yuma/members/${owner.userId}`),
      403,
    );
    await expectStatus(
      call(member, 'PUT', '/api/v1/orgs/yuma/members', {
        user_login: 'otto',
        role: 'member',
      }),
      200,
    );
    // the last owner stays
    await expectStatus(
      call(owner, 'DELETE', `/api/v1/orgs/yuma/members/${owner.userId}`),
      409,
    );
    await expectStatus(
      call(owner, 'PUT', '/api/v1/orgs/yuma/members', {
        user_login: 'olive',
        role: 'member',
      }),
      409,
    );
    // team members must be org members; grants stay inside the org
    await call(owner, 'POST', '/api/v1/orgs/yuma/teams', { slug: 'platform' });
    const stranger = await loginAs(testEnv, 9, 'stranger');
    await expectStatus(
      call(owner, 'PUT', '/api/v1/orgs/yuma/teams/platform/members', {
        user_id: stranger.userId,
      }),
      400,
    );
    await expectStatus(call(owner, 'POST', '/api/v1/repos', { slug: 'olive/own' }), 201);
    await expectStatus(
      call(owner, 'PUT', '/api/v1/orgs/yuma/teams/platform/repos', {
        repo: 'olive/own',
        role: 'read',
      }),
      404,
    );
    const mine = (await expectStatus(call(member, 'GET', '/api/v1/orgs'), 200)) as {
      orgs: { slug: string; role: string }[];
    };
    expect(mine.orgs.map((o) => [o.slug, o.role])).toEqual([['yuma', 'admin']]);
  });
});
