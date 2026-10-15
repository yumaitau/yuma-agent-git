import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { cleanDb, loginAs, makeApp, seedSchema } from './helpers';
import type { TestEnv } from './helpers';
import { C, T } from '../src/db/schema';
import { q, run } from '../src/db/client';
import { createRepo, setRef } from '../src/db/repos';
import { commitChanges } from '../src/core/commit';
import { setSlowThreshold } from '../src/middleware/observe';
import { BUCKETS, bucketFor, shardOf } from '../src/middleware/ratelimit';
import {
  isCacheablePath,
  mintCacheToken,
  verifyCacheToken,
} from '../src/middleware/cachetier';
import { PhaseTimer } from '../src/observability/phase';
import {
  flushMetrics,
  metrics,
  percentiles,
  recordLatency,
  resetMetrics,
} from '../src/observability/metrics';

const testEnv = env as unknown as TestEnv;
const dbEnv = testEnv as unknown as Env;
const author = { name: 'Ada', email: 'ada@example.com' };

describe('rate limiting (sharded sliding window)', () => {
  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
  });

  function shardStub(
    bucket: string,
    key: string,
  ): {
    allow: (now?: number) => Promise<{ allowed: boolean; retry_after_s: number }>;
  } {
    const id = testEnv.RATE_LIMIT.idFromName(`${bucket}:${shardOf(key)}`);
    return {
      allow: async (now?: number) => {
        const stub = testEnv.RATE_LIMIT.get(id);
        const res = await stub.fetch('https://rate-limit/allow', {
          method: 'POST',
          body: JSON.stringify({
            key: `${bucket}:${key}`,
            bucket,
            limit: (BUCKETS as Record<string, number>)[bucket],
          }),
        });
        void now;
        return (await res.json()) as { allowed: boolean; retry_after_s: number };
      },
    };
  }

  it('allows the exact bucket limit then 429s with retry_after', async () => {
    const window = shardStub('auth', 'user-1');
    for (let i = 0; i < BUCKETS.auth; i++) {
      expect((await window.allow()).allowed).toBe(true);
    }
    const denied = await window.allow();
    expect(denied.allowed).toBe(false);
    expect(denied.retry_after_s).toBeGreaterThan(0);
    expect(denied.retry_after_s).toBeLessThanOrEqual(60);
  });

  it('slides the window (still limited at 59s, open again at 61s)', async () => {
    const userKey = `slide-${crypto.randomUUID()}`;
    const id = testEnv.RATE_LIMIT.idFromName(`api_read:${userKey}`);
    const stub = testEnv.RATE_LIMIT.get(id);
    const t0 = Date.now();
    const allow = async (
      t: number,
    ): Promise<{ allowed: boolean; retry_after_s: number }> =>
      (await (
        await stub.fetch('https://rate-limit/allow', {
          method: 'POST',
          body: JSON.stringify({
            key: `api_read:${userKey}`,
            bucket: 'api_read',
            limit: 1,
            now: t,
          }),
        })
      ).json()) as { allowed: boolean; retry_after_s: number };

    expect((await allow(t0)).allowed).toBe(true);
    const at59 = await allow(t0 + 59_000);
    expect(at59.allowed).toBe(false);
    expect(at59.retry_after_s).toBe(1);
    expect((await allow(t0 + 61_000)).allowed).toBe(true);
  });

  it('shards across DOs (≥8 of 16 shards over 100 principals)', () => {
    const shards = new Set<number>();
    for (let i = 0; i < 100; i++) shards.add(shardOf(`user-${i}`));
    expect(shards.size).toBeGreaterThanOrEqual(8);
  });

  it('buckets routes as specced; webhooks are exempt', () => {
    expect(bucketFor('GET', '/api/v1/repos/x/file')).toBe('api_read');
    expect(bucketFor('POST', '/api/v1/repos/x/changesets')).toBe('api_write');
    expect(bucketFor('POST', '/api/v1/repos/x/agents/mcp')).toBe('agent_run');
    expect(bucketFor('POST', '/api/v1/repos/x/fetch-objects')).toBe('object_fetch');
    expect(bucketFor('GET', '/api/v1/repos/x/object/blob/abc')).toBe('object_fetch');
    expect(bucketFor('GET', '/auth/github')).toBe('auth');
    expect(bucketFor('POST', '/webhooks/github')).toBeNull();
  });

  it('commit write bursts are guarded (429 write_too_large)', async () => {
    const auth = await loginAs(testEnv, 1, 'ada');
    const repo = await createRepo(dbEnv, {
      slug: 'acme/big',
      visibility: 'public',
      createdBy: auth.userId,
    });
    await run(
      dbEnv,
      `INSERT INTO ${T.repoMembers} (${C.repoMembers.repoId}, ${C.repoMembers.userId}, ${C.repoMembers.role}) VALUES (?, ?, 'write')`,
      [repo.id, auth.userId],
    );
    const changes = Array.from({ length: 1001 }, (_, i) => ({
      path: `f${i}.txt`,
      op: 'add' as const,
      content_b64: 'x',
    }));
    const res = await makeApp(testEnv)(
      new Request('https://x/api/v1/repos/acme/big/changesets', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: auth.cookie },
        body: JSON.stringify({
          first_parent: null,
          message: 'too big',
          author: { name: 'a', email: 'a@b.c' },
          changes,
        }),
      }),
    );
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'write_too_large',
    );
    void testEnv;
  });
});

describe('cache tier', () => {
  it('signed-in and private reads never reach the shared cache', async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
    const auth = await loginAs(testEnv, 1, 'ada');
    const repo = await createRepo(dbEnv, {
      slug: 'acme/cache',
      visibility: 'public',
      createdBy: auth.userId,
    });
    const committed = await commitChanges(dbEnv, repo.id, {
      first_parent: null,
      message: 'seed',
      author,
      changes: [{ path: 'a.txt', op: 'add', content_b64: btoa('cached') }],
    });
    await setRef(dbEnv, repo.id, 'main', committed.changeset.id);

    // public + content-addressed, but every reader is signed in now, so the
    // shared cache must never hold it
    const url = `https://x/api/v1/repos/acme/cache/file?cs=${committed.changeset.id}&path=a.txt`;
    const first = await makeApp(testEnv)(new Request(url, { headers: auth.headers }));
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('private, no-store');
    await first.arrayBuffer();
    await new Promise((resolve) => setTimeout(resolve, 10)); // waitUntil flush
    expect(await caches.default.match(new Request(url))).toBeFalsy();
    expect((await makeApp(testEnv)(new Request(url))).status).toBe(401);

    // private repo → no-store even with an immutable URL shape
    const priv = await createRepo(dbEnv, { slug: 'acme/priv' });
    const privCommit = await commitChanges(dbEnv, priv.id, {
      first_parent: null,
      message: 'seed',
      author,
      changes: [{ path: 'p.txt', op: 'add', content_b64: btoa('secret') }],
    });
    const privUrl = `https://x/api/v1/repos/acme/priv/file?cs=${privCommit.changeset.id}&path=p.txt`;
    const privRes = await makeApp(testEnv)(
      new Request(privUrl, { headers: auth.headers }),
    );
    expect(privRes.status).toBe(404);
    await privRes.arrayBuffer();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await caches.default.match(new Request(privUrl))).toBeFalsy();
  });

  it('cache tokens mint, verify, expire, and resist tampering', async () => {
    const key = 'test-signing-key';
    const { token } = await mintCacheToken(
      key,
      'https://x/api/v1/repos/acme/file?cs=a',
      1_700_000_000_000,
    );
    expect(
      await verifyCacheToken(
        key,
        'https://x/api/v1/repos/acme/file?cs=a',
        token,
        1_700_000_000_000,
      ),
    ).toBe(true);
    // tampered url / token / expiry all fail
    expect(
      await verifyCacheToken(
        key,
        'https://x/api/v1/repos/acme/file?cs=B',
        token,
        1_700_000_000_000,
      ),
    ).toBe(false);
    const tampered = token.replace(/^([0-9]+)(.)(.+)$/, (_m, exp, sep, mac) => {
      const flipped = (mac as string).split('');
      flipped[0] = flipped[0] === 'a' ? 'b' : 'a';
      return `${exp as string}${sep as string}${flipped.join('')}`;
    });
    expect(tampered).not.toBe(token);
    expect(
      await verifyCacheToken(
        key,
        'https://x/api/v1/repos/acme/file?cs=a',
        tampered,
        1_700_000_000_000,
      ),
    ).toBe(false);
    expect(
      await verifyCacheToken(
        key,
        'https://x/api/v1/repos/acme/file?cs=a',
        token,
        1_700_000_000_000 + 2 * 60 * 60 * 1000,
      ),
    ).toBe(false); // expired
    expect(isCacheablePath('/api/v1/repos/x/file')).toBe(true);
    expect(isCacheablePath('/api/v1/repos/x/changesets')).toBe(false);
  });

  it('signed cache tokens allow caching a private read (the cacheable-URL case)', async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
    const auth = await loginAs(testEnv, 1, 'ada');
    const repo = await createRepo(dbEnv, {
      slug: 'acme/signed',
      visibility: 'private',
      createdBy: auth.userId,
    });
    const committed = await commitChanges(dbEnv, repo.id, {
      first_parent: null,
      message: 'seed',
      author,
      changes: [{ path: 's.txt', op: 'add', content_b64: btoa('signed') }],
    });
    await run(
      dbEnv,
      `INSERT INTO ${T.repoMembers} (${C.repoMembers.repoId}, ${C.repoMembers.userId}, ${C.repoMembers.role}) VALUES (?, ?, 'read')`,
      [repo.id, auth.userId],
    );

    const minted = await makeApp(testEnv)(
      new Request('https://x/api/v1/cache-token', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: auth.cookie },
        body: JSON.stringify({
          url: `https://x/api/v1/repos/acme/signed/file?cs=${committed.changeset.id}&path=s.txt`,
        }),
      }),
    );
    expect(minted.status).toBe(200);
    const { token } = (await minted.json()) as { token: string };

    const url = `https://x/api/v1/repos/acme/signed/file?cs=${committed.changeset.id}&path=s.txt&cache_token=${token}`;
    const { verifyCacheToken: verify } = await import('../src/middleware/cachetier');
    const stripped = new URL(url);
    stripped.searchParams.delete('cache_token');
    expect(await verify('test-cache-signing-key', stripped.toString(), token)).toBe(true);
    const res = await makeApp(testEnv)(new Request(url, { headers: auth.headers }));
    expect(res.status).toBe(200);
    // The signed entry round-trips only for an authorized caller; neither
    // anonymous requests nor unsigned reads can use it.
    expect(res.headers.get('x-yag-cache')).toBe('miss');
    await res.arrayBuffer();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const cached = await makeApp(testEnv)(new Request(url, { headers: auth.headers }));
    expect(cached.status).toBe(200);
    expect(cached.headers.get('x-yag-cache')).toBe('hit');
    expect(cached.headers.get('cache-control')).toBe('private, no-store');
    await cached.arrayBuffer();
    const anonymous = await makeApp(testEnv)(new Request(url));
    expect(anonymous.status).toBe(401);
    // without the token, the same URL is strictly no-store
    const bare = await makeApp(testEnv)(
      new Request(
        `https://x/api/v1/repos/acme/signed/file?cs=${committed.changeset.id}&path=s.txt`,
        { headers: auth.headers },
      ),
    );
    expect(bare.headers.get('x-yag-cache')).toBe('bypass');
    expect(bare.headers.get('cache-control')).toBe('private, no-store');
  });
});

describe('observability + metrics', () => {
  it('phase timer attributes time per phase', async () => {
    const timer = new PhaseTimer();
    await timer.time('d1', async () => new Promise((resolve) => setTimeout(resolve, 5)));
    await timer.time('r2', async () => new Promise((resolve) => setTimeout(resolve, 5)));
    const phases = timer.phases();
    expect(phases.d1_ms).toBeGreaterThanOrEqual(4);
    expect(phases.r2_ms).toBeGreaterThanOrEqual(4);
    expect(phases.ai_ms).toBeUndefined();
  });

  it('reservoir percentiles are exact over known distributions', () => {
    const reservoir = { samples: [] as number[] };
    for (let i = 1; i <= 100; i++) recordLatency(reservoir, i);
    const stats = percentiles(reservoir.samples);
    expect(stats.count).toBe(100);
    expect(stats.p50).toBe(51);
    expect(stats.p99).toBe(100);
  });

  it('cron flush writes sane component_metrics rows the superfans read', async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
    resetMetrics();

    metrics.commit(12);
    metrics.commit(24);
    metrics.importJob('active');
    metrics.queueDispatch();
    metrics.refMove(true);
    metrics.agentTask('landed');
    metrics.aiTurn(100);
    await flushMetrics(dbEnv, Date.now());

    const rows = await q(dbEnv, `SELECT * FROM ${T.componentMetrics}`);
    expect(rows.length).toBeGreaterThanOrEqual(6); // one row per component
    const commitRow = rows.find(
      (r) => (r as { component: string }).component === 'commit-path',
    ) as { json: string };
    const commit = JSON.parse(commitRow.json) as { count: number; p50: number };
    expect(commit.count).toBe(2);
    expect(commit.p50).toBeGreaterThan(0);

    // the admin view reads the same rows
    const auth = await loginAs(testEnv, 1, 'ada');
    const repo = await createRepo(dbEnv, {
      slug: 'acme/admin',
      visibility: 'private',
      createdBy: auth.userId,
    });
    void repo;
    const view = await makeApp(testEnv)(
      new Request('https://x/api/v1/admin/metrics?window=3600000', {
        headers: auth.headers,
      }),
    );
    expect(view.status).toBe(200);
    expect(((await view.json()) as { rows: unknown[] }).rows.length).toBeGreaterThan(0);

    // an idle isolate must not write zero-value rows (they poison the baseline)
    await run(dbEnv, `DELETE FROM ${T.componentMetrics}`);
    resetMetrics();
    await flushMetrics(dbEnv, Date.now());
    expect(await q(dbEnv, `SELECT * FROM ${T.componentMetrics}`)).toHaveLength(0);
  });

  it('request ids propagate and slow requests log phase timings', async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
    setSlowThreshold(0);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const auth = await loginAs(testEnv, 1, 'ada');
      const res = await makeApp(testEnv)(
        new Request('https://x/api/v1/repos', { headers: auth.headers }),
      );
      expect(res.status).toBe(200);
      const requestId = res.headers.get('x-request-id');
      expect(requestId).toMatch(/[0-9a-f-]{36}/);
      const slow = spy.mock.calls
        .map(
          (call) =>
            JSON.parse(String(call[0])) as {
              slow?: boolean;
              request_id?: string;
              d1_ms?: number;
            },
        )
        .find((row) => row.slow === true);
      expect(slow?.request_id).toBe(requestId);
      expect(slow?.d1_ms).toBeGreaterThanOrEqual(0);
    } finally {
      setSlowThreshold(2000);
      spy.mockRestore();
    }
  });

  it('commits leave a commit-path sample the superfans read', async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
    resetMetrics();
    const auth = await loginAs(testEnv, 1, 'ada');
    const repo = await createRepo(dbEnv, {
      slug: 'acme/sampled',
      visibility: 'public',
      createdBy: auth.userId,
    });
    await commitChanges(dbEnv, repo.id, {
      first_parent: null,
      message: 'seed',
      author,
      changes: [{ path: 'a.txt', op: 'add', content_b64: btoa('hi') }],
    });
    const rows = await q(
      dbEnv,
      `SELECT * FROM ${T.componentMetrics} WHERE ${C.componentMetrics.component} = 'commit-path'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    const sample = JSON.parse((rows[0] as { json: string }).json) as { value: number };
    expect(sample.value).toBeGreaterThanOrEqual(0);
  });
});
