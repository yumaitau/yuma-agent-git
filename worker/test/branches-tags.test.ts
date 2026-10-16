import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { cleanDb, loginAs, makeApp, seedSchema } from './helpers';
import type { TestEnv } from './helpers';
import { createRepo, getRef, getRepo, setRef } from '../src/db/repos';
import { run } from '../src/db/client';
import { commitChanges } from '../src/core/commit';
import type { Changeset } from '../src/core/changesets';
import { AGENT_REF_TTL_MS, expireAgentRefs } from '../src/core/refs';
import { lookupRevId } from '../src/core/read';

const testEnv = env as unknown as TestEnv;
const dbEnv = testEnv as unknown as Env;
const author = { name: 'Ada', email: 'ada@example.com' };
let owner: Awaited<ReturnType<typeof loginAs>>;

async function makeChain(repoId: string, count: number): Promise<Changeset[]> {
  const out: Changeset[] = [];
  let parent: string | null = null;
  for (let i = 0; i <= count; i++) {
    const res = await commitChanges(dbEnv, repoId, {
      first_parent: parent,
      message: `cs${i}`,
      author,
      changes: [{ path: `f${i}.txt`, op: 'add', content_b64: btoa(`content ${i}`) }],
    });
    out.push(res.changeset);
    parent = res.changeset.id;
  }
  return out;
}

async function call(
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response> {
  return makeApp(testEnv)(
    new Request(`http://x${path}`, {
      method: init.method ?? 'GET',
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
  );
}

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

async function makeToken(
  scopes: string[],
): Promise<{ id: string; headers: Record<string, string> }> {
  const res = await call('/api/v1/tokens', {
    method: 'POST',
    headers: owner.headers,
    body: { label: 'agent', scopes },
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { id: string; token: string };
  return { id: body.id, headers: { authorization: `Bearer ${body.token}` } };
}

describe('arbitrary branches and tags (issue #33)', () => {
  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
    owner = await loginAs(testEnv, 1, 'ada');
  });

  it('new repos use git ref rules; existing pilot rows default to scion', async () => {
    const repo = await createRepo(dbEnv, { slug: 'acme/new', createdBy: owner.userId });
    expect(repo.refs_mode).toBe('git');
    // a row written before migration 0011 never names refs_mode
    await run(
      dbEnv,
      `INSERT INTO repos (id, slug, default_branch, created_at, visibility, created_by)
       VALUES ('pilot', 'acme/pilot', 'main', 1, 'private', ?)`,
      [owner.userId],
    );
    expect((await getRepo(dbEnv, 'pilot'))?.refs_mode).toBe('scion');

    const [cs0] = (await makeChain('pilot', 0)) as [Changeset];
    const scion = await call('/api/v1/repos/acme/pilot/refs/feature/x', {
      method: 'PUT',
      headers: owner.headers,
      body: { from: null, to: cs0.id },
    });
    expect(scion.status).toBe(400);
    expect(await errorCode(scion)).toBe('invalid_ref_name');
  });

  it('creates, reads and resolves feature/foo-bar, user/justin/fix and v1.2.3', async () => {
    const repo = await createRepo(dbEnv, { slug: 'acme/git', createdBy: owner.userId });
    const [cs0, cs1] = (await makeChain(repo.id, 1)) as [Changeset, Changeset];

    for (const name of ['feature/foo-bar', 'user/justin/fix']) {
      const put = await call(`/api/v1/repos/acme/git/refs/${name}`, {
        method: 'PUT',
        headers: owner.headers,
        body: { from: null, to: cs0.id },
      });
      expect(put.status).toBe(200);
      const got = await call(`/api/v1/repos/acme/git/refs/${encodeURIComponent(name)}`, {
        headers: owner.headers,
      });
      expect(((await got.json()) as { head: string }).head).toBe(cs0.id);
      expect(await lookupRevId(dbEnv, repo.id, name)).toBe(cs0.id);
    }

    const tag = await call('/api/v1/repos/acme/git/tags', {
      method: 'POST',
      headers: owner.headers,
      body: { name: 'v1.2.3', target: cs1.id },
    });
    expect(tag.status).toBe(201);
    // a lightweight tag is a plain ref under refs/tags/
    expect((await getRef(dbEnv, repo.id, 'refs/tags/v1.2.3'))?.head).toBe(cs1.id);
    expect(await lookupRevId(dbEnv, repo.id, 'v1.2.3')).toBe(cs1.id);
    // the ref route accepts the full name even though it contains /refs/
    const full = await call('/api/v1/repos/acme/git/refs/refs/tags/v1.2.3', {
      headers: owner.headers,
    });
    expect(full.status).toBe(200);
  });

  it('stores annotated and signed tags and keeps tags immutable without force', async () => {
    const repo = await createRepo(dbEnv, { slug: 'acme/tags', createdBy: owner.userId });
    const [cs0, cs1] = (await makeChain(repo.id, 1)) as [Changeset, Changeset];
    await setRef(dbEnv, repo.id, 'main', cs0.id);

    const annotated = await call('/api/v1/repos/acme/tags/tags', {
      method: 'POST',
      headers: owner.headers,
      body: { name: 'v2.0.0', target: 'main', message: 'Release 2', signature: 'SIG' },
    });
    expect(annotated.status).toBe(201);
    await call('/api/v1/repos/acme/tags/tags', {
      method: 'POST',
      headers: owner.headers,
      body: { name: 'v1.0.0', target: cs0.id },
    });

    const dup = await call('/api/v1/repos/acme/tags/tags', {
      method: 'POST',
      headers: owner.headers,
      body: { name: 'v2.0.0', target: cs1.id },
    });
    expect(dup.status).toBe(409);
    expect(await errorCode(dup)).toBe('tag_exists');

    const unsigned = await call('/api/v1/repos/acme/tags/tags', {
      method: 'POST',
      headers: owner.headers,
      body: { name: 'v3', target: cs1.id, signature: 'SIG' },
    });
    expect(unsigned.status).toBe(400);

    const move = await call('/api/v1/repos/acme/tags/refs/refs/tags/v1.0.0', {
      method: 'PUT',
      headers: owner.headers,
      body: { from: cs0.id, to: cs1.id },
    });
    expect(move.status).toBe(409);
    expect(await errorCode(move)).toBe('tag_exists');
    const forced = await call('/api/v1/repos/acme/tags/refs/refs/tags/v1.0.0', {
      method: 'PUT',
      headers: owner.headers,
      body: { from: cs0.id, to: cs1.id, force: true },
    });
    expect(forced.status).toBe(200);

    const list = await call('/api/v1/repos/acme/tags/tags', { headers: owner.headers });
    const body = (await list.json()) as {
      tags: {
        name: string;
        target_cs: string;
        annotated: boolean;
        message: string | null;
        tagger: unknown;
        signature: string | null;
      }[];
    };
    expect(body.tags).toEqual([
      expect.objectContaining({ name: 'v1.0.0', target_cs: cs1.id, annotated: false }),
      expect.objectContaining({
        name: 'v2.0.0',
        target_cs: cs0.id,
        annotated: true,
        message: 'Release 2',
        signature: 'SIG',
        tagger: { user: owner.userId },
      }),
    ]);
  });

  it('lists refs by prefix with keyset pagination and hides agent refs', async () => {
    const repo = await createRepo(dbEnv, { slug: 'acme/list', createdBy: owner.userId });
    const [cs0] = (await makeChain(repo.id, 0)) as [Changeset];
    for (const name of [
      'main',
      'feature/a',
      'feature/b',
      'feature/c',
      'featurex',
      'refs/tags/v1',
      'refs/agents/A1/t',
    ]) {
      await setRef(dbEnv, repo.id, name, cs0.id);
    }
    const names = async (
      query: string,
    ): Promise<{ names: string[]; next: string | null }> => {
      const res = await call(`/api/v1/repos/acme/list/refs${query}`, {
        headers: owner.headers,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        refs: { name: string }[];
        next_cursor: string | null;
      };
      return { names: body.refs.map((r) => r.name), next: body.next_cursor };
    };

    expect((await names('')).names).toEqual([
      'feature/a',
      'feature/b',
      'feature/c',
      'featurex',
      'main',
      'refs/tags/v1',
    ]);
    const first = await names('?prefix=feature/&limit=2');
    expect(first).toEqual({ names: ['feature/a', 'feature/b'], next: 'feature/b' });
    const second = await names(`?prefix=feature/&limit=2&cursor=${first.next}`);
    expect(second).toEqual({ names: ['feature/c'], next: null });
    expect((await names('?prefix=refs/agents/')).names).toEqual(['refs/agents/A1/t']);
  });

  it('lets only the owning agent token write refs/agents/<id>/', async () => {
    const repo = await createRepo(dbEnv, {
      slug: 'acme/agents',
      createdBy: owner.userId,
    });
    const [cs0] = (await makeChain(repo.id, 0)) as [Changeset];
    const agent = await makeToken(['repo:write', 'agent:run']);
    const other = await makeToken(['repo:write', 'agent:run']);
    const noRun = await makeToken(['repo:write']);
    const put = (name: string, headers: Record<string, string>): Promise<Response> =>
      call(`/api/v1/repos/acme/agents/refs/${name}`, {
        method: 'PUT',
        headers,
        body: { from: null, to: cs0.id },
      });

    const own = await put(`refs/agents/${agent.id}/task-1`, agent.headers);
    expect(own.status).toBe(200);
    for (const headers of [other.headers, owner.headers]) {
      const denied = await put(`refs/agents/${agent.id}/task-2`, headers);
      expect(denied.status).toBe(403);
      expect(await errorCode(denied)).toBe('forbidden');
    }
    expect((await put(`refs/agents/${noRun.id}/task`, noRun.headers)).status).toBe(403);
    // anonymous callers still get the contract 401
    expect((await put(`refs/agents/${agent.id}/task-3`, {})).status).toBe(401);
  });

  it('expires idle agent refs on the cron sweep and keeps everything else', async () => {
    const repo = await createRepo(dbEnv, {
      slug: 'acme/expiry',
      createdBy: owner.userId,
    });
    const [cs0] = (await makeChain(repo.id, 0)) as [Changeset];
    await setRef(dbEnv, repo.id, 'main', cs0.id, 1000);
    await setRef(dbEnv, repo.id, 'refs/agents/A1/old', cs0.id, 1000);
    await setRef(dbEnv, repo.id, 'refs/agents/A1/fresh', cs0.id, 1000 + AGENT_REF_TTL_MS);

    await expireAgentRefs(dbEnv, 2000 + AGENT_REF_TTL_MS);
    expect(await getRef(dbEnv, repo.id, 'refs/agents/A1/old')).toBeNull();
    expect(await getRef(dbEnv, repo.id, 'refs/agents/A1/fresh')).not.toBeNull();
    expect(await getRef(dbEnv, repo.id, 'main')).not.toBeNull();
  });

  it('PUT /repos/:repo changes the default branch for admins only', async () => {
    const repo = await createRepo(dbEnv, {
      slug: 'acme/default',
      createdBy: owner.userId,
    });
    const [cs0] = (await makeChain(repo.id, 0)) as [Changeset];
    await setRef(dbEnv, repo.id, 'main', cs0.id);
    await setRef(dbEnv, repo.id, 'trunk', cs0.id);

    const ok = await call('/api/v1/repos/acme/default', {
      method: 'PUT',
      headers: owner.headers,
      body: { default_branch: 'trunk' },
    });
    expect(ok.status).toBe(200);
    expect(
      ((await ok.json()) as { repo: { default_branch: string } }).repo.default_branch,
    ).toBe('trunk');
    expect((await getRepo(dbEnv, repo.id))?.default_branch).toBe('trunk');

    const missing = await call('/api/v1/repos/acme/default', {
      method: 'PUT',
      headers: owner.headers,
      body: { default_branch: 'nope' },
    });
    expect(missing.status).toBe(400);
    expect(await errorCode(missing)).toBe('ref_not_found');

    const tag = await call('/api/v1/repos/acme/default', {
      method: 'PUT',
      headers: owner.headers,
      body: { default_branch: 'refs/tags/v1' },
    });
    expect(await errorCode(tag)).toBe('invalid_ref_name');

    const writer = await loginAs(testEnv, 2, 'bob');
    await run(
      dbEnv,
      `INSERT INTO repo_members (repo_id, user_id, role) VALUES (?, ?, 'write')`,
      [repo.id, writer.userId],
    );
    const forbidden = await call('/api/v1/repos/acme/default', {
      method: 'PUT',
      headers: writer.headers,
      body: { default_branch: 'main' },
    });
    expect(forbidden.status).toBe(403);
    const stranger = await loginAs(testEnv, 3, 'eve');
    const hidden = await call('/api/v1/repos/acme/default', {
      method: 'PUT',
      headers: stranger.headers,
      body: { default_branch: 'main' },
    });
    expect(hidden.status).toBe(404);
    const anon = await call('/api/v1/repos/acme/default', {
      method: 'PUT',
      body: { default_branch: 'main' },
    });
    expect(anon.status).toBe(401);
  });
});
