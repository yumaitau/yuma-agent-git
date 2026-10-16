import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { cleanDb, loginAs, makeApp, seedSchema, sha256, type TestEnv } from './helpers';
import type { Env } from '../src/env';
import { createRepo } from '../src/db/repos';
import { q1, run } from '../src/db/client';
import { createApiToken } from '../src/auth/tokens';
import { LFS_ACTION_TTL_S, lfsKey } from '../src/git/lfs';

const testEnv = env as unknown as TestEnv;
const LFS = 'application/vnd.git-lfs+json';
let owner: Awaited<ReturnType<typeof loginAs>>;
let reader: Awaited<ReturnType<typeof loginAs>>;
let repoId = '';
let ownerAuth = '';
let readerAuth = '';

async function basic(userId: string): Promise<string> {
  const token = await createApiToken(testEnv, userId, { label: 'lfs' });
  return `Basic ${btoa(`git:${token.raw}`)}`;
}

function lfs(
  path: string,
  init: { method?: string; body?: unknown; auth?: string; bindings?: Env } = {},
): Promise<Response> {
  return Promise.resolve(
    makeApp(init.bindings ?? testEnv)(
      new Request(`https://forge.test/team/assets.git/info/lfs/${path}`, {
        method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
        headers: {
          accept: LFS,
          'content-type': LFS,
          ...(init.auth === '' ? {} : { authorization: init.auth ?? ownerAuth }),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      }),
    ),
  );
}

interface Action {
  href: string;
  header: Record<string, string>;
  expires_in: number;
}
interface BatchObject {
  oid: string;
  size: number;
  actions?: { upload?: Action; verify?: Action; download?: Action };
  error?: { code: number; message: string };
}

async function batch(
  operation: 'upload' | 'download',
  objects: { oid: string; size: number }[],
  auth = ownerAuth,
  bindings?: Env,
): Promise<{ status: number; objects: BatchObject[]; body: Record<string, unknown> }> {
  const res = await lfs('objects/batch', {
    body: { operation, transfers: ['basic'], objects },
    auth,
    bindings,
  });
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, objects: (body.objects as BatchObject[]) ?? [], body };
}

/** Follow an action the way git-lfs does: its href with its headers. */
function follow(
  a: Action,
  method: string,
  body?: BodyInit,
  headers: Record<string, string> = {},
): Promise<Response> {
  return Promise.resolve(
    makeApp(testEnv)(
      new Request(a.href, { method, headers: { ...a.header, ...headers }, body }),
    ),
  );
}

async function object(
  text: string,
): Promise<{ oid: string; size: number; bytes: Uint8Array }> {
  const bytes = new TextEncoder().encode(text);
  return { oid: await sha256(bytes), size: bytes.length, bytes };
}

async function upload(text: string): Promise<{ oid: string; size: number }> {
  const o = await object(text);
  const { objects } = await batch('upload', [{ oid: o.oid, size: o.size }]);
  const actions = objects[0]?.actions;
  expect(actions?.upload).toBeDefined();
  expect((await follow(actions!.upload!, 'PUT', o.bytes)).status).toBe(200);
  const verified = await follow(
    actions!.verify!,
    'POST',
    JSON.stringify({ oid: o.oid, size: o.size }),
    { 'content-type': LFS },
  );
  expect(verified.status).toBe(200);
  return { oid: o.oid, size: o.size };
}

async function usage(): Promise<{ objects: number; bytes: number }> {
  const res = await makeApp(testEnv)(
    new Request('https://forge.test/api/v1/repos/team/assets/lfs', {
      headers: owner.headers,
    }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { objects: number; bytes: number };
}

beforeEach(async () => {
  await seedSchema(testEnv);
  await cleanDb(testEnv);
  owner = await loginAs(testEnv, 901, 'owner');
  reader = await loginAs(testEnv, 902, 'reader');
  const repo = await createRepo(testEnv, {
    slug: 'team/assets',
    createdBy: owner.userId,
    visibility: 'private',
  });
  repoId = repo.id;
  await run(
    testEnv,
    "INSERT INTO repo_members(repo_id,user_id,role) VALUES (?,?,'read')",
    [repoId, reader.userId],
  );
  ownerAuth = await basic(owner.userId);
  readerAuth = await basic(reader.userId);
});

describe('Git LFS batch API (#35)', () => {
  it('uploads, verifies and downloads through signed actions', async () => {
    const o = await object('large binary content\n');
    const first = await batch('upload', [{ oid: o.oid, size: o.size }]);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ transfer: 'basic', hash_algo: 'sha256' });
    const actions = first.objects[0]?.actions;
    expect(actions?.upload?.href).toBe(
      `https://forge.test/team/assets.git/info/lfs/objects/${o.oid}`,
    );
    expect(actions?.upload?.expires_in).toBeLessThanOrEqual(15 * 60);
    expect(LFS_ACTION_TTL_S).toBeLessThanOrEqual(15 * 60);
    expect(actions?.upload?.header.Authorization).toMatch(/^RemoteAuth /);
    expect((await follow(actions!.upload!, 'PUT', o.bytes)).status).toBe(200);
    expect(
      (
        await follow(
          actions!.verify!,
          'POST',
          JSON.stringify({ oid: o.oid, size: o.size }),
          { 'content-type': LFS },
        )
      ).status,
    ).toBe(200);
    expect(await testEnv.OBJECTS.head(lfsKey(repoId, o.oid))).not.toBeNull();

    // a second upload of the same object has nothing to send
    const again = await batch('upload', [{ oid: o.oid, size: o.size }]);
    expect(again.objects[0]?.actions).toBeUndefined();

    // readers download it
    const down = await batch('download', [{ oid: o.oid, size: o.size }], readerAuth);
    expect(down.status).toBe(200);
    const got = await follow(down.objects[0]!.actions!.download!, 'GET');
    expect(got.status).toBe(200);
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(o.bytes);

    // unknown objects are per-object 404s
    const missing = await object('never uploaded');
    const none = await batch('download', [{ oid: missing.oid, size: missing.size }]);
    expect(none.objects[0]?.error?.code).toBe(404);
  });

  it('rejects uploads with a wrong hash or size and links nothing', async () => {
    const o = await object('the real bytes');
    const { objects } = await batch('upload', [{ oid: o.oid, size: o.size }]);
    const put = objects[0]!.actions!.upload!;
    // same length, different content: R2 refuses the checksum
    const wrong = new TextEncoder().encode('the fake bytes');
    expect(wrong.length).toBe(o.size);
    const hash = await follow(put, 'PUT', wrong);
    expect(hash.status).toBe(422);
    // the right content under a declared size it does not have
    const sized = await batch('upload', [{ oid: o.oid, size: o.size + 3 }]);
    const short = await follow(sized.objects[0]!.actions!.upload!, 'PUT', o.bytes);
    expect(short.status).toBe(422);
    expect(await testEnv.OBJECTS.head(lfsKey(repoId, o.oid))).toBeNull();
    expect(
      await q1(testEnv, 'SELECT 1 FROM lfs_objects WHERE repo_id = ?', [repoId]),
    ).toBeNull();
    const verify = await follow(
      objects[0]!.actions!.verify!,
      'POST',
      JSON.stringify({ oid: o.oid, size: o.size }),
      { 'content-type': LFS },
    );
    expect(verify.status).toBe(422);
    expect((await usage()).bytes).toBe(0);
  });

  it('refuses tampered, foreign and expired transfer actions', async () => {
    const o = await object('signed');
    const { objects } = await batch('upload', [{ oid: o.oid, size: o.size }]);
    const put = objects[0]!.actions!.upload!;
    const tampered = {
      ...put,
      header: { Authorization: `${put.header.Authorization}0` },
    };
    expect((await follow(tampered, 'PUT', o.bytes)).status).toBe(401);
    // the token names this repository: another repo's URL does not take it
    await createRepo(testEnv, { slug: 'team/other', createdBy: owner.userId });
    const foreign = { ...put, href: put.href.replace('team/assets', 'team/other') };
    expect((await follow(foreign, 'PUT', o.bytes)).status).toBe(401);
    // an upload token is not a download token
    expect((await follow(put, 'GET')).status).toBe(401);
    const [exp, size, mac] = put.header
      .Authorization!.slice('RemoteAuth '.length)
      .split('.');
    const expired = {
      ...put,
      header: { Authorization: `RemoteAuth ${Number(exp) - 3600}.${size}.${mac}` },
    };
    expect((await follow(expired, 'PUT', o.bytes)).status).toBe(401);
  });

  it('applies repo access: 401 anonymous, 404 unreadable, 403 upload without write', async () => {
    const o = await object('guarded');
    const anon = await lfs('objects/batch', {
      body: { operation: 'download', objects: [o] },
      auth: '',
    });
    expect(anon.status).toBe(401);
    expect(anon.headers.get('lfs-authenticate')).toMatch(/^Basic/);
    const stranger = await loginAs(testEnv, 903, 'stranger');
    const hidden = await batch('download', [o], await basic(stranger.userId));
    expect(hidden.status).toBe(404);
    expect(hidden.objects).toEqual([]);
    const readOnly = await batch('upload', [o], readerAuth);
    expect(readOnly.status).toBe(403);
    expect(readOnly.body).toMatchObject({ error: { code: 'forbidden' } });
    // path rules hide part of the repo: LFS, like Git, needs the whole tree
    await run(
      testEnv,
      "INSERT INTO path_rules (repo_id,path_prefix,effect,principal,perms) VALUES (?,?,'deny',?,?)",
      [repoId, 'secret/', `user:${reader.userId}`, JSON.stringify(['read'])],
    );
    const restricted = await batch('download', [o], readerAuth);
    expect(restricted.status).toBe(403);
    expect(restricted.body).toMatchObject({ error: { code: 'path_restricted' } });
  });

  it('reports storage per repo after uploads and deletes', async () => {
    const a = await upload('object a');
    const b = await upload('object bb');
    expect(await usage()).toMatchObject({ objects: 2, bytes: a.size + b.size });
    const del = await makeApp(testEnv)(
      new Request(`https://forge.test/api/v1/repos/team/assets/lfs/objects/${a.oid}`, {
        method: 'DELETE',
        headers: owner.headers,
      }),
    );
    expect(del.status).toBe(200);
    expect(await usage()).toMatchObject({ objects: 1, bytes: b.size });
    expect(await testEnv.OBJECTS.head(lfsKey(repoId, a.oid))).toBeNull();
    // only admins remove objects
    const denied = await makeApp(testEnv)(
      new Request(`https://forge.test/api/v1/repos/team/assets/lfs/objects/${b.oid}`, {
        method: 'DELETE',
        headers: reader.headers,
      }),
    );
    expect(denied.status).toBe(403);
    expect(
      await q1(testEnv, "SELECT 1 FROM audit_events WHERE action = 'lfs.object.delete'"),
    ).not.toBeNull();
  });

  it('enforces the repo quota when the upload is requested', async () => {
    await upload('0123456789');
    const small: Env = new Proxy(testEnv, {
      get: (t, k, r) => (k === 'LFS_REPO_QUOTA_BYTES' ? '15' : Reflect.get(t, k, r)),
    });
    const o = await object('more than five');
    const res = await batch('upload', [{ oid: o.oid, size: o.size }], ownerAuth, small);
    expect(res.status).toBe(507);
    expect(res.body).toMatchObject({ error: { code: 'lfs_quota_exceeded' } });
  });

  it('shares objects with forks without copying them', async () => {
    const a = await upload('shared asset');
    const fork = await makeApp(testEnv)(
      new Request('https://forge.test/api/v1/repos/team/assets/forks', {
        method: 'POST',
        headers: { ...reader.headers, 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    expect(fork.status).toBe(201);
    const res = await makeApp(testEnv)(
      new Request('https://forge.test/reader/assets.git/info/lfs/objects/batch', {
        method: 'POST',
        headers: { authorization: readerAuth, 'content-type': LFS },
        body: JSON.stringify({ operation: 'download', objects: [a] }),
      }),
    );
    const body = (await res.json()) as { objects: BatchObject[] };
    const got = await follow(body.objects[0]!.actions!.download!, 'GET');
    expect(new TextDecoder().decode(await got.arrayBuffer())).toBe('shared asset');
  });

  it('locks files for writers and lets only admins force an unlock', async () => {
    const writer = await loginAs(testEnv, 904, 'writer');
    await run(
      testEnv,
      "INSERT INTO repo_members(repo_id,user_id,role) VALUES (?,?,'write')",
      [repoId, writer.userId],
    );
    const writerAuth = await basic(writer.userId);
    const created = await lfs('locks', {
      body: { path: 'art/logo.psd' },
      auth: writerAuth,
    });
    expect(created.status).toBe(201);
    const { lock } = (await created.json()) as {
      lock: { id: string; owner: { name: string } };
    };
    expect(lock.owner.name).toBe('writer');
    const dup = await lfs('locks', { body: { path: 'art/logo.psd' } });
    expect(dup.status).toBe(409);
    expect((await lfs('locks', { body: { path: 'x' }, auth: readerAuth })).status).toBe(
      403,
    );

    const listed = (await (
      await lfs('locks?path=art/logo.psd', { auth: readerAuth })
    ).json()) as {
      locks: { id: string }[];
    };
    expect(listed.locks.map((l) => l.id)).toEqual([lock.id]);
    const verify = (await (
      await lfs('locks/verify', { body: {}, auth: writerAuth })
    ).json()) as { ours: unknown[]; theirs: unknown[] };
    expect([verify.ours.length, verify.theirs.length]).toEqual([1, 0]);

    // the owner of the repo is an admin, but must ask to force
    expect((await lfs(`locks/${lock.id}/unlock`, { body: {} })).status).toBe(403);
    const forced = await lfs(`locks/${lock.id}/unlock`, { body: { force: true } });
    expect(forced.status).toBe(200);
    const audit = await q1<{ target: string }>(
      testEnv,
      "SELECT target FROM audit_events WHERE action = 'lfs.unlock'",
    );
    expect(JSON.parse(audit?.target ?? '{}')).toMatchObject({ forced: true });
  });
});
