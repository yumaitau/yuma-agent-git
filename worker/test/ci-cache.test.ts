import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { cleanDb, seedSchema, type TestEnv } from './helpers';
import { createRepo } from '../src/db/repos';
import { q, q1, run } from '../src/db/client';
import {
  cacheScopes,
  evictCaches,
  reserveCache,
  restoreCache,
  sweepCaches,
  uploadCache,
  CACHE_IDLE_MS,
} from '../src/ci/cache';
import type { CiRun } from '../src/ci/config';
import type { RunContext } from '../src/ci/context';

/**
 * Dependency cache isolation (issue #51): a job writes only its own scope and
 * reads it and the default branch's, so a pull request cannot poison `main`.
 */
const testEnv = env as unknown as TestEnv;
let repoId = '';
let orgId = '';

function context(event: RunContext['event'], ref: string | null, pull: number | null = null) {
  return JSON.stringify({
    event,
    ref,
    pull_id: pull,
    fork: false,
    actor_kind: 'human',
    origin: 'https://x',
    approval_id: null,
  });
}

/** A running job for `ctx`, as the pipeline planner would admit it. */
async function job(ctx: string): Promise<CiRun> {
  const id = crypto.randomUUID();
  await run(
    testEnv,
    `INSERT INTO ci_runs (id, repo_id, head_cs, settings_version, config, requested_by, state, month, reserved_micros, created_at, context)
    VALUES (?, ?, 'cs', 0, '{}', 'u', 'running', '2026-10', 0, ?, ?)`,
    [id, repoId, Date.now(), ctx],
  );
  return (await q1<CiRun>(testEnv, 'SELECT * FROM ci_runs WHERE id = ?', [id]))!;
}

function stream(text: string): ReadableStream<Uint8Array> {
  return new Response(text).body!;
}

async function save(j: CiRun, key: string, body: string) {
  const reserved = await reserveCache(testEnv, j, key);
  return uploadCache(testEnv, j, reserved.id, stream(body));
}

const main = () => job(context('push', 'refs/heads/main'));
const pull = (n: number, ref = `refs/pull/${n}/merge`) =>
  job(context('pull_request', ref, n));

beforeEach(async () => {
  await seedSchema(testEnv);
  await cleanDb(testEnv);
  orgId = crypto.randomUUID();
  await run(
    testEnv,
    "INSERT INTO orgs (id, slug, display_name, created_at) VALUES (?, 'yuma', 'Yuma', 0)",
    [orgId],
  );
  const repo = await createRepo(testEnv, { slug: 'yuma/app' });
  repoId = repo.id;
  await run(testEnv, "UPDATE repos SET owner_kind = 'org', owner_id = ? WHERE id = ?", [
    orgId,
    repoId,
  ]);
});

describe('cache scopes', () => {
  it('maps each trigger to its own write scope and reads the default branch after it', async () => {
    const scopes = (ctx: string) => cacheScopes({ context: ctx, head_cs: 'abc' } as CiRun, 'main');
    expect(scopes(context('push', 'refs/heads/main'))).toEqual({
      write: 'refs/heads/main',
      read: ['refs/heads/main'],
    });
    expect(scopes(context('push', 'refs/heads/feature'))).toEqual({
      write: 'refs/heads/feature',
      read: ['refs/heads/feature', 'refs/heads/main'],
    });
    expect(scopes(context('pull_request', 'refs/pull/7/merge', 7)).write).toBe('refs/pull/7');
    // a pull request job never writes a branch scope, whatever ref it carries
    expect(scopes(context('pull_request', 'refs/heads/main', 7)).write).toBe('refs/pull/7');
    expect(scopes(context('merge_group', 'refs/merge-queue/main/g1')).write).toBe(
      'refs/merge-queue/main/g1',
    );
    expect(scopes(context('push', null)).write).toBe('revision/abc');
  });
});

describe('cache isolation', () => {
  it('a pull request job cannot write a cache entry a main job reads', async () => {
    const pr = await pull(7);
    const poisoned = await save(pr, 'deps-1', 'evil');
    expect(poisoned.scope).toBe('refs/pull/7');
    // the same PR reads its own entry
    expect((await restoreCache(testEnv, pr, 'deps-1', []))?.id).toBe(poisoned.id);
    // main and another PR never see it, exact key or prefix
    const m = await main();
    expect(await restoreCache(testEnv, m, 'deps-1', ['deps-'])).toBeNull();
    expect(await restoreCache(testEnv, await pull(8), 'deps-1', ['deps-'])).toBeNull();
    // a PR job whose context claims the main ref still writes its PR scope
    const sneaky = await pull(9, 'refs/heads/main');
    expect((await save(sneaky, 'deps-2', 'evil')).scope).toBe('refs/pull/9');
    expect(await restoreCache(testEnv, m, 'deps-2', [])).toBeNull();
  });

  it('pull requests and branches read the default branch cache, own scope first', async () => {
    const m = await main();
    const base = await save(m, 'deps-abc', 'main deps');
    const pr = await pull(7);
    const hit = await restoreCache(testEnv, pr, 'deps-xyz', ['deps-']);
    expect(hit?.id).toBe(base.id);
    const own = await save(pr, 'deps-pr', 'pr deps');
    expect((await restoreCache(testEnv, pr, 'deps-xyz', ['deps-']))?.id).toBe(own.id);
    // exact key in the default branch beats nothing
    expect((await restoreCache(testEnv, pr, 'deps-abc', []))?.id).toBe(base.id);
  });

  it('entries are immutable: one reservation per key and scope, uploaded once', async () => {
    const m = await main();
    const reserved = await reserveCache(testEnv, m, 'k');
    await expect(reserveCache(testEnv, m, 'k')).rejects.toMatchObject({
      code: 'cache_exists',
    });
    await uploadCache(testEnv, m, reserved.id, stream('a'));
    await expect(uploadCache(testEnv, m, reserved.id, stream('b'))).rejects.toMatchObject({
      code: 'cache_not_found',
    });
    // another job cannot upload into someone else's reservation
    const other = await main();
    const pending = await reserveCache(testEnv, other, 'k2');
    await expect(uploadCache(testEnv, m, pending.id, stream('x'))).rejects.toMatchObject({
      code: 'cache_not_found',
    });
    // a reservation whose job ended without uploading frees the key
    await run(testEnv, "UPDATE ci_runs SET state = 'passed' WHERE id = ?", [other.id]);
    expect((await reserveCache(testEnv, m, 'k2')).ci_run_id).toBe(m.id);
    await expect(reserveCache(testEnv, m, 'bad key')).rejects.toMatchObject({
      code: 'invalid_cache_key',
    });
  });
});

describe('cache quota and retention', () => {
  it('evicts least recently used entries to keep each repo under its quota', async () => {
    await run(
      testEnv,
      `INSERT INTO org_ci_limits (org_id, max_concurrent, monthly_budget_usd, max_timeout_s, instance_types, cache_quota_bytes, updated_by, updated_at)
      VALUES (?, 2, 5, 600, '["standard-2"]', 10, 'u', 0)`,
      [orgId],
    );
    const m = await main();
    const a = await save(m, 'a', '1234');
    const b = await save(m, 'b', '1234');
    // using `a` makes `b` the least recently used
    await run(testEnv, 'UPDATE ci_caches SET last_used_at = last_used_at - 1000 WHERE id = ?', [
      b.id,
    ]);
    await restoreCache(testEnv, m, 'a', []);
    await save(m, 'c', '1234');
    const left = await q<{ key: string }>(
      testEnv,
      "SELECT key FROM ci_caches WHERE state = 'ready' ORDER BY key",
    );
    expect(left.map((r) => r.key)).toEqual(['a', 'c']);
    const used = await q1<{ total: number }>(
      testEnv,
      'SELECT SUM(size) AS total FROM ci_caches WHERE repo_id = ?',
      [repoId],
    );
    expect(used!.total).toBeLessThanOrEqual(10);
    expect(await testEnv.OBJECTS.head(b.object_key)).toBeNull();
    expect(await testEnv.OBJECTS.head(a.object_key)).not.toBeNull();
    // a quota of zero empties the repo on the next eviction
    await run(testEnv, 'UPDATE org_ci_limits SET cache_quota_bytes = 0');
    await evictCaches(testEnv, repoId);
    expect(await q(testEnv, 'SELECT id FROM ci_caches')).toEqual([]);
  });

  it('sweeps entries unused for 7 days', async () => {
    const m = await main();
    const old = await save(m, 'old', 'x');
    await save(m, 'new', 'y');
    await run(testEnv, 'UPDATE ci_caches SET last_used_at = ? WHERE id = ?', [
      Date.now() - CACHE_IDLE_MS - 1,
      old.id,
    ]);
    await sweepCaches(testEnv);
    const left = await q<{ key: string }>(testEnv, 'SELECT key FROM ci_caches');
    expect(left.map((r) => r.key)).toEqual(['new']);
    expect(await testEnv.OBJECTS.head(old.object_key)).toBeNull();
  });
});
