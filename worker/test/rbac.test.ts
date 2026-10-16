import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { cleanDb, loginAs, makeApp, seedSchema } from './helpers';
import type { TestEnv } from './helpers';
import { C, T } from '../src/db/schema';
import { q1, run } from '../src/db/client';
import { createRepo } from '../src/db/repos';
import { can, parsePathRuleInput } from '../src/auth/rbac';
import type { Principal } from '../src/auth/principal';
import { commitChanges } from '../src/core/commit';

const testEnv = env as unknown as TestEnv;
const dbEnv = testEnv as unknown as Env;
const author = { name: 'Ada', email: 'ada@example.com' };

let user: { userId: string; cookie: string; headers: Record<string, string> };
let stranger: { userId: string; cookie: string; headers: Record<string, string> };

async function addMember(
  repoId: string,
  userId: string,
  role: 'admin' | 'write' | 'read',
): Promise<void> {
  await run(
    dbEnv,
    `INSERT INTO ${T.repoMembers} (${C.repoMembers.repoId}, ${C.repoMembers.userId}, ${C.repoMembers.role}) VALUES (?, ?, ?)
     ON CONFLICT (${C.repoMembers.repoId}, ${C.repoMembers.userId}) DO UPDATE SET role = excluded.role`,
    [repoId, userId, role],
  );
}

async function addRuleFor(repoId: string, input: unknown): Promise<void> {
  const rule = parsePathRuleInput(input);
  await run(
    dbEnv,
    `INSERT INTO ${T.pathRules} (${C.pathRules.repoId}, ${C.pathRules.pathPrefix}, ${C.pathRules.effect}, ${C.pathRules.principal}, ${C.pathRules.perms}) VALUES (?, ?, ?, ?, ?)`,
    [repoId, rule.path_prefix, rule.effect, rule.principal, JSON.stringify(rule.perms)],
  );
}

function principalOf(userId: string): Principal {
  return { kind: 'user', userId };
}

describe('can() resolution matrix', () => {
  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
    user = await loginAs(testEnv, 1, 'ada');
    stranger = await loginAs(testEnv, 2, 'mallory');
  });

  it('anonymous: read on public only, never write; private invisible', async () => {
    const pub = await createRepo(dbEnv, { slug: 'acme/pub', visibility: 'public' });
    const priv = await createRepo(dbEnv, { slug: 'acme/priv', visibility: 'private' });

    expect(await can(dbEnv, pub, null, 'read')).toBe(true);
    expect(await can(dbEnv, pub, null, 'write')).toBe(false);
    expect(await can(dbEnv, pub, null, 'history')).toBe(false);
    expect(await can(dbEnv, priv, null, 'read')).toBe(false);
    expect(await can(dbEnv, priv, null, 'write')).toBe(false);
  });

  it('anonymous read is blocked by a deny rule even on public repos', async () => {
    const pub = await createRepo(dbEnv, { slug: 'acme/pub2', visibility: 'public' });
    await addRuleFor(pub.id, {
      path_prefix: 'internal/',
      effect: 'deny',
      principal: '*',
      perms: ['read'],
    });
    expect(await can(dbEnv, pub, null, 'read', 'internal/secret.txt')).toBe(false);
    expect(await can(dbEnv, pub, null, 'read', 'open.txt')).toBe(true);
  });

  it('member roles: admin everything, write minus admin, read = read+history', async () => {
    const repo = await createRepo(dbEnv, { slug: 'acme/roles', visibility: 'private' });
    const admin = principalOf(user.userId);
    const writer = principalOf(stranger.userId);
    await addMember(repo.id, user.userId, 'admin');
    await addMember(repo.id, stranger.userId, 'write');

    for (const perm of ['read', 'write', 'history', 'admin'] as const) {
      expect(await can(dbEnv, repo, admin, perm)).toBe(true);
    }
    expect(await can(dbEnv, repo, writer, 'read')).toBe(true);
    expect(await can(dbEnv, repo, writer, 'write')).toBe(true);
    expect(await can(dbEnv, repo, writer, 'history')).toBe(true);
    expect(await can(dbEnv, repo, writer, 'admin')).toBe(false);

    // read role
    const readerLogin = await loginAs(testEnv, 3, 'reader');
    await addMember(repo.id, readerLogin.userId, 'read');
    const reader = principalOf(readerLogin.userId);
    expect(await can(dbEnv, repo, reader, 'read')).toBe(true);
    expect(await can(dbEnv, repo, reader, 'history')).toBe(true);
    expect(await can(dbEnv, repo, reader, 'write')).toBe(false);
    expect(await can(dbEnv, repo, reader, 'admin')).toBe(false);

    // non-member: nothing on a private repo
    const nobody = await loginAs(testEnv, 4, 'nobody');
    expect(await can(dbEnv, repo, principalOf(nobody.userId), 'read')).toBe(false);
  });

  it('signed-in non-members can read public repos', async () => {
    const pub = await createRepo(dbEnv, { slug: 'acme/world', visibility: 'public' });
    const reader = principalOf(stranger.userId);
    expect(await can(dbEnv, pub, reader, 'read')).toBe(true);
    expect(await can(dbEnv, pub, reader, 'history')).toBe(true);
    expect(await can(dbEnv, pub, reader, 'write')).toBe(false);
    expect(await can(dbEnv, pub, reader, 'admin')).toBe(false);
  });

  it('repo creators are admins', async () => {
    const repo = await createRepo(dbEnv, {
      slug: 'acme/created',
      visibility: 'private',
      createdBy: user.userId,
    });
    expect(await can(dbEnv, repo, principalOf(user.userId), 'admin')).toBe(true);
    expect(await can(dbEnv, repo, principalOf(stranger.userId), 'read')).toBe(false);
  });
});

describe('path rules (monorepo security)', () => {
  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
    user = await loginAs(testEnv, 1, 'ada');
    stranger = await loginAs(testEnv, 2, 'mallory');
  });

  it('longest prefix wins; deny blocks exactly its subtree', async () => {
    const repo = await createRepo(dbEnv, { slug: 'acme/mono', visibility: 'private' });
    await addMember(repo.id, user.userId, 'read');
    const p = principalOf(user.userId);

    await addRuleFor(repo.id, {
      path_prefix: 'src/secret/',
      effect: 'deny',
      principal: '*',
      perms: ['read', 'write', 'history'],
    });
    expect(await can(dbEnv, repo, p, 'read', 'src/secret/key.pem')).toBe(false);
    expect(await can(dbEnv, repo, p, 'read', 'src/app.ts')).toBe(true);

    // longer grant prefix beats the shorter deny
    await addRuleFor(repo.id, {
      path_prefix: 'src/secret/allowed/',
      effect: 'grant',
      principal: `user:${user.userId}`,
      perms: ['read'],
    });
    expect(await can(dbEnv, repo, p, 'read', 'src/secret/allowed/ok.txt')).toBe(true);
    expect(await can(dbEnv, repo, p, 'read', 'src/secret/key.pem')).toBe(false);
  });

  it('agent: grants never take an agent past its human, and token rules need no agent:run', async () => {
    const repo = await createRepo(dbEnv, { slug: 'acme/rel', visibility: 'private' });
    await addMember(repo.id, user.userId, 'read');
    await addRuleFor(repo.id, {
      path_prefix: 'secrets/',
      effect: 'deny',
      principal: '*',
      perms: ['read'],
    });
    await addRuleFor(repo.id, {
      path_prefix: 'secrets/',
      effect: 'grant',
      principal: 'agent:agt_REL',
      perms: ['read'],
    });
    const agent: Principal = {
      kind: 'agent',
      userId: user.userId,
      agentId: 'agt_REL',
      jti: 'j',
      taskId: null,
      scopes: ['contents:read'],
      repoIds: [repo.id],
    };
    // the human is denied secrets/, so the agent acting for them is too
    expect(await can(dbEnv, repo, agent, 'read', 'secrets/key.pem')).toBe(false);
    expect(await can(dbEnv, repo, agent, 'read', 'src/app.ts')).toBe(true);
    await addRuleFor(repo.id, {
      path_prefix: 'secrets/',
      effect: 'grant',
      principal: `user:${user.userId}`,
      perms: ['read'],
    });
    expect(await can(dbEnv, repo, agent, 'read', 'secrets/key.pem')).toBe(true);

    // a rule naming an API token applies whether or not it has agent:run
    await addRuleFor(repo.id, {
      path_prefix: 'ci/',
      effect: 'deny',
      principal: 'agent:tok_ci',
      perms: ['read'],
    });
    const token: Principal = {
      kind: 'token',
      userId: user.userId,
      tokenId: 'tok_ci',
      scopes: ['repo:read'],
      repoId: null,
    };
    expect(await can(dbEnv, repo, token, 'read', 'ci/deploy.sh')).toBe(false);
    expect(await can(dbEnv, repo, token, 'read', 'src/app.ts')).toBe(true);
  });

  it('user-specific beats role-based beats *; deny wins ties', async () => {
    const repo = await createRepo(dbEnv, {
      slug: 'acme/specific',
      visibility: 'private',
    });
    await addMember(repo.id, user.userId, 'read');
    await addMember(repo.id, stranger.userId, 'read');
    const p = principalOf(user.userId);

    await addRuleFor(repo.id, {
      path_prefix: 'mix/',
      effect: 'deny',
      principal: '*',
      perms: ['read'],
    });
    await addRuleFor(repo.id, {
      path_prefix: 'mix/',
      effect: 'grant',
      principal: 'role:read',
      perms: ['read'],
    });
    await addRuleFor(repo.id, {
      path_prefix: 'mix/',
      effect: 'grant',
      principal: `user:${user.userId}`,
      perms: ['read'],
    });
    // user-specific grant wins for ada…
    expect(await can(dbEnv, repo, p, 'read', 'mix/f.txt')).toBe(true);
    // …while role-level beats * for mallory (same prefix, role before *)
    expect(
      await can(dbEnv, repo, principalOf(stranger.userId), 'read', 'mix/f.txt'),
    ).toBe(true);

    // deny/grant tie at the same specificity → deny wins
    const tie = await createRepo(dbEnv, { slug: 'acme/tie', visibility: 'private' });
    await addMember(tie.id, user.userId, 'read');
    await addRuleFor(tie.id, {
      path_prefix: 'x/',
      effect: 'grant',
      principal: '*',
      perms: ['read'],
    });
    await addRuleFor(tie.id, {
      path_prefix: 'x/',
      effect: 'deny',
      principal: '*',
      perms: ['read'],
    });
    expect(await can(dbEnv, tie, p, 'read', 'x/f')).toBe(false);
  });

  it('deny history + grant read → file RPC ok, blame 403', async () => {
    const repo = await createRepo(dbEnv, {
      slug: 'acme/secrethist',
      visibility: 'private',
    });
    await addMember(repo.id, user.userId, 'read');
    await addRuleFor(repo.id, {
      path_prefix: 'secrets/',
      effect: 'deny',
      principal: '*',
      perms: ['history'],
    });
    const p = principalOf(user.userId);

    expect(await can(dbEnv, repo, p, 'read', 'secrets/key.pem')).toBe(true);
    expect(await can(dbEnv, repo, p, 'history', 'secrets/key.pem')).toBe(false);
  });
});

describe('org and team roles (issue #26)', () => {
  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
    user = await loginAs(testEnv, 1, 'ada');
    stranger = await loginAs(testEnv, 2, 'mallory');
  });

  async function sql(text: string, params: unknown[]): Promise<void> {
    await run(dbEnv, text, params);
  }

  async function makeOrg(baseRole: 'none' | 'read' | 'write' | 'admin'): Promise<void> {
    await sql(
      `INSERT INTO orgs (id, slug, display_name, created_at, base_role) VALUES ('o1', 'acme', 'Acme', 1, ?)`,
      [baseRole],
    );
  }

  async function orgRepo(name: string) {
    return createRepo(dbEnv, {
      slug: `acme/${name}`,
      visibility: 'private',
      ownerKind: 'org',
      ownerId: 'o1',
    });
  }

  async function team(id: string, parent: string | null): Promise<void> {
    await sql(
      `INSERT INTO teams (id, org_id, slug, parent_team_id, created_at) VALUES (?, 'o1', ?, ?, 1)`,
      [id, id, parent],
    );
  }

  const perms = ['read', 'history', 'write', 'admin'] as const;
  async function permsOf(
    repo: Awaited<ReturnType<typeof orgRepo>>,
    userId: string,
  ): Promise<string[]> {
    const p = principalOf(userId);
    const out: string[] = [];
    for (const perm of perms) if (await can(dbEnv, repo, p, perm)) out.push(perm);
    return out;
  }

  it('effective role is the max of direct, team and org base roles', async () => {
    await makeOrg('read');
    const repo = await orgRepo('max');
    await sql(
      `INSERT INTO org_members (org_id, user_id, role) VALUES ('o1', ?, 'member')`,
      [user.userId],
    );
    // base read only
    expect(await permsOf(repo, user.userId)).toEqual(['read', 'history']);
    // direct write beats base read
    await addMember(repo.id, user.userId, 'write');
    expect(await permsOf(repo, user.userId)).toEqual(['read', 'history', 'write']);
    // team admin beats direct write
    await team('t1', null);
    await sql(`INSERT INTO team_members (team_id, user_id) VALUES ('t1', ?)`, [
      user.userId,
    ]);
    await sql(
      `INSERT INTO team_repos (team_id, repo_id, role) VALUES ('t1', ?, 'admin')`,
      [repo.id],
    );
    expect(await permsOf(repo, user.userId)).toEqual(perms.slice());
    // a lower team grant never lowers a higher direct role
    await sql(`UPDATE team_repos SET role = 'read'`, []);
    expect(await permsOf(repo, user.userId)).toEqual(['read', 'history', 'write']);
  });

  it('org role matrix: owner admin, admin/member base role, billing and outsiders nothing', async () => {
    await makeOrg('write');
    const repo = await orgRepo('roles');
    const expected: Record<string, string[]> = {
      owner: ['read', 'history', 'write', 'admin'],
      admin: ['read', 'history', 'write'],
      member: ['read', 'history', 'write'],
      billing: [],
    };
    let githubId = 10;
    for (const [role, want] of Object.entries(expected)) {
      const who = await loginAs(testEnv, githubId++, `u-${role}`);
      await sql(`INSERT INTO org_members (org_id, user_id, role) VALUES ('o1', ?, ?)`, [
        who.userId,
        role,
      ]);
      expect(await permsOf(repo, who.userId), role).toEqual(want);
    }
    expect(await permsOf(repo, stranger.userId)).toEqual([]);
  });

  it('team grants follow parent teams two levels up, never down', async () => {
    await makeOrg('none');
    const repo = await orgRepo('nested');
    await team('root', null);
    await team('mid', 'root');
    await team('leaf', 'mid');
    await sql(
      `INSERT INTO team_repos (team_id, repo_id, role) VALUES ('root', ?, 'write')`,
      [repo.id],
    );
    await sql(`INSERT INTO team_members (team_id, user_id) VALUES ('leaf', ?)`, [
      user.userId,
    ]);
    expect(await permsOf(repo, user.userId)).toEqual(['read', 'history', 'write']);
    // a grant on the child team does not flow up to parent members
    await sql(`DELETE FROM team_repos`, []);
    await sql(
      `INSERT INTO team_repos (team_id, repo_id, role) VALUES ('leaf', ?, 'write')`,
      [repo.id],
    );
    await sql(`INSERT INTO team_members (team_id, user_id) VALUES ('root', ?)`, [
      stranger.userId,
    ]);
    expect(await permsOf(repo, stranger.userId)).toEqual([]);
  });

  it('org roles never reach user-owned repos that share the prefix', async () => {
    await makeOrg('admin');
    await sql(
      `INSERT INTO org_members (org_id, user_id, role) VALUES ('o1', ?, 'owner')`,
      [stranger.userId],
    );
    const legacy = await createRepo(dbEnv, {
      slug: 'acme/legacy',
      visibility: 'private',
    });
    expect(legacy.owner_kind).toBe('user');
    expect(await permsOf(legacy, stranger.userId)).toEqual([]);
  });

  it('role-based path rules match the effective (team) role; deny wins', async () => {
    await makeOrg('none');
    const repo = await orgRepo('paths');
    await team('t1', null);
    await sql(`INSERT INTO team_members (team_id, user_id) VALUES ('t1', ?)`, [
      user.userId,
    ]);
    await sql(
      `INSERT INTO team_repos (team_id, repo_id, role) VALUES ('t1', ?, 'write')`,
      [repo.id],
    );
    await addRuleFor(repo.id, {
      path_prefix: 'infra/',
      effect: 'deny',
      principal: 'role:write',
      perms: ['write'],
    });
    const p = principalOf(user.userId);
    expect(await can(dbEnv, repo, p, 'write', 'infra/main.tf')).toBe(false);
    expect(await can(dbEnv, repo, p, 'read', 'infra/main.tf')).toBe(true);
    expect(await can(dbEnv, repo, p, 'write', 'src/app.ts')).toBe(true);
  });
});

describe('admin CRUD', () => {
  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
    user = await loginAs(testEnv, 1, 'ada');
    stranger = await loginAs(testEnv, 2, 'mallory');
    await createRepo(dbEnv, {
      slug: 'acme/admin',
      visibility: 'private',
      createdBy: user.userId,
    });
  });

  it('manages members with role validation', async () => {
    const res = await app('PUT', '/api/v1/repos/acme/admin/members', user.headers, {
      user_id: stranger.userId,
      role: 'write',
    });
    expect(res.status).toBe(200);
    const row = await q1(
      dbEnv,
      `SELECT * FROM ${T.repoMembers} WHERE ${C.repoMembers.userId} = ?`,
      [stranger.userId],
    );
    expect(row).toMatchObject({ role: 'write' });

    const list = await app('GET', '/api/v1/repos/acme/admin/members', user.headers);
    expect(((await list.json()) as { members: unknown[] }).members).toHaveLength(1);

    const badRole = await app('PUT', '/api/v1/repos/acme/admin/members', user.headers, {
      user_id: stranger.userId,
      role: 'superuser',
    });
    expect(badRole.status).toBe(400);

    const unknownUser = await app(
      'PUT',
      '/api/v1/repos/acme/admin/members',
      user.headers,
      {
        user_login: 'ghost',
        role: 'read',
      },
    );
    expect(unknownUser.status).toBe(404);

    const removed = await app(
      'DELETE',
      `/api/v1/repos/acme/admin/members/${stranger.userId}`,
      user.headers,
    );
    expect(removed.status).toBe(200);
  });

  it('manages path rules with validation', async () => {
    const created = await app(
      'POST',
      '/api/v1/repos/acme/admin/path-rules',
      user.headers,
      {
        path_prefix: 'secrets', // normalized to secrets/
        effect: 'deny',
        principal: '*',
        perms: ['history'],
      },
    );
    expect(created.status).toBe(201);
    const body = (await created.json()) as { id: number; rule: { path_prefix: string } };
    expect(body.rule.path_prefix).toBe('secrets/');

    const badPrincipal = await app(
      'POST',
      '/api/v1/repos/acme/admin/path-rules',
      user.headers,
      {
        path_prefix: 'x/',
        effect: 'deny',
        principal: 'everyone',
        perms: ['read'],
      },
    );
    expect(badPrincipal.status).toBe(400);

    const badPerm = await app(
      'POST',
      '/api/v1/repos/acme/admin/path-rules',
      user.headers,
      {
        path_prefix: 'x/',
        effect: 'deny',
        principal: '*',
        perms: ['destroy'],
      },
    );
    expect(badPerm.status).toBe(400);

    const traversal = await app(
      'POST',
      '/api/v1/repos/acme/admin/path-rules',
      user.headers,
      {
        path_prefix: '../etc/',
        effect: 'deny',
        principal: '*',
        perms: ['read'],
      },
    );
    expect(traversal.status).toBe(400);

    const list = await app('GET', '/api/v1/repos/acme/admin/path-rules', user.headers);
    expect(((await list.json()) as { path_rules: unknown[] }).path_rules).toHaveLength(1);

    const removed = await app(
      'DELETE',
      `/api/v1/repos/acme/admin/path-rules/${body.id}`,
      user.headers,
    );
    expect(removed.status).toBe(200);
    const gone = await app(
      'DELETE',
      `/api/v1/repos/acme/admin/path-rules/${body.id}`,
      user.headers,
    );
    expect(gone.status).toBe(404);
  });

  it('non-admins cannot administer (existence hidden from non-readers)', async () => {
    const res = await app('GET', '/api/v1/repos/acme/admin/members', stranger.headers);
    expect(res.status).toBe(404); // stranger cannot even read the private repo
  });
});

describe('route sweep — the authz contract future routes must extend', () => {
  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
    user = await loginAs(testEnv, 1, 'ada');
    stranger = await loginAs(testEnv, 2, 'mallory');
  });

  it('every guarded route enforces a decision per principal', async () => {
    const repo = await createRepo(dbEnv, {
      slug: 'acme/sweep',
      visibility: 'private',
      createdBy: user.userId,
    });
    const committed = await commitChanges(dbEnv, repo.id, {
      first_parent: null,
      message: 'seed',
      author,
      changes: [{ path: 'a.txt', op: 'add', content_b64: btoa('a') }],
    });
    const cs = committed.changeset.id;

    // [method, path, body, {anon, stranger(non-member), creator}]
    const sweep: {
      method: string;
      path: string;
      body?: unknown;
      expect: { anon: number; stranger: number; creator: number };
    }[] = [
      {
        method: 'POST',
        path: '/api/v1/repos/acme/sweep/changesets',
        body: {
          first_parent: null,
          message: 'x',
          author: { name: 'a', email: 'a@b.c' },
          changes: [{ path: 'b.txt', op: 'add', content_b64: btoa('b') }],
        },
        expect: { anon: 401, stranger: 404, creator: 201 },
      },
      {
        method: 'GET',
        path: `/api/v1/repos/acme/sweep/changesets/${cs}`,
        expect: { anon: 401, stranger: 404, creator: 200 },
      },
      {
        method: 'GET',
        path: '/api/v1/repos/acme/sweep/changesets',
        expect: { anon: 401, stranger: 404, creator: 200 },
      },
      {
        method: 'GET',
        path: '/api/v1/repos/acme/sweep/refs',
        expect: { anon: 401, stranger: 404, creator: 200 },
      },
      {
        method: 'PUT',
        path: '/api/v1/repos/acme/sweep/refs/main',
        body: { from: null, to: cs },
        expect: { anon: 401, stranger: 404, creator: 200 },
      },
      {
        method: 'GET',
        path: `/api/v1/repos/acme/sweep/file?cs=${cs}&path=a.txt`,
        expect: { anon: 401, stranger: 404, creator: 200 },
      },
      {
        method: 'GET',
        path: `/api/v1/repos/acme/sweep/tree?cs=${cs}`,
        expect: { anon: 401, stranger: 404, creator: 200 },
      },
      {
        method: 'GET',
        path: `/api/v1/repos/acme/sweep/history?cs=${cs}`,
        expect: { anon: 401, stranger: 404, creator: 200 },
      },
      {
        method: 'GET',
        path: `/api/v1/repos/acme/sweep/changed-paths?cs=${cs}`,
        expect: { anon: 401, stranger: 404, creator: 200 },
      },
      {
        method: 'GET',
        path: `/api/v1/repos/acme/sweep/diff?from=${cs}&to=${cs}`,
        expect: { anon: 401, stranger: 404, creator: 200 },
      },
      {
        method: 'GET',
        path: `/api/v1/repos/acme/sweep/blame?cs=${cs}&path=a.txt`,
        expect: { anon: 401, stranger: 404, creator: 200 },
      },
      {
        method: 'GET',
        path: `/api/v1/repos/acme/sweep/merge-base?a=${cs}&b=${cs}`,
        expect: { anon: 401, stranger: 404, creator: 200 },
      },
      {
        method: 'GET',
        path: `/api/v1/repos/acme/sweep/is-ancestor?a=${cs}&b=${cs}`,
        expect: { anon: 401, stranger: 404, creator: 200 },
      },
      {
        method: 'GET',
        path: `/api/v1/repos/acme/sweep/object/tree/${'0'.repeat(64)}`,
        expect: { anon: 401, stranger: 404, creator: 404 }, // guarded; object missing
      },
      {
        method: 'POST',
        path: '/api/v1/repos/acme/sweep/fetch-objects',
        body: { trees: [] },
        expect: { anon: 401, stranger: 404, creator: 200 },
      },
      {
        method: 'GET',
        path: `/api/v1/repos/acme/sweep/checkout-info?cs=${cs}`,
        expect: { anon: 401, stranger: 404, creator: 200 },
      },
      {
        method: 'PUT',
        path: `/api/v1/repos/acme/sweep/blob?sha256=${'0'.repeat(64)}&encoding=identity`,
        body: 'x',
        expect: { anon: 401, stranger: 404, creator: 400 }, // guarded; bad hash
      },
      {
        method: 'GET',
        path: '/api/v1/repos/acme/sweep/members',
        expect: { anon: 401, stranger: 404, creator: 200 },
      },
      {
        method: 'GET',
        path: '/api/v1/repos/acme/sweep/path-rules',
        expect: { anon: 401, stranger: 404, creator: 200 },
      },
      {
        method: 'GET',
        path: '/api/v1/repos/acme/sweep/tags',
        expect: { anon: 401, stranger: 404, creator: 200 },
      },
      {
        method: 'POST',
        path: '/api/v1/repos/acme/sweep/tags',
        body: { name: 'v1', target: cs },
        expect: { anon: 401, stranger: 404, creator: 201 },
      },
      {
        method: 'GET',
        path: '/api/v1/repos/acme/sweep/rulesets',
        expect: { anon: 401, stranger: 404, creator: 200 },
      },
      {
        method: 'POST',
        path: '/api/v1/repos/acme/sweep/rulesets',
        body: {
          name: 'protect main',
          target: 'branch',
          conditions: { ref_name: { include: ['main'] } },
          rules: [{ type: 'deletion' }],
        },
        expect: { anon: 401, stranger: 404, creator: 201 },
      },
      {
        method: 'PUT',
        path: '/api/v1/repos/acme/sweep/rulesets/missing',
        body: {},
        expect: { anon: 401, stranger: 404, creator: 404 }, // guarded; no such ruleset
      },
      {
        method: 'DELETE',
        path: '/api/v1/repos/acme/sweep/rulesets/missing',
        expect: { anon: 401, stranger: 404, creator: 404 }, // guarded; no such ruleset
      },
      {
        method: 'GET',
        path: '/api/v1/repos/acme/sweep/rulesets/evaluations',
        expect: { anon: 401, stranger: 404, creator: 200 },
      },
      {
        method: 'GET',
        path: '/api/v1/repos/acme/sweep/secret-scanning/alerts',
        expect: { anon: 401, stranger: 404, creator: 200 },
      },
      {
        method: 'PATCH',
        path: '/api/v1/repos/acme/sweep/secret-scanning/alerts/1',
        body: { state: 'open' },
        expect: { anon: 401, stranger: 404, creator: 404 }, // guarded; no such alert
      },
      {
        method: 'POST',
        path: '/api/v1/repos/acme/sweep/secret-scanning/scans',
        expect: { anon: 401, stranger: 404, creator: 202 },
      },
      // dependency alerts and code scanning (#67)
      {
        method: 'GET',
        path: '/api/v1/repos/acme/sweep/dependencies',
        expect: { anon: 401, stranger: 404, creator: 200 },
      },
      {
        method: 'GET',
        path: '/api/v1/repos/acme/sweep/dependency-alerts',
        expect: { anon: 401, stranger: 404, creator: 200 },
      },
      {
        method: 'PATCH',
        path: '/api/v1/repos/acme/sweep/dependency-alerts/1',
        body: { state: 'open' },
        expect: { anon: 401, stranger: 404, creator: 404 }, // guarded; no such alert
      },
      {
        method: 'POST',
        path: '/api/v1/repos/acme/sweep/dependency-alerts/1/work',
        expect: { anon: 401, stranger: 404, creator: 404 }, // guarded; no such alert
      },
      {
        method: 'GET',
        path: '/api/v1/repos/acme/sweep/code-scanning/alerts',
        expect: { anon: 401, stranger: 404, creator: 200 },
      },
      {
        method: 'PATCH',
        path: '/api/v1/repos/acme/sweep/code-scanning/alerts/1',
        body: { state: 'open' },
        expect: { anon: 401, stranger: 404, creator: 404 }, // guarded; no such alert
      },
      {
        method: 'POST',
        path: '/api/v1/repos/acme/sweep/code-scanning/sarif',
        body: {},
        expect: { anon: 401, stranger: 404, creator: 400 }, // guarded; empty body
      },
      {
        method: 'GET',
        path: '/api/v1/repos/acme/sweep/pulls/1/security',
        expect: { anon: 401, stranger: 404, creator: 404 }, // guarded; no such pull request
      },
      {
        method: 'PUT',
        path: '/api/v1/repos/acme/sweep',
        body: {},
        expect: { anon: 401, stranger: 404, creator: 200 },
      },
      // line-level review (#39): guarded; no such pull request
      {
        method: 'GET',
        path: '/api/v1/repos/acme/sweep/pulls/1/threads',
        expect: { anon: 401, stranger: 404, creator: 404 },
      },
      {
        method: 'POST',
        path: '/api/v1/repos/acme/sweep/pulls/1/threads',
        body: {},
        expect: { anon: 401, stranger: 404, creator: 404 },
      },
      {
        method: 'POST',
        path: '/api/v1/repos/acme/sweep/pulls/1/threads/1/replies',
        body: { body: 'x' },
        expect: { anon: 401, stranger: 404, creator: 404 },
      },
      {
        method: 'PUT',
        path: '/api/v1/repos/acme/sweep/pulls/1/threads/1/resolution',
        body: { resolved: true },
        expect: { anon: 401, stranger: 404, creator: 404 },
      },
      {
        method: 'POST',
        path: '/api/v1/repos/acme/sweep/pulls/1/suggestions/apply',
        body: {},
        expect: { anon: 401, stranger: 404, creator: 404 },
      },
      {
        method: 'GET',
        path: '/api/v1/repos/acme/sweep/pulls/1/reviewers',
        expect: { anon: 401, stranger: 404, creator: 404 },
      },
      {
        method: 'PUT',
        path: '/api/v1/repos/acme/sweep/pulls/1/reviewers',
        body: { reviewers: [] },
        expect: { anon: 401, stranger: 404, creator: 404 },
      },
      // merge queue (#43): guarded; no such pull request, an empty queue
      {
        method: 'POST',
        path: '/api/v1/repos/acme/sweep/pulls/1/queue',
        body: {},
        expect: { anon: 401, stranger: 404, creator: 404 },
      },
      {
        method: 'DELETE',
        path: '/api/v1/repos/acme/sweep/pulls/1/queue',
        expect: { anon: 401, stranger: 404, creator: 404 },
      },
      {
        method: 'GET',
        path: '/api/v1/repos/acme/sweep/merge-queue',
        expect: { anon: 401, stranger: 404, creator: 200 },
      },
      {
        method: 'GET',
        path: '/api/v1/repos/acme/sweep/pulls/1/codeowners',
        expect: { anon: 401, stranger: 404, creator: 404 },
      },
      {
        method: 'GET',
        path: `/api/v1/repos/acme/sweep/codeowners?rev=${cs}`,
        expect: { anon: 401, stranger: 404, creator: 200 },
      },
      {
        method: 'GET',
        path: '/api/v1/repos/acme/sweep/work',
        expect: { anon: 401, stranger: 404, creator: 200 },
      },
      {
        method: 'POST',
        path: '/api/v1/repos/acme/sweep/work/claim',
        body: {},
        expect: { anon: 401, stranger: 404, creator: 200 },
      },
      {
        method: 'POST',
        path: '/api/v1/repos/acme/sweep/work/import-labels',
        body: {},
        expect: { anon: 401, stranger: 404, creator: 200 },
      },
      {
        method: 'GET',
        path: '/api/v1/repos/acme/sweep/work/1',
        expect: { anon: 401, stranger: 404, creator: 404 }, // guarded; no such issue
      },
      {
        method: 'PUT',
        path: '/api/v1/repos/acme/sweep/work/1',
        body: {},
        expect: { anon: 401, stranger: 404, creator: 404 }, // guarded; no such issue
      },
      {
        method: 'POST',
        path: '/api/v1/repos/acme/sweep/work/1/heartbeat',
        body: {},
        expect: { anon: 401, stranger: 404, creator: 404 }, // guarded; no such issue
      },
      {
        method: 'POST',
        path: '/api/v1/repos/acme/sweep/work/1/release',
        body: { outcome: 'done' },
        expect: { anon: 401, stranger: 404, creator: 404 }, // guarded; no such issue
      },
      {
        method: 'GET',
        path: '/api/v1/repos/acme/sweep/packages',
        expect: { anon: 401, stranger: 404, creator: 200 },
      },
      {
        method: 'PATCH',
        path: '/api/v1/repos/acme/sweep/packages/1',
        body: { keep_untagged: 1 },
        expect: { anon: 401, stranger: 404, creator: 404 }, // guarded; no such package
      },
      // mirrors and cutover (#36, #73): admins with a session
      {
        method: 'GET',
        path: '/api/v1/repos/acme/sweep/mirrors',
        expect: { anon: 401, stranger: 404, creator: 200 },
      },
      {
        method: 'POST',
        path: '/api/v1/repos/acme/sweep/mirrors',
        body: {},
        expect: { anon: 401, stranger: 404, creator: 400 },
      },
      {
        method: 'PATCH',
        path: '/api/v1/repos/acme/sweep/mirrors/missing',
        body: {},
        expect: { anon: 401, stranger: 404, creator: 404 }, // guarded; no such mirror
      },
      {
        method: 'DELETE',
        path: '/api/v1/repos/acme/sweep/mirrors/missing',
        expect: { anon: 401, stranger: 404, creator: 404 }, // guarded; no such mirror
      },
      {
        method: 'POST',
        path: '/api/v1/repos/acme/sweep/mirrors/missing/sync',
        expect: { anon: 401, stranger: 404, creator: 404 }, // guarded; no such mirror
      },
      {
        method: 'GET',
        path: '/api/v1/repos/acme/sweep/migration',
        expect: { anon: 401, stranger: 404, creator: 200 },
      },
      {
        method: 'POST',
        path: '/api/v1/repos/acme/sweep/migration',
        body: { to: 'dual' },
        expect: { anon: 401, stranger: 404, creator: 409 }, // github -> dual skips a stage
      },
    ];

    for (const entry of sweep) {
      for (const [who, headers] of [
        ['anon', {} as Record<string, string>],
        ['stranger', stranger.headers],
        ['creator', user.headers],
      ] as const) {
        const res = await app(entry.method, entry.path, headers, entry.body);
        expect(
          res.status,
          `${entry.method} ${entry.path} as ${who} → ${res.status}, expected ${entry.expect[who]}`,
        ).toBe(entry.expect[who]);
      }
    }
  });
});

async function app(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<Response> {
  return makeApp(testEnv)(
    new Request(`https://x${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body:
        body === undefined
          ? undefined
          : typeof body === 'string'
            ? body
            : JSON.stringify(body),
    }),
  );
}
