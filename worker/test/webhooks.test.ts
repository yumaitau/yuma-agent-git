import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { cleanDb, instrumentQueues, makeApp, seedSchema } from './helpers';
import type { TestEnv } from './helpers';
import { C, T } from '../src/db/schema';
import { q, q1, run } from '../src/db/client';
import { createRepo, getRepoBySlug } from '../src/db/repos';
import { appJwt, installationToken, pemToDer } from '../src/bridge/github';
import { sign } from '../src/api/webhooks';

const testEnv = env as unknown as TestEnv;
const dbEnv = testEnv as unknown as Env;
const SECRET = 'test-webhook-secret';

async function webhook(
  body: string,
  opts: {
    event?: string;
    delivery?: string;
    secret?: string;
    skipSig?: boolean;
    env?: TestEnv;
  },
): Promise<Response> {
  const raw = new TextEncoder().encode(body);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-github-event': opts.event ?? 'ping',
    'x-github-delivery': opts.delivery ?? crypto.randomUUID(),
  };
  if (!opts.skipSig) {
    headers['x-hub-signature-256'] = await sign(opts.secret ?? SECRET, raw);
  }
  return makeApp(opts.env ?? testEnv)(
    new Request('https://x/webhooks/github', {
      method: 'POST',
      headers,
      body: raw,
    }),
  );
}

describe('webhook signature contract', () => {
  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
  });

  it('accepts a valid HMAC and routes pings', async () => {
    const res = await webhook(JSON.stringify({ zen: 'hi' }), { event: 'ping' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, pong: true });
  });

  it('rejects tampered bodies, wrong secrets, and missing headers — inert', async () => {
    const probe = instrumentQueues(testEnv);
    const body = JSON.stringify({
      action: 'created',
      installation: { id: 1, account: { login: 'acme', id: 2 } },
    });

    // sign over the original body, deliver a mutated one — one byte of drift
    const raw = new TextEncoder().encode(body);
    const goodSig = await sign(SECRET, raw);
    const mutated = `${body.slice(0, -2)}!!`;
    const res = await makeApp(probe.env)(
      new Request('https://x/webhooks/github', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'installation',
          'x-github-delivery': crypto.randomUUID(),
          'x-hub-signature-256': goodSig,
        },
        body: mutated,
      }),
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'invalid_signature',
    );

    const wrongSecret = await webhook(body, { event: 'installation', secret: 'nope' });
    expect(wrongSecret.status).toBe(401);

    const missing = await webhook(body, { event: 'installation', skipSig: true });
    expect(missing.status).toBe(401);

    // nothing fired: no queue sends, no installation rows
    expect(probe.sends).toEqual([]);
    expect(await q(dbEnv, `SELECT * FROM ${T.installations}`)).toHaveLength(0);
  });

  it('verifies BEFORE parsing: signed-but-invalid JSON → 400', async () => {
    const res = await webhook('this is not json at all', { event: 'push' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'invalid_json',
    );
  });

  it('dedupes deliveries: a replayed delivery id is a no-op', async () => {
    const delivery = 'fixed-delivery-id';
    const body = JSON.stringify({
      action: 'created',
      installation: { id: 5, account: { login: 'acme', id: 5 } },
      repositories: [{ id: 1, full_name: 'acme/app', private: true }],
    });
    const first = await webhook(body, { event: 'installation', delivery });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true });

    const again = await webhook(body, { event: 'installation', delivery });
    expect(await again.json()).toMatchObject({ ok: true, deduped: true });

    const rows = await q(dbEnv, `SELECT * FROM ${T.installations}`);
    expect(rows).toHaveLength(1);
    const deliveries = await q(dbEnv, `SELECT * FROM ${T.webhookDeliveries}`);
    expect(deliveries).toHaveLength(1);
    expect((deliveries[0] as { status: string }).status).toBe('processed');
  });
});

describe('installation lifecycle + push handoff', () => {
  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
  });

  it('tracks created/updated/deleted installations and disconnects repos', async () => {
    const created = JSON.stringify({
      action: 'created',
      installation: { id: 9, account: { login: 'acme', id: 100 } },
      repositories: [{ id: 777, full_name: 'acme/app', private: true }],
    });
    expect((await webhook(created, { event: 'installation' })).status).toBe(200);
    let row = await q1(dbEnv, `SELECT * FROM ${T.installations}`);
    expect(row).toMatchObject({
      installation_id: 9,
      account_login: 'acme',
      repos: JSON.stringify([{ id: 777, full_name: 'acme/app', private: true }]),
    });

    // repositories_added merges into the list
    const added = JSON.stringify({
      action: 'repositories_added',
      installation: { id: 9, account: { login: 'acme', id: 100 } },
      repositories_added: [{ id: 888, full_name: 'acme/other', private: false }],
    });
    await webhook(added, { event: 'installation_repositories' });
    row = await q1(dbEnv, `SELECT * FROM ${T.installations}`);
    expect(JSON.parse((row as { repos: string }).repos)).toHaveLength(2);

    // deleted removes the installation AND disconnects its repos
    const repo = await createRepo(dbEnv, { slug: 'acme/app' });
    await run(
      dbEnv,
      `UPDATE ${T.repos} SET ${C.repos.githubInstallationId} = 9, ${C.repos.githubRepoId} = 777 WHERE ${C.repos.id} = ?`,
      [repo.id],
    );
    const deleted = JSON.stringify({
      action: 'deleted',
      installation: { id: 9, account: { login: 'acme', id: 100 } },
    });
    await webhook(deleted, { event: 'installation' });
    expect(await q1(dbEnv, `SELECT * FROM ${T.installations}`)).toBeNull();
    const afterRepo = await getRepoBySlug(dbEnv, 'acme/app');
    expect(afterRepo?.github_installation_id).toBeNull();
    expect(afterRepo?.github_repo_id).toBeNull();
  });

  it('push on a connected repo queues a sync job; unconnected pushes are ignored', async () => {
    const probe = instrumentQueues(testEnv);
    const repo = await createRepo(dbEnv, { slug: 'acme/app' });
    await run(
      dbEnv,
      `UPDATE ${T.repos} SET ${C.repos.githubRepoId} = 777 WHERE ${C.repos.id} = ?`,
      [repo.id],
    );

    const push = JSON.stringify({
      ref: 'refs/heads/main',
      after: 'a'.repeat(40),
      repository: { id: 777, full_name: 'acme/app' },
    });
    const res = await webhook(push, { event: 'push', env: probe.env });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, queued: true });
    expect(probe.sends).toEqual([
      {
        queue: 'IMPORT_QUEUE',
        body: {
          type: 'github_push',
          repo_id: repo.id,
          github_repo_id: 777,
          ref: 'refs/heads/main',
          after: 'a'.repeat(40),
        },
      },
    ]);

    const stranger = JSON.stringify({
      ref: 'refs/heads/main',
      after: 'b'.repeat(40),
      repository: { id: 999, full_name: 'stranger/repo' },
    });
    const ignored = await webhook(stranger, { event: 'push', env: probe.env });
    expect(await ignored.json()).toMatchObject({ ok: true, ignored: true });
    expect(probe.sends).toHaveLength(1); // nothing extra enqueued

    // unknown events are ignored cleanly
    const unknown = await webhook('{}', { event: 'workflow_run', env: probe.env });
    expect(await unknown.json()).toMatchObject({ ok: true, ignored: 'workflow_run' });
  });
});

describe('app JWT + installation tokens', () => {
  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
  });

  it('mints an RS256 app JWT with iat skew and exp ≤ 10 minutes', async () => {
    const now = 1_700_000_000_000;
    const jwt = await appJwt(dbEnv, now);
    const [header, payload, signature] = jwt.split('.');
    const decode = (part: string): Record<string, unknown> =>
      JSON.parse(
        new TextDecoder().decode(
          Uint8Array.from(atob(part.replace(/-/g, '+').replace(/_/g, '/')), (ch) =>
            ch.charCodeAt(0),
          ),
        ),
      );

    expect(decode(header as string)).toEqual({ alg: 'RS256', typ: 'JWT' });
    const claims = decode(payload as string);
    expect(claims.iss).toBe('12345');
    expect(claims.iat).toBe(Math.floor(now / 1000) - 60); // clock-skew backdate
    expect((claims.exp as number) - (claims.iat as number)).toBeLessThanOrEqual(600);

    // signature verifies against the public half of the test keypair
    const publicKey = await crypto.subtle.importKey(
      'spki',
      pemToDer(testEnv.TEST_GITHUB_APP_PUBLIC_KEY as string) as BufferSource,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    const ok = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      publicKey,
      Uint8Array.from(
        atob((signature as string).replace(/-/g, '+').replace(/_/g, '/')),
        (ch) => ch.charCodeAt(0),
      ) as BufferSource,
      new TextEncoder().encode(`${header}.${payload}`),
    );
    expect(ok).toBe(true);
  });

  it('mints installation tokens, caches them, and re-fetches on 401', async () => {
    const realFetch = globalThis.fetch;
    let mints = 0;
    let failFirst = false;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input as RequestInfo, init);
      if (req.url.includes('/access_tokens')) {
        mints++;
        return new Response(
          JSON.stringify({
            token: `tok-${mints}`,
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (req.url.includes('/installation')) {
        if (failFirst) {
          failFirst = false;
          return new Response('unauthorized', { status: 401 });
        }
        return new Response(JSON.stringify({ id: 55 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected outbound fetch: ${req.url}`);
    }) as typeof fetch;

    try {
      const { githubApi } = await import('../src/bridge/github');
      const first = await installationToken(dbEnv, 551);
      const second = await installationToken(dbEnv, 551);
      expect(first).toBe('tok-1');
      expect(second).toBe('tok-1'); // cache hit — only one mint
      expect(mints).toBe(1);

      // 401 on an API call → cache invalidated, token re-minted, retried once
      failFirst = true;
      const res = await githubApi(dbEnv, 551, '/installation');
      expect(res.status).toBe(200);
      expect(mints).toBe(2);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
