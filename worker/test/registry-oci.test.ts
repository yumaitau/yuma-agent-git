import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { cleanDb, loginAs, makeApp, seedSchema, sha256, type TestEnv } from './helpers';
import { createRepo } from '../src/db/repos';
import { q, q1, run } from '../src/db/client';
import { createApiToken } from '../src/auth/tokens';
import { createRequestToken, issuerFor, signJwt } from '../src/ci/oidc';
import { registryCleanup } from '../src/registry/packages';
import { PART_SIZE } from '../src/registry/storage';
import type { ForgeEvent } from '../src/webhooks/events';

/**
 * OCI registry (issue #53): the Bearer token flow, chunked and monolithic
 * blob uploads, a multi-arch push and pull, referrers (cosign signatures),
 * tags, deletes, permissions from the linked repo, CI job credentials,
 * agent scopes and guardrails, quotas, audit, webhooks and retention.
 */

const testEnv = env as unknown as TestEnv;
const dbEnv = testEnv as unknown as Env;
const HOST = 'forge.test';
const OCI_MANIFEST = 'application/vnd.oci.image.manifest.v1+json';
const OCI_INDEX = 'application/vnd.oci.image.index.v1+json';
const EMPTY = new TextEncoder().encode('{}');

type Login = Awaited<ReturnType<typeof loginAs>>;
let owner: Login;
let reader: Login;
let writer: Login;
let stranger: Login;
let orgId = '';
let repoA = '';
let repoB = '';
let events: ForgeEvent[] = [];
let overrides: Record<string, unknown> = {};
let signingKey: JsonWebKey;

const bindings = new Proxy(testEnv, {
  get: (target, key, receiver) => {
    if (key === 'EVENTS_QUEUE')
      return { send: async (m: { event: ForgeEvent }) => void events.push(m.event) };
    if (typeof key === 'string' && key in overrides) return overrides[key];
    return Reflect.get(target, key, receiver);
  },
}) as unknown as Env;
const app = makeApp(bindings);

function basic(secret: string): string {
  return `Basic ${btoa(`user:${secret}`)}`;
}

async function tokenFor(
  login: Login,
  scopes = ['repo:read', 'repo:write'],
): Promise<string> {
  return basic((await createApiToken(dbEnv, login.userId, { label: 'oci', scopes })).raw);
}

function reg(
  method: string,
  path: string,
  auth?: string,
  init: { body?: BodyInit; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (auth) headers.set('authorization', auth);
  return Promise.resolve(
    app(new Request(`https://${HOST}${path}`, { method, headers, body: init.body })),
  );
}

async function digestOf(bytes: Uint8Array): Promise<string> {
  return `sha256:${await sha256(bytes)}`;
}

function streamOf(bytes: Uint8Array, chunk = 64 * 1024): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(at, at + chunk));
      at += chunk;
    },
  });
}

/** Docker's flow: POST, one streamed PATCH of unknown length, empty PUT with the digest. */
async function pushBlob(name: string, bytes: Uint8Array, auth: string): Promise<string> {
  const start = await reg('POST', `/v2/${name}/blobs/uploads/`, auth);
  expect(start.status, await start.clone().text()).toBe(202);
  const location = start.headers.get('location')!;
  const patch = await reg('PATCH', location, auth, {
    body: streamOf(bytes),
    headers: { 'content-type': 'application/octet-stream' },
  });
  expect(patch.status, await patch.clone().text()).toBe(202);
  const digest = await digestOf(bytes);
  const put = await reg('PUT', `${location}?digest=${digest}`, auth);
  expect(put.status, await put.clone().text()).toBe(201);
  expect(put.headers.get('docker-content-digest')).toBe(digest);
  return digest;
}

async function pushManifest(
  name: string,
  reference: string,
  manifest: unknown,
  auth: string,
  mediaType = OCI_MANIFEST,
): Promise<Response> {
  return reg('PUT', `/v2/${name}/manifests/${reference}`, auth, {
    body: JSON.stringify(manifest),
    headers: { 'content-type': mediaType },
  });
}

/** One platform's image: a config and a layer, then its manifest by digest. */
async function pushImage(
  name: string,
  auth: string,
  arch: string,
): Promise<{ digest: string; size: number; layer: Uint8Array }> {
  const layer = new TextEncoder().encode(`layer for ${arch}\n`.repeat(100));
  const config = new TextEncoder().encode(
    JSON.stringify({ architecture: arch, os: 'linux' }),
  );
  const layerDigest = await pushBlob(name, layer, auth);
  const configDigest = await pushBlob(name, config, auth);
  const manifest = {
    schemaVersion: 2,
    mediaType: OCI_MANIFEST,
    config: {
      mediaType: 'application/vnd.oci.image.config.v1+json',
      digest: configDigest,
      size: config.length,
    },
    layers: [
      {
        mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
        digest: layerDigest,
        size: layer.length,
      },
    ],
  };
  const bytes = new TextEncoder().encode(JSON.stringify(manifest));
  const digest = await digestOf(bytes);
  const res = await pushManifest(name, digest, manifest, auth);
  expect(res.status, await res.clone().text()).toBe(201);
  return { digest, size: bytes.length, layer };
}

async function json<T>(res: Response, status = 200): Promise<T> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  return JSON.parse(text) as T;
}

async function member(repoId: string, userId: string, role: string): Promise<void> {
  await run(dbEnv, 'INSERT INTO repo_members (repo_id, user_id, role) VALUES (?, ?, ?)', [
    repoId,
    userId,
    role,
  ]);
}

/** A running CI job of `repoId` and its request token. */
async function ciJob(repoId: string): Promise<{ id: string; token: string }> {
  const id = `run-${repoId}`;
  await run(
    dbEnv,
    `INSERT INTO ci_runs (id, repo_id, head_cs, settings_version, config, requested_by, state,
                          month, reserved_micros, created_at, deadline)
     VALUES (?, ?, 'cs', 1, '{}', ?, 'running', '2026-10', 0, ?, ?)`,
    [id, repoId, owner.userId, Date.now(), Date.now() + 60_000],
  );
  return { id, token: await createRequestToken(dbEnv, id, Date.now() + 60_000) };
}

beforeEach(async () => {
  await seedSchema(testEnv);
  await cleanDb(testEnv);
  events = [];
  overrides = {};
  owner = await loginAs(testEnv, 1, 'owner');
  reader = await loginAs(testEnv, 2, 'reader');
  writer = await loginAs(testEnv, 3, 'writer');
  stranger = await loginAs(testEnv, 4, 'stranger');
  await json(
    await app(
      new Request(`https://${HOST}/api/v1/orgs`, {
        method: 'POST',
        headers: { ...owner.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'acme' }),
      }),
    ),
    201,
  );
  orgId = (await q1<{ id: string }>(dbEnv, "SELECT id FROM orgs WHERE slug = 'acme'"))!
    .id;
  for (const slug of ['acme/app', 'acme/other']) {
    const repo = await createRepo(dbEnv, {
      slug,
      createdBy: owner.userId,
      ownerKind: 'org',
      ownerId: orgId,
    });
    if (slug === 'acme/app') repoA = repo.id;
    else repoB = repo.id;
  }
  await member(repoA, reader.userId, 'read');
  await member(repoA, writer.userId, 'write');
  await run(
    dbEnv,
    `INSERT INTO webhooks (id, scope, owner_id, url, secret_ciphertext, key_owner, key_version,
                           events, created_by, created_at, updated_at)
     VALUES ('hook', 'repo', ?, 'https://hooks.example.com', 'x', 'x', 1, '["package"]', ?, 0, 0)`,
    [repoA, owner.userId],
  );
});

describe('auth flow', () => {
  it('challenges anonymous callers with the Bearer realm', async () => {
    const ping = await reg('GET', '/v2/');
    expect(ping.status).toBe(401);
    expect(ping.headers.get('www-authenticate')).toBe(
      `Bearer realm="https://${HOST}/v2/token",service="${HOST}"`,
    );
    const body = await json<{ errors: { code: string }[]; error: { code: string } }>(
      ping,
      401,
    );
    expect(body.errors[0]!.code).toBe('UNAUTHORIZED');
    expect(body.error.code).toBe('unauthorized');

    const blob = await reg('GET', `/v2/acme/app/web/blobs/sha256:${'0'.repeat(64)}`);
    expect(blob.status).toBe(401);
    expect(blob.headers.get('www-authenticate')).toContain(
      'scope="repository:acme/app/web:pull"',
    );
    const token = await reg('GET', '/v2/token?scope=repository:acme/app/web:pull');
    expect(token.status).toBe(401);
    expect(token.headers.get('www-authenticate')).toMatch(/^Basic /);
    // a browser session is not a registry credential
    expect(
      (await app(new Request(`https://${HOST}/v2/`, { headers: owner.headers }))).status,
    ).toBe(401);
  });

  it('grants each scope the caller holds and nothing more', async () => {
    const scope = 'scope=repository:acme/app/web:pull,push,delete';
    const grant = async (auth: string): Promise<string> =>
      (
        await json<{ token: string }>(
          await reg('GET', `/v2/token?service=${HOST}&${scope}`, auth),
        )
      ).token;
    const ownerToken = await grant(await tokenFor(owner));
    const readerToken = await grant(await tokenFor(reader));
    const strangerToken = await grant(await tokenFor(stranger));
    const access = async (token: string): Promise<unknown> =>
      JSON.parse(
        (await q1<{ access: string }>(
          dbEnv,
          'SELECT access FROM registry_tokens WHERE token_hash = ?',
          [await sha256(new TextEncoder().encode(token))],
        ))!.access,
      );
    expect(await access(ownerToken)).toEqual([
      { name: 'acme/app/web', actions: ['pull', 'push', 'delete'] },
    ]);
    expect(await access(readerToken)).toEqual([
      { name: 'acme/app/web', actions: ['pull'] },
    ]);
    expect(await access(strangerToken)).toEqual([]);

    expect((await reg('GET', '/v2/', `Bearer ${ownerToken}`)).status).toBe(200);
    // a token without push is challenged again, naming the scope it needs
    const push = await reg(
      'POST',
      '/v2/acme/app/web/blobs/uploads/',
      `Bearer ${readerToken}`,
    );
    expect(push.status).toBe(401);
    expect(push.headers.get('www-authenticate')).toContain(
      'scope="repository:acme/app/web:pull,push"',
    );
    const res = await reg(
      'POST',
      '/v2/acme/app/web/blobs/uploads/',
      `Bearer ${ownerToken}`,
    );
    expect(res.status).toBe(202);

    // the OAuth2 password grant that oras-go and helm may use
    const form = await reg('POST', '/v2/token', undefined, {
      body: new URLSearchParams({
        grant_type: 'password',
        username: 'reader',
        password: (await createApiToken(dbEnv, reader.userId, { label: 'x' })).raw,
        scope: 'repository:acme/app/web:pull',
        service: HOST,
      }),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect((await json<{ access_token: string }>(form)).access_token).toMatch(/^yagreg_/);
  });
});

describe('push and pull', () => {
  it('pushes and pulls a multi-arch image', async () => {
    const auth = await tokenFor(owner);
    const amd = await pushImage('acme/app/web', auth, 'amd64');
    const arm = await pushImage('acme/app/web', auth, 'arm64');
    const index = {
      schemaVersion: 2,
      mediaType: OCI_INDEX,
      manifests: [
        {
          mediaType: OCI_MANIFEST,
          digest: amd.digest,
          size: amd.size,
          platform: { architecture: 'amd64', os: 'linux' },
        },
        {
          mediaType: OCI_MANIFEST,
          digest: arm.digest,
          size: arm.size,
          platform: { architecture: 'arm64', os: 'linux' },
        },
      ],
    };
    const indexBytes = new TextEncoder().encode(JSON.stringify(index));
    const pushed = await pushManifest('acme/app/web', 'v1', index, auth, OCI_INDEX);
    expect(pushed.status, await pushed.clone().text()).toBe(201);
    expect(pushed.headers.get('docker-content-digest')).toBe(await digestOf(indexBytes));

    // pull as a reader, the way docker does: HEAD the tag, GET each manifest, then blobs
    const pull = await tokenFor(reader, ['repo:read']);
    const head = await reg('HEAD', '/v2/acme/app/web/manifests/v1', pull, {
      headers: { accept: `${OCI_INDEX}, ${OCI_MANIFEST}` },
    });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-type')).toBe(OCI_INDEX);
    expect(head.headers.get('docker-content-digest')).toBe(await digestOf(indexBytes));
    const got = await reg('GET', '/v2/acme/app/web/manifests/v1', pull);
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(indexBytes);
    for (const image of [amd, arm]) {
      const manifest = await json<{ layers: { digest: string }[] }>(
        await reg('GET', `/v2/acme/app/web/manifests/${image.digest}`, pull),
      );
      const layer = manifest.layers[0]!.digest;
      const headBlob = await reg('HEAD', `/v2/acme/app/web/blobs/${layer}`, pull);
      expect(headBlob.status).toBe(200);
      expect(headBlob.headers.get('content-length')).toBe(String(image.layer.length));
      const blob = await reg('GET', `/v2/acme/app/web/blobs/${layer}`, pull);
      expect(new Uint8Array(await blob.arrayBuffer())).toEqual(image.layer);
    }
    expect(await json(await reg('GET', '/v2/acme/app/web/tags/list', pull))).toEqual({
      name: 'acme/app/web',
      tags: ['v1'],
    });
    // stored where the ticket says
    const listed = await testEnv.OBJECTS.list({ prefix: 'registry/blobs/sha256/' });
    expect(listed.objects.length).toBeGreaterThanOrEqual(5);
    expect((await testEnv.OBJECTS.list({ prefix: 'registry/uploads/' })).objects).toEqual(
      [],
    );
  });

  it('streams large chunked uploads in parts and checks order and digest', async () => {
    const auth = await tokenFor(owner);
    const big = new Uint8Array(PART_SIZE + 4096);
    for (let i = 0; i < big.length; i += 65536)
      crypto.getRandomValues(big.subarray(i, i + 65536));
    const start = await reg('POST', '/v2/acme/app/big/blobs/uploads/', auth);
    const location = start.headers.get('location')!;
    const half = 5 * 1024 * 1024;
    const first = await reg('PATCH', location, auth, {
      body: big.slice(0, half),
      headers: { 'content-range': `0-${half - 1}` },
    });
    expect(first.status).toBe(202);
    expect(first.headers.get('range')).toBe(`0-${half - 1}`);
    // out of order: the server is at `half`, not 0
    const stale = await reg('PATCH', location, auth, {
      body: big.slice(0, 10),
      headers: { 'content-range': '0-9' },
    });
    expect(stale.status).toBe(416);
    const second = await reg('PATCH', location, auth, {
      body: streamOf(big.slice(half)),
      headers: { 'content-range': `${half}-${big.length - 1}` },
    });
    expect(second.status).toBe(202);
    const status = await reg('GET', location, auth);
    expect(status.status).toBe(204);
    expect(status.headers.get('range')).toBe(`0-${big.length - 1}`);
    const row = await q1<{ parts: string }>(dbEnv, 'SELECT parts FROM registry_uploads');
    expect(JSON.parse(row!.parts)).toHaveLength(1); // one full part in R2, the rest in the tail

    const wrong = await reg('PUT', `${location}?digest=sha256:${'a'.repeat(64)}`, auth);
    expect(wrong.status).toBe(400);
    expect((await wrong.json()) as unknown).toMatchObject({
      errors: [{ code: 'DIGEST_INVALID' }],
    });

    // the failed upload is not linked; a fresh one with the right digest is
    const digest = await pushBlob('acme/app/big', big, auth);
    const blob = await reg('GET', `/v2/acme/app/big/blobs/${digest}`, auth);
    expect(await sha256(new Uint8Array(await blob.arrayBuffer()))).toBe(digest.slice(7));
  });

  it('takes monolithic uploads and cross-repo mounts the caller can read', async () => {
    const auth = await tokenFor(owner);
    const bytes = new TextEncoder().encode('monolithic');
    const digest = await digestOf(bytes);
    const res = await reg(
      'POST',
      `/v2/acme/app/one/blobs/uploads/?digest=${digest}`,
      auth,
      {
        body: bytes,
        headers: { 'content-length': String(bytes.length) },
      },
    );
    expect(res.status, await res.clone().text()).toBe(201);
    const bad = await reg(
      'POST',
      `/v2/acme/app/one/blobs/uploads/?digest=sha256:${'b'.repeat(64)}`,
      auth,
      {
        body: bytes,
        headers: { 'content-length': String(bytes.length) },
      },
    );
    expect(bad.status).toBe(400);

    // other packages cannot use a blob by digest alone
    const missing = await pushManifest(
      'acme/other/two',
      'v1',
      {
        schemaVersion: 2,
        mediaType: OCI_MANIFEST,
        config: {
          mediaType: 'application/vnd.oci.empty.v1+json',
          digest,
          size: bytes.length,
        },
        layers: [],
      },
      auth,
    );
    expect(missing.status).toBe(400);
    expect((await missing.json()) as unknown).toMatchObject({
      errors: [{ code: 'MANIFEST_BLOB_UNKNOWN' }],
    });
    expect((await reg('GET', `/v2/acme/other/two/blobs/${digest}`, auth)).status).toBe(
      404,
    );

    // a mount from a readable package links it
    const mount = await reg(
      'POST',
      `/v2/acme/other/two/blobs/uploads/?mount=${digest}&from=acme/app/one`,
      auth,
    );
    expect(mount.status).toBe(201);
    expect((await reg('GET', `/v2/acme/other/two/blobs/${digest}`, auth)).status).toBe(
      200,
    );
    // a writer of acme/app only cannot mount into acme/other
    const writerAuth = await tokenFor(writer);
    expect(
      (
        await reg(
          'POST',
          `/v2/acme/other/three/blobs/uploads/?mount=${digest}&from=acme/app/one`,
          writerAuth,
        )
      ).status,
    ).toBe(404);
  });

  it('serves referrers for signatures and SBOMs', async () => {
    const auth = await tokenFor(owner);
    const image = await pushImage('acme/app/web', auth, 'amd64');
    const empty = await pushBlob('acme/app/web', EMPTY, auth);
    const sigLayer = await pushBlob(
      'acme/app/web',
      new TextEncoder().encode('signature'),
      auth,
    );
    const signature = {
      schemaVersion: 2,
      mediaType: OCI_MANIFEST,
      artifactType: 'application/vnd.dev.cosign.artifact.sig.v1+json',
      config: { mediaType: 'application/vnd.oci.empty.v1+json', digest: empty, size: 2 },
      layers: [
        {
          mediaType: 'application/vnd.dev.cosign.simplesigning.v1+json',
          digest: sigLayer,
          size: 9,
        },
      ],
      subject: { mediaType: OCI_MANIFEST, digest: image.digest, size: image.size },
      annotations: { 'dev.sigstore.cosign/signature': 'MEUC' },
    };
    const sigBytes = new TextEncoder().encode(JSON.stringify(signature));
    const sigDigest = await digestOf(sigBytes);
    const res = await pushManifest('acme/app/web', sigDigest, signature, auth);
    expect(res.status).toBe(201);
    expect(res.headers.get('oci-subject')).toBe(image.digest);

    const list = await reg('GET', `/v2/acme/app/web/referrers/${image.digest}`, auth);
    expect(list.headers.get('content-type')).toBe(OCI_INDEX);
    expect(await json(list)).toEqual({
      schemaVersion: 2,
      mediaType: OCI_INDEX,
      manifests: [
        {
          mediaType: OCI_MANIFEST,
          digest: sigDigest,
          size: sigBytes.length,
          artifactType: 'application/vnd.dev.cosign.artifact.sig.v1+json',
          annotations: { 'dev.sigstore.cosign/signature': 'MEUC' },
        },
      ],
    });
    const filtered = await reg(
      'GET',
      `/v2/acme/app/web/referrers/${image.digest}?artifactType=application/spdx%2Bjson`,
      auth,
    );
    expect(filtered.headers.get('oci-filters-applied')).toBe('artifactType');
    expect(((await filtered.json()) as { manifests: unknown[] }).manifests).toEqual([]);
    // cosign's tag fallback scheme works too: tags are free-form
    expect(
      (
        await pushManifest(
          'acme/app/web',
          `sha256-${image.digest.slice(7)}.sig`,
          signature,
          auth,
        )
      ).status,
    ).toBe(201);
  });

  it('deletes tags and manifests with admin only', async () => {
    const auth = await tokenFor(owner);
    const image = await pushImage('acme/app/web', auth, 'amd64');
    const manifest = await (
      await reg('GET', `/v2/acme/app/web/manifests/${image.digest}`, auth)
    ).json();
    expect((await pushManifest('acme/app/web', 'latest', manifest, auth)).status).toBe(
      201,
    );
    const writerAuth = await tokenFor(writer);
    const denied = await reg('DELETE', '/v2/acme/app/web/manifests/latest', writerAuth);
    expect(denied.status).toBe(403);
    expect((await denied.json()) as unknown).toMatchObject({
      errors: [{ code: 'DENIED' }],
    });
    expect((await reg('DELETE', '/v2/acme/app/web/manifests/latest', auth)).status).toBe(
      202,
    );
    expect((await reg('GET', '/v2/acme/app/web/manifests/latest', auth)).status).toBe(
      404,
    );
    expect(
      (await reg('GET', `/v2/acme/app/web/manifests/${image.digest}`, auth)).status,
    ).toBe(200);
    expect(
      (await reg('DELETE', `/v2/acme/app/web/manifests/${image.digest}`, auth)).status,
    ).toBe(202);
    expect(
      (await reg('GET', `/v2/acme/app/web/manifests/${image.digest}`, auth)).status,
    ).toBe(404);
    const audit = await q<{ action: string }>(
      dbEnv,
      "SELECT action FROM audit_events WHERE action LIKE 'package.%'",
    );
    expect(audit.map((a) => a.action).filter((a) => a === 'package.delete')).toHaveLength(
      2,
    );
  });
});

describe('permissions', () => {
  it('maps pull and push to repo roles and hides unreadable repos', async () => {
    const auth = await tokenFor(owner);
    await pushImage('acme/app/web', auth, 'amd64');
    const readerAuth = await tokenFor(reader);
    expect((await reg('GET', '/v2/acme/app/web/tags/list', readerAuth)).status).toBe(200);
    const push = await reg('POST', '/v2/acme/app/web/blobs/uploads/', readerAuth);
    expect(push.status).toBe(403);
    expect((await push.json()) as unknown).toMatchObject({
      error: { code: 'forbidden' },
    });
    const strangerAuth = await tokenFor(stranger);
    const hidden = await reg('GET', '/v2/acme/app/web/tags/list', strangerAuth);
    expect(hidden.status).toBe(404);
    expect((await hidden.json()) as unknown).toMatchObject({
      errors: [{ code: 'NAME_UNKNOWN' }],
    });
    expect((await reg('GET', '/v2/acme/nope/web/tags/list', auth)).status).toBe(404);
    expect((await reg('GET', '/v2/Acme/app/tags/list', auth)).status).toBe(400);
    // a read-only token cannot push even for an admin
    const readOnly = await tokenFor(owner, ['repo:read']);
    expect((await reg('POST', '/v2/acme/app/web/blobs/uploads/', readOnly)).status).toBe(
      403,
    );
    // a token bound to another repo sees nothing here
    const bound = basic(
      (await createApiToken(dbEnv, owner.userId, { label: 'b', repoId: repoB })).raw,
    );
    expect((await reg('GET', '/v2/acme/app/web/tags/list', bound)).status).toBe(404);
  });

  it('refuses callers a path rule restricts, like Git', async () => {
    await run(
      dbEnv,
      `INSERT INTO path_rules (repo_id, path_prefix, effect, principal, perms)
       VALUES (?, 'secrets/', 'deny', ?, '["read"]')`,
      [repoA, `user:${reader.userId}`],
    );
    const res = await reg('GET', '/v2/acme/app/web/tags/list', await tokenFor(reader));
    expect(res.status).toBe(403);
    expect((await res.json()) as unknown).toMatchObject({
      error: { code: 'path_restricted' },
    });
  });

  it('lets a CI job token push to its own repo only', async () => {
    const job = await ciJob(repoA);
    const auth = basic(job.token);
    const image = await pushImage('acme/app/ci', auth, 'amd64');
    expect(image.digest).toMatch(/^sha256:/);
    // repo B: the job's credential cannot see it, let alone publish
    const other = await reg('POST', '/v2/acme/other/ci/blobs/uploads/', auth);
    expect(other.status).toBe(404);
    const token = await json<{ token: string }>(
      await reg('GET', '/v2/token?scope=repository:acme/other/ci:pull,push', auth),
    );
    const row = await q1<{ access: string }>(
      dbEnv,
      'SELECT access FROM registry_tokens WHERE token_hash = ?',
      [await sha256(new TextEncoder().encode(token.token))],
    );
    expect(JSON.parse(row!.access)).toEqual([]);
    // once the run ends the token stops working
    await run(dbEnv, "UPDATE ci_runs SET state = 'passed' WHERE id = ?", [job.id]);
    expect((await reg('GET', '/v2/', auth)).status).toBe(401);
  });

  it('takes a CI OIDC ID token minted for the registry host', async () => {
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
    signingKey = {
      ...((await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey),
      kid: 'k1',
    } as JsonWebKey;
    overrides = { CI_OIDC_SIGNING_KEYS: JSON.stringify({ keys: [signingKey] }) };
    const job = await ciJob(repoA);
    const now = Math.floor(Date.now() / 1000);
    const claims = (aud: string, repository_id = repoA) => ({
      iss: issuerFor(bindings, `https://${HOST}`),
      aud,
      sub: 'repo:acme/app:ref:refs/heads/main',
      iat: now,
      nbf: now,
      exp: now + 300,
      run_id: job.id,
      repository_id,
    });
    const good = await signJwt(bindings, claims(HOST));
    expect(
      (await reg('POST', '/v2/acme/app/oidc/blobs/uploads/', basic(good))).status,
    ).toBe(202);
    expect(
      (await reg('POST', '/v2/acme/other/oidc/blobs/uploads/', basic(good))).status,
    ).toBe(404);
    const aws = await signJwt(bindings, claims('sts.amazonaws.com'));
    expect((await reg('GET', '/v2/', basic(aws))).status).toBe(401);
    const forged = await signJwt(bindings, claims(HOST, repoB));
    expect((await reg('GET', '/v2/', basic(forged))).status).toBe(401);
  });

  it('needs packages:write for agents and holds their publish for approval', async () => {
    const delegate = (await createApiToken(dbEnv, owner.userId, { label: 'delegate' }))
      .raw;
    const agentToken = async (scope: string): Promise<string> => {
      const created = await app(
        new Request(`https://${HOST}/api/v1/agents`, {
          method: 'POST',
          headers: { ...owner.headers, 'content-type': 'application/json' },
          body: JSON.stringify({
            name: `bot-${scope.length}`,
            kind: 'codex',
            max_scopes: ['contents:read', 'packages:write'],
          }),
        }),
      );
      const { id } = await json<{ id: string }>(created, 201);
      const res = await app(
        new Request(`https://${HOST}/oauth/token`, {
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
      return `Bearer ${(await json<{ access_token: string }>(res)).access_token}`;
    };
    const auth = await tokenFor(owner);
    await pushImage('acme/app/web', auth, 'amd64');

    const readOnly = await agentToken('contents:read');
    expect((await reg('GET', '/v2/acme/app/web/tags/list', readOnly)).status).toBe(200);
    const refused = await reg('POST', '/v2/acme/app/web/blobs/uploads/', readOnly);
    expect(refused.status).toBe(403);
    expect((await refused.json()) as unknown).toMatchObject({
      error: { code: 'insufficient_scope' },
    });

    const pusher = await agentToken('contents:read packages:write');
    const layer = await pushBlob(
      'acme/app/web',
      new TextEncoder().encode('agent layer'),
      pusher,
    );
    const manifest = {
      schemaVersion: 2,
      mediaType: OCI_MANIFEST,
      config: { mediaType: 'application/vnd.oci.empty.v1+json', digest: layer, size: 11 },
      layers: [],
    };
    // the default policy holds releases, packages included, for a person
    const held = await pushManifest('acme/app/web', 'agent', manifest, pusher);
    expect(held.status).toBe(403);
    expect((await held.json()) as unknown).toMatchObject({
      error: { code: 'approval_required' },
    });
    expect((await reg('GET', '/v2/acme/app/web/manifests/agent', auth)).status).toBe(404);
  });
});

describe('quotas, audit, webhooks and retention', () => {
  it('refuses uploads past the owner quota', async () => {
    overrides = { REGISTRY_QUOTA_BYTES: '1000' };
    const auth = await tokenFor(owner);
    const start = await reg('POST', '/v2/acme/app/q/blobs/uploads/', auth);
    const res = await reg('PATCH', start.headers.get('location')!, auth, {
      body: new Uint8Array(2000),
    });
    expect(res.status).toBe(413);
    expect((await res.json()) as unknown).toMatchObject({
      error: { reason: 'quota_exceeded' },
    });
  });

  it('audits publishes and emits package events', async () => {
    const auth = await tokenFor(owner);
    const image = await pushImage('acme/app/web', auth, 'amd64');
    const audit = await q<{ action: string; target: string; actor_kind: string }>(
      dbEnv,
      "SELECT action, target, actor_kind FROM audit_events WHERE action = 'package.publish'",
    );
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]!.target)).toMatchObject({
      kind: 'oci',
      package: 'acme/app/web',
      digest: image.digest,
    });
    expect(audit[0]!.actor_kind).toBe('token');
    expect(events.map((e) => [e.event, e.action, e.data.digest])).toEqual([
      ['package', 'published', image.digest],
    ]);
  });

  it('lists packages and applies keep_untagged in the cleanup job', async () => {
    const auth = await tokenFor(owner);
    const keep = await pushImage('acme/app/web', auth, 'amd64');
    const manifest = await (
      await reg('GET', `/v2/acme/app/web/manifests/${keep.digest}`, auth)
    ).json();
    expect((await pushManifest('acme/app/web', 'stable', manifest, auth)).status).toBe(
      201,
    );
    const old = await pushImage('acme/app/web', auth, 'old');
    const child = await pushImage('acme/app/web', auth, 'child');
    const index = {
      schemaVersion: 2,
      mediaType: OCI_INDEX,
      manifests: [{ mediaType: OCI_MANIFEST, digest: child.digest, size: child.size }],
    };
    expect(
      (await pushManifest('acme/app/web', 'multi', index, auth, OCI_INDEX)).status,
    ).toBe(201);
    const newest = await pushImage('acme/app/web', auth, 'newest');
    await run(dbEnv, 'UPDATE package_versions SET created_at = 1 WHERE version = ?', [
      old.digest,
    ]);

    const listed = await json<{
      packages: { id: string; name: string; versions: number }[];
    }>(
      await app(
        new Request(`https://${HOST}/api/v1/repos/acme/app/packages`, {
          headers: reader.headers,
        }),
      ),
    );
    expect(listed.packages.map((p) => [p.name, p.versions])).toEqual([
      ['acme/app/web', 5],
    ]);
    const id = listed.packages[0]!.id;
    const patch = (who: Login) =>
      app(
        new Request(`https://${HOST}/api/v1/repos/acme/app/packages/${id}`, {
          method: 'PATCH',
          headers: { ...who.headers, 'content-type': 'application/json' },
          body: JSON.stringify({ keep_untagged: 1 }),
        }),
      );
    expect((await patch(writer)).status).toBe(403);
    expect((await patch(owner)).status).toBe(200);

    await registryCleanup(dbEnv);
    const left = (
      await q<{ version: string }>(dbEnv, 'SELECT version FROM package_versions')
    ).map((r) => r.version);
    // tagged, an index's child, the index and the newest untagged stay; the oldest goes
    expect(left.sort()).toEqual(
      [
        keep.digest,
        child.digest,
        newest.digest,
        (await q1<{ version: string }>(
          dbEnv,
          "SELECT version FROM package_tags WHERE tag = 'multi'",
        ))!.version,
      ].sort(),
    );
    expect(left).not.toContain(old.digest);
    expect(
      (await reg('GET', `/v2/acme/app/web/manifests/${old.digest}`, auth)).status,
    ).toBe(404);

    // a day later the old image's unused blob links go, and so do unlinked R2 blobs
    await registryCleanup(dbEnv, Date.now() + 2 * 86_400_000);
    const oldManifest = await q1(dbEnv, 'SELECT 1 FROM package_files WHERE digest = ?', [
      old.digest,
    ]);
    expect(oldManifest).toBeNull();
    expect(
      await testEnv.OBJECTS.head(`registry/blobs/sha256/${old.digest.slice(7)}`),
    ).toBeNull();
    expect(
      await testEnv.OBJECTS.head(`registry/blobs/sha256/${keep.digest.slice(7)}`),
    ).not.toBeNull();
  });
});
