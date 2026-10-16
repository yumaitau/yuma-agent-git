import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { cleanDb, loginAs, makeApp, seedSchema, sha256, type TestEnv } from './helpers';
import { createRepo, setRef } from '../src/db/repos';
import { commitChanges } from '../src/core/commit';
import { q, q1, run } from '../src/db/client';
import { createApiToken } from '../src/auth/tokens';
import { createRequestToken } from '../src/ci/oidc';
import type { ForgeEvent } from '../src/webhooks/events';
import type { Release } from '../shared/releases';
import {
  envelopeSchema,
  jwksSchema,
  uncovered,
  verifyEnvelope as verifyOffline,
} from '../../cli/src/release';

/**
 * Releases (issue #54): releases on tags with two assets, drafts hidden from
 * readers, assets checked against their stored SHA-256, generated notes,
 * SLSA provenance from a CI ID token, the org size cap, agent scopes and
 * guardrails, and `release` webhook events.
 */

const testEnv = env as unknown as TestEnv;
const dbEnv = testEnv as unknown as Env;
const author = { name: 'Ada', email: 'ada@example.com' };
type Actor = { headers: Record<string, string> };

let owner: Actor & { userId: string };
let reader: Actor;
let writer: Actor;
let orgId = '';
let repoId = '';
let v1 = '';
let v2 = '';
let events: ForgeEvent[] = [];
let signingKey: JsonWebKey;

async function newKey(kid: string): Promise<JsonWebKey> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  return {
    ...((await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey),
    kid,
  } as JsonWebKey;
}

function bindings(): Env {
  const values: Record<string, unknown> = {
    EVENTS_QUEUE: { send: async (m: { event: ForgeEvent }) => void events.push(m.event) },
    CI_ENABLED: 'true',
    CI_QUEUE: { send: async () => {} },
    CI_RUNNER: {
      idFromName: (id: string) => id,
      get: () => ({ fetch: async () => Response.json({ ok: true }) }),
    },
    CI_OIDC_SIGNING_KEYS: JSON.stringify({ keys: [signingKey] }),
  };
  return new Proxy(testEnv, {
    get: (target, key, receiver) =>
      typeof key === 'string' && key in values
        ? values[key]
        : Reflect.get(target, key, receiver),
  });
}

async function call(
  actor: Actor,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const raw = body instanceof Uint8Array;
  // in-process Requests carry no Content-Length; a real client always sends one
  if (raw) headers = { 'content-length': String(body.byteLength), ...headers };
  return makeApp(bindings())(
    new Request(`https://forge.test${path}`, {
      method,
      headers: {
        ...actor.headers,
        ...(body === undefined || raw ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    }),
  );
}

const repoPath = (tail: string): string => `/api/v1/repos/acme/app${tail}`;

async function json<T>(res: Response, status = 200): Promise<T> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  return JSON.parse(text) as T;
}

async function createRelease(body: Record<string, unknown>, as: Actor = owner) {
  return (
    await json<{ release: Release }>(
      await call(as, 'POST', repoPath('/releases'), body),
      201,
    )
  ).release;
}

async function upload(releaseId: string, name: string, text: string, as: Actor = owner) {
  return call(
    as,
    'POST',
    repoPath(`/releases/${releaseId}/assets?name=${name}`),
    new TextEncoder().encode(text),
    { 'content-type': 'application/gzip' },
  );
}

async function commit(parent: string | null, path: string, message: string) {
  return (
    await commitChanges(dbEnv, repoId, {
      first_parent: parent,
      message,
      author,
      changes: [{ path, op: 'add', content_b64: btoa(path) }],
    })
  ).changeset.id;
}

beforeEach(async () => {
  await seedSchema(testEnv);
  await cleanDb(testEnv);
  events = [];
  signingKey ??= await newKey('rel-key');
  owner = await loginAs(testEnv, 5401, 'owner');
  const r = await loginAs(testEnv, 5402, 'reader');
  const w = await loginAs(testEnv, 5403, 'writer');
  reader = r;
  writer = w;
  await json(await call(owner, 'POST', '/api/v1/orgs', { slug: 'acme' }), 201);
  orgId = (await q1<{ id: string }>(dbEnv, "SELECT id FROM orgs WHERE slug = 'acme'"))!
    .id;
  repoId = (
    await createRepo(dbEnv, {
      slug: 'acme/app',
      createdBy: owner.userId,
      ownerKind: 'org',
      ownerId: orgId,
    })
  ).id;
  await run(dbEnv, "INSERT INTO repo_members(repo_id,user_id,role) VALUES (?,?,'read')", [
    repoId,
    r.userId,
  ]);
  await run(
    dbEnv,
    "INSERT INTO repo_members(repo_id,user_id,role) VALUES (?,?,'write')",
    [repoId, w.userId],
  );
  v1 = await commit(null, 'README.md', 'seed');
  v2 = await commit(v1, 'feature.txt', 'Add feature\n\nlong body');
  await setRef(dbEnv, repoId, 'main', v2);
  await setRef(dbEnv, repoId, 'refs/tags/v1.0.0', v1);
  await setRef(dbEnv, repoId, 'refs/tags/v1.1.0', v2);
  await run(
    dbEnv,
    `INSERT INTO webhooks (id, scope, owner_id, url, secret_ciphertext, key_owner, key_version,
                           events, created_by, created_at, updated_at)
     VALUES ('hook', 'repo', ?, 'https://hooks.example.com', 'x', 'x', 1, '["release"]', ?, 0, 0)`,
    [repoId, owner.userId],
  );
});

describe('releases on tags', () => {
  it('creates a release from a tag with two assets and serves them checksummed', async () => {
    const release = await createRelease({ tag: 'v1.1.0', body: 'First cut' });
    expect(release).toMatchObject({
      tag: 'v1.1.0',
      name: 'v1.1.0',
      target_cs: v2,
      draft: false,
      prerelease: false,
      latest: true,
      assets: [],
    });
    expect(release.published_at).not.toBeNull();

    const bodies = { 'app-linux.tar.gz': 'linux build', 'app-mac.tar.gz': 'mac build' };
    for (const [name, text] of Object.entries(bodies)) {
      const { asset } = await json<{ asset: { sha256: string; size: number } }>(
        await upload(release.id, name, text),
        201,
      );
      expect(asset.sha256).toBe(await sha256(new TextEncoder().encode(text)));
      expect(asset.size).toBe(text.length);
    }
    const { release: full } = await json<{ release: Release }>(
      await call(reader, 'GET', repoPath('/releases/tags/v1.1.0')),
    );
    expect(full.assets.map((a) => a.name)).toEqual(Object.keys(bodies));

    for (const asset of full.assets) {
      const res = await call(
        reader,
        'GET',
        repoPath(`/releases/${release.id}/assets/${asset.id}`),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('x-yag-sha256')).toBe(asset.sha256);
      expect(res.headers.get('content-disposition')).toContain('attachment');
      expect(res.headers.get('content-type')).toBe('application/gzip');
      expect(await res.text()).toBe(bodies[asset.name as keyof typeof bodies]);
    }
    const listed = await json<{ releases: Release[] }>(
      await call(reader, 'GET', repoPath('/releases')),
    );
    expect(listed.releases.map((r) => r.tag)).toEqual(['v1.1.0']);
    const latest = await json<{ release: Release }>(
      await call(reader, 'GET', repoPath('/releases/latest')),
    );
    expect(latest.release.id).toBe(release.id);

    const audit = await q<{ action: string }>(
      dbEnv,
      "SELECT action FROM audit_events WHERE action LIKE 'release.%' ORDER BY id",
    );
    expect(audit.map((a) => a.action)).toEqual([
      'release.create',
      'release.asset.upload',
      'release.asset.upload',
    ]);
    expect(events.map((e) => `${e.event}.${e.action}`)).toEqual([
      'release.created',
      'release.published',
    ]);
  });

  it('refuses unknown tags, duplicate releases and duplicate asset names', async () => {
    const missing = await call(owner, 'POST', repoPath('/releases'), { tag: 'v9' });
    expect((await json<{ error: { code: string } }>(missing, 400)).error.code).toBe(
      'unknown_tag',
    );
    const release = await createRelease({ tag: 'v1.0.0' });
    const again = await call(owner, 'POST', repoPath('/releases'), { tag: 'v1.0.0' });
    expect((await json<{ error: { code: string } }>(again, 409)).error.code).toBe(
      'release_exists',
    );
    await json(await upload(release.id, 'a.bin', 'x'), 201);
    const dup = await upload(release.id, 'a.bin', 'y');
    expect((await json<{ error: { code: string } }>(dup, 409)).error.code).toBe(
      'asset_exists',
    );
    const badName = await upload(release.id, '../evil', 'y');
    expect(badName.status).toBe(400);
  });

  it('lets readers read but not write, and hides the repo from strangers', async () => {
    const release = await createRelease({ tag: 'v1.0.0' });
    expect(
      (await call(reader, 'POST', repoPath('/releases'), { tag: 'v1.1.0' })).status,
    ).toBe(403);
    expect((await upload(release.id, 'a.bin', 'x', reader)).status).toBe(403);
    expect(
      (await call(reader, 'PATCH', repoPath(`/releases/${release.id}`), { name: 'x' }))
        .status,
    ).toBe(403);
    const stranger = await loginAs(testEnv, 5409, 'stranger');
    expect((await call(stranger, 'GET', repoPath('/releases'))).status).toBe(404);
    expect((await createRelease({ tag: 'v1.1.0' }, writer)).tag).toBe('v1.1.0');
  });
  it('finds a release by a tag name with a slash, encoded or not', async () => {
    await setRef(dbEnv, repoId, 'refs/tags/release/2.0', v2);
    const created = await createRelease({ tag: 'release/2.0' });
    for (const path of ['/releases/tags/release/2.0', '/releases/tags/release%2F2.0']) {
      const { release } = await json<{ release: Release }>(
        await call(reader, 'GET', repoPath(path)),
      );
      expect(release.id, path).toBe(created.id);
    }
  });
});

describe('drafts', () => {
  it('are hidden from readers without write until published', async () => {
    const draft = await createRelease({ tag: 'v1.1.0', draft: true });
    expect(draft).toMatchObject({ draft: true, latest: false, published_at: null });
    await json(await upload(draft.id, 'app.tar.gz', 'bits'), 201);
    const assetId = (await q1<{ id: string }>(
      dbEnv,
      'SELECT id FROM release_assets WHERE release_id = ?',
      [draft.id],
    ))!.id;
    expect(events.map((e) => e.action)).toEqual(['created']);

    const hidden = await json<{ releases: Release[] }>(
      await call(reader, 'GET', repoPath('/releases')),
    );
    expect(hidden.releases).toEqual([]);
    for (const path of [
      `/releases/${draft.id}`,
      '/releases/tags/v1.1.0',
      '/releases/latest',
      `/releases/${draft.id}/assets/${assetId}`,
      `/releases/${draft.id}/attestations`,
    ])
      expect((await call(reader, 'GET', repoPath(path))).status, path).toBe(404);
    // a reader-scoped token of the owner cannot see it either
    const readToken = (
      await createApiToken(dbEnv, owner.userId, { label: 'ro', scopes: ['repo:read'] })
    ).raw;
    const ro = { headers: { authorization: `Bearer ${readToken}` } };
    expect((await call(ro, 'GET', repoPath(`/releases/${draft.id}`))).status).toBe(404);

    const seen = await json<{ releases: Release[] }>(
      await call(writer, 'GET', repoPath('/releases')),
    );
    expect(seen.releases.map((r) => r.id)).toEqual([draft.id]);

    const published = await json<{ release: Release }>(
      await call(writer, 'PATCH', repoPath(`/releases/${draft.id}`), { draft: false }),
    );
    expect(published.release).toMatchObject({ draft: false, latest: true });
    expect(published.release.published_at).not.toBeNull();
    expect(events.map((e) => e.action)).toEqual(['created', 'published']);
    expect((await call(reader, 'GET', repoPath(`/releases/${draft.id}`))).status).toBe(
      200,
    );
  });

  it('keeps prereleases off the latest pointer', async () => {
    const stable = await createRelease({ tag: 'v1.0.0' });
    const pre = await createRelease({ tag: 'v1.1.0', prerelease: true });
    expect(pre.latest).toBe(false);
    const latest = await json<{ release: Release }>(
      await call(reader, 'GET', repoPath('/releases/latest')),
    );
    expect(latest.release.id).toBe(stable.id);
  });
});

describe('asset checksums', () => {
  it('aborts a download whose stored bytes no longer match their SHA-256', async () => {
    const release = await createRelease({ tag: 'v1.0.0' });
    const { asset } = await json<{ asset: { id: string } }>(
      await upload(release.id, 'app.tar.gz', 'original'),
      201,
    );
    await testEnv.OBJECTS.put(`releases/${repoId}/${release.id}/${asset.id}`, 'tampered');
    const res = await call(
      reader,
      'GET',
      repoPath(`/releases/${release.id}/assets/${asset.id}`),
    );
    expect(res.status).toBe(200);
    await expect(res.text()).rejects.toThrow();
  });

  it('refuses an upload whose bytes differ from the sha256 the client sent', async () => {
    const release = await createRelease({ tag: 'v1.0.0' });
    const res = await call(
      owner,
      'POST',
      repoPath(`/releases/${release.id}/assets?name=a.bin&sha256=${'0'.repeat(64)}`),
      new TextEncoder().encode('bytes'),
    );
    expect((await json<{ error: { code: string } }>(res, 400)).error.code).toBe(
      'checksum_mismatch',
    );
    expect(await q(dbEnv, 'SELECT id FROM release_assets')).toEqual([]);
    const left = await testEnv.OBJECTS.list({ prefix: `releases/${repoId}/` });
    expect(left.objects).toEqual([]);
  });

  it('applies the org asset size cap set by an org owner', async () => {
    expect(
      await json(await call(owner, 'GET', '/api/v1/orgs/acme/release-settings')),
    ).toEqual({ asset_max_bytes: 100 * 1024 * 1024, default: true });
    await json(
      await call(owner, 'PUT', '/api/v1/orgs/acme/release-settings', {
        asset_max_bytes: 4,
      }),
    );
    const release = await createRelease({ tag: 'v1.0.0' });
    const big = await upload(release.id, 'big.bin', '12345');
    expect((await json<{ error: { code: string } }>(big, 413)).error.code).toBe(
      'asset_too_large',
    );
    await json(await upload(release.id, 'ok.bin', '1234'), 201);
    expect(
      (
        await call(writer, 'PUT', '/api/v1/orgs/acme/release-settings', {
          asset_max_bytes: 9,
        })
      ).status,
    ).toBe(404); // not an org member
  });

  it('deletes assets from R2 with the release; the tag stays', async () => {
    const release = await createRelease({ tag: 'v1.0.0' });
    await json(await upload(release.id, 'a.bin', 'a'), 201);
    expect(
      (await call(owner, 'DELETE', repoPath(`/releases/${release.id}`))).status,
    ).toBe(204);
    expect(
      (await testEnv.OBJECTS.list({ prefix: `releases/${repoId}/` })).objects,
    ).toEqual([]);
    expect(
      await q1(
        dbEnv,
        "SELECT name FROM refs WHERE repo_id = ? AND name = 'refs/tags/v1.0.0'",
        [repoId],
      ),
    ).not.toBeNull();
    expect(events.at(-1)?.action).toBe('deleted');
  });
});

describe('generated notes', () => {
  it('lists merged pull requests and other commits since the previous release', async () => {
    await createRelease({ tag: 'v1.0.0' });
    const fix = await commit(v2, 'fix.txt', 'Fix crash on start');
    await setRef(dbEnv, repoId, 'refs/tags/v1.2.0', fix);
    const now = Date.now();
    await run(
      dbEnv,
      `INSERT INTO pull_requests (repo_id, number, title, body, author_id, base_ref, base_cs,
         head_cs, state, created_at, updated_at, merged_at, merged_cs)
       VALUES (?, 7, 'Add feature', '', ?, 'main', ?, ?, 'merged', ?, ?, ?, ?)`,
      [repoId, owner.userId, v1, v2, now, now, now, v2],
    );
    const notes = await json<{
      body: string;
      previous_tag: string;
      changesets: number;
      pulls: number[];
    }>(
      await call(writer, 'POST', repoPath('/releases/generate-notes'), { tag: 'v1.2.0' }),
    );
    expect(notes.previous_tag).toBe('v1.0.0');
    expect(notes.changesets).toBe(2);
    expect(notes.pulls).toEqual([7]);
    expect(notes.body).toContain("## What's changed\n\n- Add feature (#7) by @owner");
    expect(notes.body).toContain(`- ${fix.slice(0, 12)} Fix crash on start`);
    expect(notes.body).not.toContain('seed');
    expect(notes.body).toContain('**Full changelog**: v1.0.0...v1.2.0');

    const release = await createRelease({
      tag: 'v1.2.0',
      body: 'Intro',
      generate_notes: true,
    });
    expect(release.body.startsWith('Intro\n\n## What')).toBe(true);
    expect(
      (
        await call(reader, 'POST', repoPath('/releases/generate-notes'), {
          tag: 'v1.2.0',
        })
      ).status,
    ).toBe(403);
  });
});

describe('build provenance', () => {
  async function ciToken(tag: string, audience = 'yag:attest'): Promise<string> {
    const configured = await call(owner, 'PUT', repoPath('/ci'), {
      commands: ['npm test'],
      timeout_seconds: 60,
      permissions: { id_token: 'write' },
    });
    expect(configured.status).toBe(200);
    const started = await json<{ run: { id: string } }>(
      await call(owner, 'POST', repoPath('/ci/runs'), { head: tag }),
      202,
    );
    await run(dbEnv, "UPDATE ci_runs SET state = 'running', deadline = ? WHERE id = ?", [
      Date.now() + 60_000,
      started.run.id,
    ]);
    const request = await createRequestToken(dbEnv, started.run.id, Date.now() + 60_000);
    const res = await makeApp(bindings())(
      new Request(`https://forge.test/ci/oidc/token?audience=${audience}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${request}` },
      }),
    );
    const { value } = await json<{ value: string }>(res);
    // the job may finish before its attest step's request lands
    await run(dbEnv, "UPDATE ci_runs SET state = 'passed' WHERE id = ?", [
      started.run.id,
    ]);
    return value;
  }

  it('signs SLSA provenance from a CI ID token that verifies online and offline', async () => {
    const release = await createRelease({ tag: 'v1.1.0' });
    await json(await upload(release.id, 'app.tar.gz', 'bits'), 201);
    await json(await upload(release.id, 'app.zip', 'zip bits'), 201);
    const token = await ciToken('v1.1.0');
    const { attestation } = await json<{
      attestation: { id: string; envelope: unknown; subjects: unknown[] };
    }>(
      await call(writer, 'POST', repoPath(`/releases/${release.id}/attestations`), {
        id_token: token,
      }),
      201,
    );
    expect(attestation.subjects).toHaveLength(2);
    const envelope = envelopeSchema.parse(attestation.envelope);
    const statement = JSON.parse(atob(envelope.payload)) as {
      subject: { name: string; digest: { sha256: string } }[];
      predicateType: string;
      predicate: {
        buildDefinition: { resolvedDependencies: { digest: Record<string, string> }[] };
        runDetails: { builder: { id: string } };
      };
    };
    expect(statement.predicateType).toBe('https://slsa.dev/provenance/v1');
    expect(statement.subject[0]).toEqual({
      name: 'app.tar.gz',
      digest: { sha256: await sha256(new TextEncoder().encode('bits')) },
    });
    expect(
      statement.predicate.buildDefinition.resolvedDependencies[0]!.digest.yagChangeset,
    ).toBe(v2);
    expect(statement.predicate.runDetails.builder.id).toBe(
      'https://forge.test/ci/oidc/builders/cloudflare',
    );

    // the server verification endpoint
    const digest = statement.subject[1]!.digest.sha256;
    const ok = await json<{ verified: boolean; subject: unknown }>(
      await call(reader, 'POST', repoPath('/attestations/verify'), {
        envelope,
        sha256: digest,
      }),
    );
    expect(ok).toMatchObject({ verified: true, subject: { name: 'app.zip' } });
    const tampered = {
      ...envelope,
      payload: btoa(JSON.stringify({ ...statement, subject: [] })),
    };
    expect(
      await json(
        await call(reader, 'POST', repoPath('/attestations/verify'), {
          envelope: tampered,
        }),
      ),
    ).toMatchObject({ verified: false });

    // `yag release verify` checks the same envelope offline against the JWKS
    const jwks = jwksSchema.parse(
      await (
        await makeApp(bindings())(new Request('https://forge.test/ci/oidc/jwks'))
      ).json(),
    );
    const offline = await verifyOffline(envelope, jwks);
    expect(offline.ok).toBe(true);
    expect((await verifyOffline(tampered, jwks)).ok).toBe(false);
    const { release: full } = await json<{ release: Release }>(
      await call(reader, 'GET', repoPath(`/releases/${release.id}`)),
    );
    expect(full.attestations).toHaveLength(1);
    expect(uncovered(full.assets, offline.ok ? [offline.statement] : [])).toEqual([]);
    expect(
      uncovered(
        [{ name: 'other.bin', sha256: digest }],
        offline.ok ? [offline.statement] : [],
      ),
    ).toEqual(['other.bin']);
    const audit = await q1<{ target: string }>(
      dbEnv,
      "SELECT target FROM audit_events WHERE action = 'release.attest'",
    );
    expect(JSON.parse(audit!.target)).toMatchObject({ release_id: release.id });
  });

  it('refuses tokens for another audience, forged tokens and other source', async () => {
    const release = await createRelease({ tag: 'v1.0.0' });
    await json(await upload(release.id, 'app.tar.gz', 'bits'), 201);
    const attest = (id_token: string) =>
      call(owner, 'POST', repoPath(`/releases/${release.id}/attestations`), { id_token });
    const aws = await ciToken('v1.0.0', 'sts.amazonaws.com');
    expect(
      (await json<{ error: { code: string } }>(await attest(aws), 400)).error.code,
    ).toBe('invalid_id_token');
    const [h, p] = (await ciToken('v1.0.0')).split('.');
    expect(
      (await json<{ error: { code: string } }>(await attest(`${h}.${p}.AAAA`), 400)).error
        .code,
    ).toBe('invalid_id_token');
    // a build of v1.1.0's source cannot attest the v1.0.0 release
    const other = await ciToken('v1.1.0');
    expect(
      (await json<{ error: { code: string } }>(await attest(other), 409)).error.code,
    ).toBe('provenance_source_mismatch');
    expect(await q(dbEnv, 'SELECT id FROM release_attestations')).toEqual([]);
  });
});

describe('agents', () => {
  let delegate = '';

  async function agent(scope: string): Promise<Actor> {
    const created = await call(owner, 'POST', '/api/v1/agents', {
      name: 'Releaser',
      kind: 'codex',
      max_risk: 'high',
      max_scopes: ['contents:read', 'contents:write', 'releases:write'],
    });
    const { id } = await json<{ id: string }>(created, 201);
    const res = await makeApp(bindings())(
      new Request('https://forge.test/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
          subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
          subject_token: delegate,
          agent_id: id,
          resource: 'acme/app',
          scope,
        }),
      }),
    );
    const token = (await json<{ access_token: string }>(res)).access_token;
    return { headers: { authorization: `Bearer ${token}` } };
  }

  beforeEach(async () => {
    delegate = (
      await createApiToken(dbEnv, owner.userId, {
        label: 'delegate',
        scopes: ['repo:read', 'repo:write', 'agent:run'],
      })
    ).raw;
  });

  it('need releases:write, prepare drafts freely and stop at the kill switch', async () => {
    const noScope = await agent('contents:read contents:write');
    const refused = await call(noScope, 'POST', repoPath('/releases'), { tag: 'v1.0.0' });
    expect((await json<{ error: { code: string } }>(refused, 403)).error.code).toBe(
      'insufficient_scope',
    );
    // drafts are hidden, so an agent prepares one without approval
    const releaser = await agent('contents:read contents:write releases:write');
    const release = await createRelease({ tag: 'v1.0.0', draft: true }, releaser);
    await json(await upload(release.id, 'a.bin', 'x', releaser), 201);
    await run(
      dbEnv,
      "INSERT INTO agent_pauses (scope_id, paused_by, reason, paused_at) VALUES (?, ?, 'incident', ?)",
      [orgId, owner.userId, Date.now()],
    );
    // a paused agent's token stops resolving at once
    const paused = await call(releaser, 'PATCH', repoPath(`/releases/${release.id}`), {
      draft: false,
    });
    expect(paused.status).toBe(401);
    expect(
      (await q1<{ draft: number }>(dbEnv, 'SELECT draft FROM releases'))!.draft,
    ).toBe(1);
  });

  it('need a person to approve publishing (default policy pack)', async () => {
    const releaser = await agent('contents:read contents:write releases:write');
    const publish = () =>
      call(releaser, 'POST', repoPath('/releases'), { tag: 'v1.0.0' });
    const held = await json<{ error: { code: string; approval: { id: string } } }>(
      await publish(),
      403,
    );
    expect(held.error.code).toBe('approval_required');
    expect(await q(dbEnv, 'SELECT id FROM releases')).toEqual([]);
    await json(
      await call(owner, 'POST', repoPath(`/approvals/${held.error.approval.id}`), {
        decision: 'approve',
      }),
    );
    expect((await json<{ release: Release }>(await publish(), 201)).release.draft).toBe(
      false,
    );
  });
});
