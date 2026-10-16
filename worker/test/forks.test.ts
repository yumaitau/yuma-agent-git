import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import {
  cleanDb,
  instrumentDb,
  instrumentObjects,
  loginAs,
  makeApp,
  seedSchema,
  type TestEnv,
} from './helpers';
import type { Env } from '../src/env';
import { createRepo, getRef, setRef } from '../src/db/repos';
import { commitChanges } from '../src/core/commit';
import { q, q1, run } from '../src/db/client';
import { storageId } from '../src/core/network';
import type { Pull } from '../shared/collaboration';
import { parsePolicy, type CiRun } from '../src/ci/config';
import { parseContext } from '../src/ci/context';
import { jobTrust } from '../src/ci/environments';
import { cacheScopes } from '../src/ci/cache';

const testEnv = env as unknown as TestEnv;
const author = { name: 'Ada', email: 'ada@example.com' };
let owner: Awaited<ReturnType<typeof loginAs>>;
let contributor: Awaited<ReturnType<typeof loginAs>>;
let upstream: Awaited<ReturnType<typeof createRepo>>;
let base: string;

async function commit(
  repoId: string,
  parent: string | null,
  files: Record<string, string>,
): Promise<string> {
  return (
    await commitChanges(testEnv, repoId, {
      first_parent: parent,
      message: Object.keys(files).join(' '),
      author,
      changes: Object.entries(files).map(([path, text]) => ({
        path,
        op: 'add' as const,
        content_b64: btoa(text),
      })),
    })
  ).changeset.id;
}

async function api(
  path: string,
  method = 'GET',
  body?: unknown,
  actor: { headers: Record<string, string> } | null = owner,
  bindings: Env = testEnv,
): Promise<Response> {
  return makeApp(bindings)(
    new Request(`https://x/api/v1${path}`, {
      method,
      headers: { ...(actor?.headers ?? {}), 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

async function fork(
  slug = 'team/project',
  actor = contributor,
  bindings: Env = testEnv,
): Promise<Response> {
  return api(`/repos/${slug}/forks`, 'POST', {}, actor, bindings);
}

beforeEach(async () => {
  await seedSchema(testEnv);
  await cleanDb(testEnv);
  owner = await loginAs(testEnv, 801, 'owner');
  contributor = await loginAs(testEnv, 802, 'contributor');
  upstream = await createRepo(testEnv, {
    slug: 'team/project',
    createdBy: owner.userId,
    visibility: 'private',
  });
  await run(
    testEnv,
    "INSERT INTO repo_members(repo_id,user_id,role) VALUES (?,?,'read')",
    [upstream.id, contributor.userId],
  );
  base = await commit(upstream.id, null, { 'README.md': 'hello\n' });
  await setRef(testEnv, upstream.id, 'main', base);
});

describe('forks (#36)', () => {
  it('copies branch and tag refs only and shares content with the upstream', async () => {
    await setRef(testEnv, upstream.id, 'refs/tags/v1', base);
    await setRef(testEnv, upstream.id, 'refs/agents/a1/work', base);
    const res = await fork();
    expect(res.status).toBe(201);
    const { repo } = (await res.json()) as {
      repo: { id: string; slug: string; fork_of: string; visibility: string };
    };
    expect(repo).toMatchObject({
      slug: 'contributor/project',
      fork_of: upstream.id,
      visibility: 'private',
    });
    expect(storageId(repo.id)).toBe(upstream.id);
    const refs = await q<{ name: string }>(
      testEnv,
      'SELECT name FROM refs WHERE repo_id = ? ORDER BY name',
      [repo.id],
    );
    expect(refs.map((r) => r.name)).toEqual(['main', 'refs/tags/v1']);

    // the fork reads the upstream's objects without a copy
    const file = await api(
      '/repos/contributor/project/file?cs=main&path=README.md',
      'GET',
      undefined,
      contributor,
    );
    expect(file.status).toBe(200);

    // listed only for callers who can read the fork, recorded in the audit log
    const forks = async (actor: typeof owner) =>
      (
        (await (
          await api('/repos/team/project/forks', 'GET', undefined, actor)
        ).json()) as {
          forks: { slug: string }[];
        }
      ).forks;
    expect(await forks(contributor)).toEqual([
      expect.objectContaining({ slug: 'contributor/project' }),
    ]);
    expect(await forks(owner)).toEqual([]);
    const audit = await q1<{ action: string }>(
      testEnv,
      "SELECT action FROM audit_events WHERE action = 'repo.fork'",
    );
    expect(audit).not.toBeNull();
  });

  it('forks in constant time: no object reads or writes, same D1 work for any size', async () => {
    const statements = async (slug: string, actor = contributor): Promise<number> => {
      const db = instrumentDb(testEnv);
      const objects = instrumentObjects(db.env as TestEnv);
      const res = await fork(slug, actor, objects.env);
      expect(res.status).toBe(201);
      expect([...objects.puts, ...objects.gets, ...objects.heads]).toEqual([]);
      return db.prepares.length;
    };
    const small = await statements('team/project');

    // a much larger history: 40 commits of 25 files each
    const big = await createRepo(testEnv, { slug: 'team/big', createdBy: owner.userId });
    let parent: string | null = null;
    for (let i = 0; i < 40; i++) {
      const files: Record<string, string> = {};
      for (let f = 0; f < 25; f++) files[`dir${i}/f${f}.txt`] = `${i}:${f}\n`;
      parent = await commit(big.id, parent, files);
    }
    await setRef(testEnv, big.id, 'main', parent as string);
    expect(await statements('team/big', owner)).toBe(small);
  });

  it('opens, reviews and merges a pull request from a fork', async () => {
    const created = (await (await fork()).json()) as { repo: { id: string } };
    const forkId = created.repo.id;
    const head = await commit(forkId, base, { 'feature.txt': 'from the fork\n' });
    await setRef(testEnv, forkId, 'feature', head);

    // read on the upstream is enough to propose from a fork
    const opened = await api(
      '/repos/team/project/pulls',
      'POST',
      { title: 'From a fork', head_cs: head, head_repo: 'contributor/project' },
      contributor,
    );
    expect(opened.status).toBe(201);
    const { pull } = (await opened.json()) as { pull: Pull };
    expect(pull.head_repo_id).toBe(forkId);

    expect(
      (
        await api(
          `/repos/team/project/pulls/${pull.id}/review`,
          'POST',
          { revision: 1, head_cs: head, decision: 'approve', body: 'ok' },
          owner,
        )
      ).status,
    ).toBe(200);
    const merged = await api(
      `/repos/team/project/pulls/${pull.id}/merge`,
      'POST',
      { revision: 1, head_cs: head },
      owner,
    );
    expect(merged.status).toBe(200);
    const after = await q1<Pull>(testEnv, 'SELECT * FROM pull_requests WHERE id = ?', [
      pull.id,
    ]);
    expect(after?.state).toBe('merged');
    const tip = await getRef(testEnv, upstream.id, 'main');
    expect(tip?.head).toBe(after?.merged_cs);
    const file = await api('/repos/team/project/file?cs=main&path=feature.txt');
    expect(file.status).toBe(200);
  });

  it('runs fork pull request CI as a fork: no secrets, variables or OIDC', async () => {
    const created = (await (await fork()).json()) as { repo: { id: string } };
    const head = await commit(created.repo.id, base, { 'x.txt': 'x\n' });
    await setRef(testEnv, created.repo.id, 'feature', head);
    const ci: Env = new Proxy(testEnv, {
      get(target, key, receiver) {
        if (key === 'CI_ENABLED') return 'true';
        if (key === 'CI_QUEUE') return { send: async () => {} };
        if (key === 'CI_RUNNER')
          return {
            idFromName: (id: string) => id,
            get: () => ({ fetch: async () => Response.json({ ok: true }) }),
          };
        return Reflect.get(target, key, receiver);
      },
    });
    expect(
      (
        await api(
          '/repos/team/project/ci',
          'PUT',
          { commands: ['npm test'], timeout_seconds: 60, required_approvals: 0 },
          owner,
        )
      ).status,
    ).toBe(200);
    const opened = await api(
      '/repos/team/project/pulls',
      'POST',
      { title: 'CI from a fork', head_cs: head, head_repo: 'contributor/project' },
      contributor,
      ci,
    );
    expect(opened.status).toBe(201);
    const runRow = await q1<{ context: string }>(
      testEnv,
      'SELECT context FROM ci_runs WHERE repo_id = ?',
      [upstream.id],
    );
    expect(JSON.parse(runRow?.context ?? '{}')).toMatchObject({
      event: 'pull_request',
      fork: true,
    });
    // a maintainer's secrets are withheld (#50) even when the job asks, and its
    // cache scope is the pull request's own: it reads main's, never writes it (#51)
    const { pull } = (await opened.json()) as { pull: Pull };
    const job = (await q1<CiRun>(testEnv, 'SELECT * FROM ci_runs WHERE repo_id = ?', [
      upstream.id,
    ]))!;
    const policy = parsePolicy(JSON.parse(job.config));
    expect(
      await jobTrust(
        ci,
        job,
        { ...policy, secrets: ['DEPLOY_KEY'] },
        parseContext(job.context),
      ),
    ).toEqual({ ok: false, reason: 'pull request from a fork' });
    expect(cacheScopes(job, 'main')).toEqual({
      write: `refs/pull/${pull.id}`,
      read: [`refs/pull/${pull.id}`, 'refs/heads/main'],
    });
  });

  it('refuses pull requests whose head is not a readable fork branch', async () => {
    const created = (await (await fork()).json()) as { repo: { id: string } };
    const head = await commit(created.repo.id, base, { 'y.txt': 'y\n' });
    const propose = (extra: Record<string, unknown>, actor = contributor) =>
      api(
        '/repos/team/project/pulls',
        'POST',
        { title: 't', head_cs: head, ...extra },
        actor,
      );

    // the head is not a branch or tag tip of the fork
    expect((await propose({ head_repo: 'contributor/project' })).status).toBe(404);
    await setRef(testEnv, created.repo.id, 'feature', head);
    // the base repo itself is no fork: a reader cannot dodge the write check
    const self = await propose({ head_repo: 'team/project' });
    expect(self.status).toBe(422);
    expect(await self.json()).toMatchObject({ error: { code: 'not_a_fork' } });
    // without head_repo a reader needs write
    expect((await propose({})).status).toBe(403);
    // another network
    const other = await createRepo(testEnv, {
      slug: 'contributor/other',
      createdBy: contributor.userId,
    });
    await setRef(testEnv, other.id, 'main', base);
    const foreign = await propose({ head_repo: 'contributor/other' });
    expect(foreign.status).toBe(422);
    // a fork the caller cannot read is 404
    const stranger = await loginAs(testEnv, 803, 'stranger');
    expect((await propose({ head_repo: 'contributor/project' }, stranger)).status).toBe(
      404,
    );
  });

  it('applies the API contract to forking', async () => {
    expect((await fork('team/project', null as never)).status).toBe(401);
    const stranger = await loginAs(testEnv, 804, 'stranger');
    expect((await fork('team/project', stranger)).status).toBe(404);
    // a fork carries every path, so path-restricted readers cannot fork
    await run(
      testEnv,
      "INSERT INTO path_rules (repo_id,path_prefix,effect,principal,perms) VALUES (?,?,'deny',?,?)",
      [upstream.id, 'private/', `user:${contributor.userId}`, JSON.stringify(['read'])],
    );
    const restricted = await fork();
    expect(restricted.status).toBe(403);
    expect(await restricted.json()).toMatchObject({
      error: { code: 'whole_repository_required' },
    });
    await run(testEnv, 'DELETE FROM path_rules');
    expect((await fork()).status).toBe(201);
    // the slug is taken now
    expect((await fork()).status).toBe(409);
  });
});
