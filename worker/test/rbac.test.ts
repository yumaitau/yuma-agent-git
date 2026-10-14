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
        expect: { anon: 404, stranger: 404, creator: 200 },
      },
      {
        method: 'GET',
        path: '/api/v1/repos/acme/sweep/changesets',
        expect: { anon: 404, stranger: 404, creator: 200 },
      },
      {
        method: 'GET',
        path: '/api/v1/repos/acme/sweep/refs',
        expect: { anon: 404, stranger: 404, creator: 200 },
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
        expect: { anon: 404, stranger: 404, creator: 200 },
      },
      {
        method: 'GET',
        path: `/api/v1/repos/acme/sweep/tree?cs=${cs}`,
        expect: { anon: 404, stranger: 404, creator: 200 },
      },
      {
        method: 'GET',
        path: `/api/v1/repos/acme/sweep/history?cs=${cs}`,
        expect: { anon: 404, stranger: 404, creator: 200 },
      },
      {
        method: 'GET',
        path: `/api/v1/repos/acme/sweep/changed-paths?cs=${cs}`,
        expect: { anon: 404, stranger: 404, creator: 200 },
      },
      {
        method: 'GET',
        path: `/api/v1/repos/acme/sweep/diff?from=${cs}&to=${cs}`,
        expect: { anon: 404, stranger: 404, creator: 200 },
      },
      {
        method: 'GET',
        path: `/api/v1/repos/acme/sweep/blame?cs=${cs}&path=a.txt`,
        expect: { anon: 404, stranger: 404, creator: 200 },
      },
      {
        method: 'GET',
        path: `/api/v1/repos/acme/sweep/merge-base?a=${cs}&b=${cs}`,
        expect: { anon: 404, stranger: 404, creator: 200 },
      },
      {
        method: 'GET',
        path: `/api/v1/repos/acme/sweep/is-ancestor?a=${cs}&b=${cs}`,
        expect: { anon: 404, stranger: 404, creator: 200 },
      },
      {
        method: 'GET',
        path: `/api/v1/repos/acme/sweep/object/tree/${'0'.repeat(64)}`,
        expect: { anon: 404, stranger: 404, creator: 404 }, // guarded; object missing
      },
      {
        method: 'POST',
        path: '/api/v1/repos/acme/sweep/fetch-objects',
        body: { trees: [] },
        expect: { anon: 404, stranger: 404, creator: 200 },
      },
      {
        method: 'GET',
        path: `/api/v1/repos/acme/sweep/checkout-info?cs=${cs}`,
        expect: { anon: 404, stranger: 404, creator: 200 },
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
