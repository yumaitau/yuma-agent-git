import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { cleanDb, loginAs, makeApp, seedSchema } from './helpers';
import type { TestEnv } from './helpers';
import { createRepo } from '../src/db/repos';
import { getRef } from '../src/db/repos';

const testEnv = env as unknown as TestEnv;
const dbEnv = testEnv as unknown as Env;

interface RepoPage {
  repos: { slug: string; id: string; created_at: number }[];
  next_cursor: string | null;
}

describe('dashboard API (repos index, denied_by, assets precedence)', () => {
  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
  });

  it('creates and initializes native source without a GitHub connection and never replaces its branch', async () => {
    const ada = await loginAs(testEnv, 1, 'ada');
    const app = makeApp(testEnv);
    const headers = { 'content-type': 'application/json', cookie: ada.cookie };
    const created = await app(
      new Request('https://x/api/v1/repos', {
        method: 'POST',
        headers,
        body: JSON.stringify({ slug: 'ada/native', default_branch: 'release/start' }),
      }),
    );
    expect(created.status).toBe(201);
    const { repo } = (await created.json()) as {
      repo: {
        id: string;
        github_repo_id: number | null;
        github_installation_id: number | null;
      };
    };
    expect(repo.github_repo_id).toBeNull();
    expect(repo.github_installation_id).toBeNull();
    const init = () =>
      app(
        new Request('https://x/api/v1/repos/ada/native/initialize', {
          method: 'POST',
          headers,
        }),
      );
    const results = await Promise.all([init(), init()]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const branch = await getRef(dbEnv, repo.id, 'release/start');
    expect(branch).not.toBeNull();
    const file = await app(
      new Request(
        `https://x/api/v1/repos/ada/native/file?cs=${branch!.head}&path=README.md&format=raw`,
        { headers },
      ),
    );
    expect(file.status).toBe(200);
    expect(await file.text()).toBe('# ada/native\n');
    expect((await init()).status).toBe(409);
    expect((await getRef(dbEnv, repo.id, 'release/start'))?.head).toBe(branch!.head);
    const metadata = await app(
      new Request('https://x/api/v1/repos/ada/native', { headers }),
    );
    expect(await metadata.json()).toMatchObject({
      can_admin: true,
      repo: { default_branch: 'release/start' },
    });
    expect((await app(new Request('https://x/api/v1/repos/ada/native'))).status).toBe(
      404,
    );
  });

  it('requires administration for native initialization and validates the branch before creating a repo', async () => {
    const ada = await loginAs(testEnv, 1, 'ada');
    const bob = await loginAs(testEnv, 2, 'bob');
    const repo = await createRepo(dbEnv, {
      slug: 'ada/public',
      visibility: 'public',
      createdBy: ada.userId,
    });
    const app = makeApp(testEnv);
    expect(
      (
        await app(
          new Request('https://x/api/v1/repos/ada/public/initialize', { method: 'POST' }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await app(
          new Request('https://x/api/v1/repos/ada/public/initialize', {
            method: 'POST',
            headers: bob.headers,
          }),
        )
      ).status,
    ).toBe(403);
    expect(await getRef(dbEnv, repo.id, 'main')).toBeNull();
    const invalid = await app(
      new Request('https://x/api/v1/repos', {
        method: 'POST',
        headers: { ...ada.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'ada/bad', default_branch: 'bad..branch' }),
      }),
    );
    expect(invalid.status).toBe(400);
    expect(
      (await app(new Request('https://x/api/v1/repos/ada/bad', { headers: ada.headers })))
        .status,
    ).toBe(404);
  });

  it('lists public repos to strangers and adds the caller’s own', async () => {
    const ada = await loginAs(testEnv, 1, 'ada');
    const bob = await loginAs(testEnv, 2, 'bob');
    await createRepo(dbEnv, {
      slug: 'acme/pub',
      visibility: 'public',
      createdBy: ada.userId,
    });
    await createRepo(dbEnv, {
      slug: 'acme/priv',
      visibility: 'private',
      createdBy: ada.userId,
    });
    await createRepo(dbEnv, {
      slug: 'bob/notes',
      visibility: 'private',
      createdBy: bob.userId,
    });

    const slugs = async (cookie?: string): Promise<string[]> => {
      const res = await makeApp(testEnv)(
        new Request('https://x/api/v1/repos', {
          headers: cookie ? { cookie } : {},
        }),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      const body = (await res.json()) as RepoPage;
      return body.repos.map((repo) => repo.slug).sort();
    };

    expect(await slugs()).toEqual(['acme/pub']);
    expect(await slugs(ada.cookie)).toEqual(['acme/priv', 'acme/pub']);
    expect(await slugs(bob.cookie)).toEqual(['acme/pub', 'bob/notes']);
  });

  it('paginates the index with a keyset cursor', async () => {
    await createRepo(dbEnv, { slug: 'acme/a', visibility: 'public' }, 1_000);
    await createRepo(dbEnv, { slug: 'acme/b', visibility: 'public' }, 2_000);
    await createRepo(dbEnv, { slug: 'acme/c', visibility: 'public' }, 3_000);

    const slugs: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 5; i++) {
      const url = new URL('https://x/api/v1/repos');
      url.searchParams.set('limit', '1');
      if (cursor) url.searchParams.set('cursor', cursor);
      const res = await makeApp(testEnv)(new Request(url));
      expect(res.status).toBe(200);
      const body = (await res.json()) as RepoPage;
      expect(body.repos).toHaveLength(i < 3 ? 1 : 0);
      if (body.repos[0]) slugs.push(body.repos[0].slug);
      cursor = body.next_cursor;
      if (!cursor) break;
    }
    expect(slugs).toEqual(['acme/c', 'acme/b', 'acme/a']);
    expect(cursor).toBeNull();

    const bad = await makeApp(testEnv)(new Request('https://x/api/v1/repos?cursor=nope'));
    expect(bad.status).toBe(400);
  });

  it('a signed-in non-member can read a public repo', async () => {
    const ada = await loginAs(testEnv, 1, 'ada');
    const bob = await loginAs(testEnv, 2, 'bob');
    await createRepo(dbEnv, {
      slug: 'acme/pub',
      visibility: 'public',
      createdBy: ada.userId,
    });
    const res = await makeApp(testEnv)(
      new Request('https://x/api/v1/repos/acme/pub/history', { headers: bob.headers }),
    );
    expect(res.status).toBe(200);
  });

  it('403 names the path rule that denied the read', async () => {
    const ada = await loginAs(testEnv, 1, 'ada');
    const bob = await loginAs(testEnv, 2, 'bob');
    await createRepo(dbEnv, {
      slug: 'acme/open',
      visibility: 'public',
      createdBy: ada.userId,
    });
    const rule = await makeApp(testEnv)(
      new Request('https://x/api/v1/repos/acme/open/path-rules', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: ada.cookie },
        body: JSON.stringify({
          path_prefix: 'secrets',
          effect: 'deny',
          principal: '*',
          perms: ['read', 'history'],
        }),
      }),
    );
    expect(rule.status).toBe(201);

    const denied = await makeApp(testEnv)(
      new Request(
        'https://x/api/v1/repos/acme/open/file?cs=aaaaaaaa&path=secrets/key.txt',
        { headers: bob.headers },
      ),
    );
    expect(denied.status).toBe(403);
    const body = (await denied.json()) as {
      error: { code: string; denied_by: { path_prefix: string; effect: string } };
    };
    expect(body.error.code).toBe('forbidden');
    expect(body.error.denied_by).toMatchObject({
      path_prefix: 'secrets/',
      effect: 'deny',
      principal: '*',
    });
  });

  it('API routes win over the SPA assets binding', async () => {
    const hits: string[] = [];
    const assets = {
      fetch(request: Request): Promise<Response> {
        hits.push(new URL(request.url).pathname);
        return Promise.resolve(
          new Response('<!doctype html><div id="root"></div>', {
            headers: { 'content-type': 'text/html; charset=utf-8' },
          }),
        );
      },
    };
    const withAssets = new Proxy(testEnv, {
      get(target, prop, _receiver) {
        if (prop === 'ASSETS') return assets;
        return Reflect.get(target, prop, target);
      },
    }) as TestEnv;

    const spa = await makeApp(withAssets)(new Request('https://x/index.html'));
    expect(spa.status).toBe(200);
    expect(spa.headers.get('content-type')).toContain('text/html');
    expect(hits).toEqual(['/index.html']);

    hits.length = 0;
    const health = await makeApp(withAssets)(new Request('https://x/healthz'));
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });
    expect(hits).toEqual([]);

    const repos = await makeApp(withAssets)(new Request('https://x/api/v1/repos'));
    expect(repos.status).toBe(200);
    expect(repos.headers.get('content-type')).toContain('application/json');
    expect(hits).toEqual([]);
  });
});
