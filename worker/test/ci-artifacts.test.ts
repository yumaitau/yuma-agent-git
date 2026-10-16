import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { cleanDb, loginAs, makeApp, seedSchema, type TestEnv } from './helpers';
import { setRef } from '../src/db/repos';
import { commitChanges } from '../src/core/commit';
import { q1, run } from '../src/db/client';
import { ARTIFACT_RETENTION_MS, sweepArtifacts } from '../src/ci/artifacts';
import type { PipelineRun } from '../shared/collaboration';

/**
 * Run artifacts (issue #51): job A uploads, job B of the same run downloads,
 * people download from the run page for 14 days, then the sweep deletes them.
 */
const testEnv = env as unknown as TestEnv;
const SPEC = '.yuma/pipelines/ci.yml';
const PIPELINE = `on: [manual]
jobs:
  build:
    runs-on: linux
    steps: [{ run: make }]
  test:
    needs: build
    runs-on: linux
    steps: [{ run: make test }]
`;
type Login = Awaited<ReturnType<typeof loginAs>>;
let owner: Login;
let stranger: Login;
let repoId = '';

interface Job {
  id: string;
  job: string;
  clone: { token: string };
  env: Record<string, string>;
}

function ci(): Env {
  return new Proxy(testEnv, {
    get(target, key, receiver) {
      if (key === 'CI_ENABLED') return 'true';
      if (key === 'CI_QUEUE') return { send: async () => {} };
      return Reflect.get(target, key, receiver);
    },
  });
}

function request(
  path: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
): Promise<Response> {
  return Promise.resolve(
    makeApp(ci())(new Request(`https://x${path}`, { method, headers, body })),
  );
}

const api = (path: string, method = 'GET', body?: unknown, who: Login = owner) =>
  request(
    path,
    method,
    { ...who.headers, 'content-type': 'application/json' },
    body === undefined ? undefined : JSON.stringify(body),
  );
const bearer = (raw: string) => ({ authorization: `Bearer ${raw}` });
/** A job step calling the forge with its YAG_RUNTIME_TOKEN. */
const step = (job: Job, path: string, method = 'GET', body?: string) =>
  request(`/runner/v1/jobs/${job.id}${path}`, method, bearer(job.clone.token), body);

async function registerRunner(): Promise<string> {
  const grant = await api('/api/v1/orgs/yuma/runners/registration-token', 'POST', {});
  const { token } = (await grant.json()) as { token: string };
  const res = await request(
    '/runner/v1/register',
    'POST',
    { 'content-type': 'application/json' },
    JSON.stringify({ token, name: 'r1', labels: ['linux'] }),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { credential: string }).credential;
}

async function claim(credential: string): Promise<Job> {
  const res = await request('/runner/v1/jobs/claim?wait=0', 'POST', bearer(credential));
  expect(res.status).toBe(200);
  return ((await res.json()) as { job: Job }).job;
}

async function finish(credential: string, job: Job): Promise<void> {
  await request(
    `/runner/v1/jobs/${job.id}/steps/0`,
    'POST',
    { ...bearer(credential), 'content-type': 'application/json' },
    JSON.stringify({ state: 'passed', exit_code: 0 }),
  );
  const done = await request(
    `/runner/v1/jobs/${job.id}/complete`,
    'POST',
    { ...bearer(credential), 'content-type': 'application/json' },
    JSON.stringify({ result: 'passed' }),
  );
  expect(done.status).toBe(200);
}

beforeEach(async () => {
  await seedSchema(testEnv);
  await cleanDb(testEnv);
  owner = await loginAs(testEnv, 951, 'olive');
  stranger = await loginAs(testEnv, 952, 'mallory');
  expect((await api('/api/v1/orgs', 'POST', { slug: 'yuma' })).status).toBe(201);
  expect(
    (await api('/api/v1/repos', 'POST', { slug: 'yuma/app', org: 'yuma' })).status,
  ).toBe(201);
  repoId = (await q1<{ id: string }>(
    testEnv,
    "SELECT id FROM repos WHERE slug = 'yuma/app'",
  ))!.id;
  const cs = await commitChanges(testEnv, repoId, {
    first_parent: null,
    message: 'pipeline',
    author: { name: 'Ada', email: 'ada@example.com' },
    changes: [{ path: SPEC, op: 'add', content_b64: btoa(PIPELINE) }],
  });
  await setRef(testEnv, repoId, 'main', cs.changeset.id);
});

describe('run artifacts', () => {
  it('job A uploads, job B of the same run downloads, the run page lists it for 14 days', async () => {
    const credential = await registerRunner();
    const started = await api('/api/v1/repos/yuma/app/ci/pipelines/runs', 'POST', {
      pipeline: SPEC,
    });
    expect(started.status).toBe(202);
    const pipeline = ((await started.json()) as { run: PipelineRun }).run;

    const build = await claim(credential);
    expect(build.job).toBe('build');
    // steps reach the forge with the job token
    expect(build.env.YAG_RUNTIME_URL).toBe(`https://x/runner/v1/jobs/${build.id}`);
    expect(build.env.YAG_RUNTIME_TOKEN).toBe(build.clone.token);

    const bad = await step(build, '/artifacts/..%2Fescape', 'PUT', 'x');
    expect(bad.status).toBe(400);
    const empty = await step(build, '/artifacts/empty.txt', 'PUT', '');
    expect(empty.status).not.toBe(201);
    const uploaded = await step(build, '/artifacts/report.txt', 'PUT', 'hello');
    expect(uploaded.status).toBe(201);
    const { artifact } = (await uploaded.json()) as {
      artifact: { id: string; size: number; created_at: number; expires_at: number };
    };
    expect(artifact.size).toBe(5);
    expect(artifact.expires_at - artifact.created_at).toBe(ARTIFACT_RETENTION_MS);
    // the same job may replace its own artifact
    expect((await step(build, '/artifacts/report.txt', 'PUT', 'hello')).status).toBe(201);
    await finish(credential, build);
    // the job token ends with the job
    expect((await step(build, '/artifacts')).status).toBe(401);

    const test = await claim(credential);
    expect(test.job).toBe('test');
    const listed = (await (await step(test, '/artifacts')).json()) as {
      artifacts: { name: string; job_key: string }[];
    };
    expect(listed.artifacts).toEqual([
      expect.objectContaining({ name: 'report.txt', job_key: 'build' }),
    ]);
    expect(await (await step(test, '/artifacts/report.txt')).text()).toBe('hello');
    // another job of the run cannot replace it
    const clash = await step(test, '/artifacts/report.txt', 'PUT', 'evil');
    expect(clash.status).toBe(409);
    expect(await (await step(test, '/artifacts/report.txt')).text()).toBe('hello');
    expect((await step(test, '/artifacts/missing.txt')).status).toBe(404);

    // the run page
    const page = await api(
      `/api/v1/repos/yuma/app/ci/pipelines/runs/${pipeline.id}/artifacts`,
    );
    expect(page.status).toBe(200);
    const { artifacts } = (await page.json()) as { artifacts: { id: string }[] };
    expect(artifacts).toHaveLength(1);
    const download = await api(`/api/v1/repos/yuma/app/ci/artifacts/${artifacts[0]!.id}`);
    expect(download.status).toBe(200);
    expect(download.headers.get('content-disposition')).toContain('report.txt');
    expect(await download.text()).toBe('hello');
    const perJob = (await (
      await api(`/api/v1/repos/yuma/app/ci/runs/${build.id}/artifacts`)
    ).json()) as { artifacts: unknown[] };
    expect(perJob.artifacts).toHaveLength(1);
    // unreadable repo: 404, anonymous: 401
    expect(
      (
        await api(
          `/api/v1/repos/yuma/app/ci/artifacts/${artifacts[0]!.id}`,
          'GET',
          undefined,
          stranger,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await request(
          `/api/v1/repos/yuma/app/ci/artifacts/${artifacts[0]!.id}`,
          'GET',
          {},
        )
      ).status,
    ).toBe(401);

    // after 14 days the artifact is gone, from the API and then from R2
    const row = (await q1<{ object_key: string }>(
      testEnv,
      'SELECT object_key FROM ci_artifacts WHERE id = ?',
      [artifacts[0]!.id],
    ))!;
    await run(testEnv, 'UPDATE ci_artifacts SET expires_at = ?', [Date.now() - 1]);
    expect(
      (await api(`/api/v1/repos/yuma/app/ci/artifacts/${artifacts[0]!.id}`)).status,
    ).toBe(404);
    await sweepArtifacts(testEnv);
    expect(await testEnv.OBJECTS.head(row.object_key)).toBeNull();
    expect(await q1(testEnv, 'SELECT id FROM ci_artifacts')).toBeNull();
  });

  it('caches round-trip through the job routes and show in the repo listing', async () => {
    const credential = await registerRunner();
    await api('/api/v1/repos/yuma/app/ci/pipelines/runs', 'POST', { pipeline: SPEC });
    const build = await claim(credential);
    expect((await step(build, '/caches?key=deps-1')).status).toBe(204);
    const reserved = await request(
      `/runner/v1/jobs/${build.id}/caches`,
      'POST',
      { ...bearer(build.clone.token), 'content-type': 'application/json' },
      JSON.stringify({ key: 'deps-1' }),
    );
    expect(reserved.status).toBe(201);
    const { cache } = (await reserved.json()) as { cache: { id: string; scope: string } };
    expect(cache.scope).toBe('refs/heads/main');
    expect((await step(build, `/caches/${cache.id}`, 'PUT', 'node_modules')).status).toBe(
      201,
    );
    // entries are immutable
    expect((await step(build, `/caches/${cache.id}`, 'PUT', 'other')).status).toBe(404);
    const hit = await step(build, '/caches?key=deps-2&restore_keys=deps-');
    expect(hit.status).toBe(200);
    expect(hit.headers.get('x-cache-key')).toBe('deps-1');
    expect(await hit.text()).toBe('node_modules');

    const listing = (await (await api('/api/v1/repos/yuma/app/ci/caches')).json()) as {
      caches: { id: string; key: string; state: string }[];
      used_bytes: number;
      quota_bytes: number;
    };
    expect(listing.caches).toEqual([
      expect.objectContaining({ key: 'deps-1', state: 'ready' }),
    ]);
    expect(listing.used_bytes).toBe(12);
    expect(listing.quota_bytes).toBe(10 * 1024 ** 3);
    // deleting needs repo admin and a session; it is audited
    const removed = await api(`/api/v1/repos/yuma/app/ci/caches/${cache.id}`, 'DELETE');
    expect(removed.status).toBe(200);
    expect(
      await q1(testEnv, "SELECT id FROM audit_events WHERE action = 'ci.cache.delete'"),
    ).not.toBeNull();
    expect((await step(build, '/caches?key=deps-1')).status).toBe(204);

    // an object lost from R2 is a miss, and the key can be saved again
    const again = await request(
      `/runner/v1/jobs/${build.id}/caches`,
      'POST',
      { ...bearer(build.clone.token), 'content-type': 'application/json' },
      JSON.stringify({ key: 'deps-3' }),
    );
    const id = ((await again.json()) as { cache: { id: string } }).cache.id;
    expect((await step(build, `/caches/${id}`, 'PUT', 'x')).status).toBe(201);
    const key = (await q1<{ object_key: string }>(
      testEnv,
      'SELECT object_key FROM ci_caches WHERE id = ?',
      [id],
    ))!.object_key;
    await testEnv.OBJECTS.delete(key);
    expect((await step(build, '/caches?key=deps-3')).status).toBe(204);
    const resaved = await request(
      `/runner/v1/jobs/${build.id}/caches`,
      'POST',
      { ...bearer(build.clone.token), 'content-type': 'application/json' },
      JSON.stringify({ key: 'deps-3' }),
    );
    expect(resaved.status).toBe(201);
  });
});
