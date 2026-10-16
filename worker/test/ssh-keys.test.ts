import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { cleanDb, loginAs, makeApp, seedSchema, type TestEnv } from './helpers';
import {
  blob,
  commandBody,
  commit,
  lines,
  packOf,
  parseReport,
  pushBody,
  tree,
  ZERO,
} from './git-helpers';
import { createRepo } from '../src/db/repos';
import { q, run } from '../src/db/client';
import { createApiToken } from '../src/auth/tokens';
import { parseAuthKey, resolveSshToken } from '../src/api/keys';
import { b64urlDecode } from '../src/auth/encoding';

/**
 * Git over SSH (issue #34): SSH and deploy key management, the gateway's
 * authorise endpoint (internal host and gateway key only), and smart HTTP
 * taking the 60-second token it returns.
 */

const testEnv = env as unknown as TestEnv;
const dbEnv = testEnv as unknown as Env;
const GATEWAY_HOST = 'ssh-gateway.internal.test';
const GATEWAY_KEY = 'test-gateway-key';
const gwEnv = {
  ...testEnv,
  SSH_GATEWAY_HOST: GATEWAY_HOST,
  SSH_GATEWAY_KEY: GATEWAY_KEY,
};
const app = makeApp(gwEnv as unknown as Env);
const SLUG = 'acme/ssh';
const enc = new TextEncoder();

// --- key builders -------------------------------------------------------------

function sshString(bytes: Uint8Array | string): Uint8Array {
  const body = typeof bytes === 'string' ? enc.encode(bytes) : bytes;
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, body.length);
  out.set(body, 4);
  return out;
}

function line(...parts: (Uint8Array | string)[]): string {
  const chunks = parts.map(sshString);
  const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  const type = typeof parts[0] === 'string' ? parts[0] : 'unknown';
  return `${type} ${btoa(String.fromCharCode(...all))} someone@laptop`;
}

async function ed25519(): Promise<string> {
  const pair = (await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(
    (await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer,
  );
  return line('ssh-ed25519', raw);
}

async function ecdsa(): Promise<string> {
  const pair = (await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const raw = new Uint8Array(
    (await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer,
  );
  return line('ecdsa-sha2-nistp256', 'nistp256', raw);
}

async function rsa(bits: number): Promise<string> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: bits,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
  // mpints are signed: a leading zero byte keeps the modulus positive
  const n = b64urlDecode(jwk.n!);
  return line('ssh-rsa', b64urlDecode(jwk.e!), new Uint8Array([0, ...n]));
}

const skEd25519 = (): string =>
  line('sk-ssh-ed25519@openssh.com', crypto.getRandomValues(new Uint8Array(32)), 'ssh:');

async function fingerprintOf(key: string): Promise<string> {
  return (await parseAuthKey(key)).fingerprint;
}

// --- requests -------------------------------------------------------------------

async function call(
  as: { headers: Record<string, string> } | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return app(
    new Request(`https://x${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(as?.headers ?? {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

async function authorize(
  input: { fingerprint: string; repo?: string; service?: string },
  opts: { host?: string; key?: string | null } = {},
): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const key = opts.key === undefined ? GATEWAY_KEY : opts.key;
  if (key !== null) headers['x-ssh-gateway-key'] = key;
  return app(
    new Request(`https://${opts.host ?? GATEWAY_HOST}/internal/ssh/authorize`, {
      method: 'POST',
      headers,
      body: JSON.stringify(input),
    }),
  );
}

async function token(fingerprint: string, service: string, repo = SLUG): Promise<string> {
  const res = await authorize({ fingerprint, repo, service });
  expect(res.status, await res.clone().text()).toBe(200);
  const body = (await res.json()) as { token: string; expires_at: number };
  expect(body.token).toMatch(/^yag_ssh_[0-9a-f]{64}$/);
  return body.token;
}

const basic = (t: string): string => `Basic ${btoa(`git:${t}`)}`;

async function advertise(t: string, service: string, slug = SLUG): Promise<Response> {
  return app(
    new Request(`https://x/${slug}.git/info/refs?service=${service}`, {
      headers: { authorization: basic(t), 'git-protocol': 'version=2' },
    }),
  );
}

async function lsRefs(t: string): Promise<Response> {
  return app(
    new Request(`https://x/${SLUG}.git/git-upload-pack`, {
      method: 'POST',
      headers: {
        authorization: basic(t),
        'git-protocol': 'version=2',
        'content-type': 'application/x-git-upload-pack-request',
      },
      body: commandBody('ls-refs', ['ref-prefix refs/heads/']),
    }),
  );
}

async function pushMain(t: string): Promise<Response> {
  const readme = await blob('over ssh\n');
  const root = await tree([{ name: 'README.md', sha: readme.sha }]);
  const head = await commit(root.sha, [], 'first\n');
  return app(
    new Request(`https://x/${SLUG}.git/git-receive-pack`, {
      method: 'POST',
      headers: {
        authorization: basic(t),
        'content-type': 'application/x-git-receive-pack-request',
      },
      body: pushBody(
        [[ZERO, head.sha, 'refs/heads/main']],
        await packOf([head, root, readme]),
      ),
    }),
  );
}

// --- tests ----------------------------------------------------------------------

let owner: Awaited<ReturnType<typeof loginAs>>;
let reader: Awaited<ReturnType<typeof loginAs>>;
let repoId = '';

beforeEach(async () => {
  await seedSchema(testEnv);
  await cleanDb(testEnv);
  owner = await loginAs(testEnv, 1, 'ada');
  reader = await loginAs(testEnv, 2, 'bob');
  const repo = await createRepo(dbEnv, {
    slug: SLUG,
    visibility: 'private',
    createdBy: owner.userId,
  });
  repoId = repo.id;
  await run(
    dbEnv,
    "INSERT INTO repo_members (repo_id, user_id, role) VALUES (?, ?, 'read')",
    [repoId, reader.userId],
  );
});

async function addKey(
  as: { headers: Record<string, string> },
  publicKey: string,
): Promise<{ id: string; fingerprint: string }> {
  const res = await call(as, 'POST', '/api/v1/me/ssh-keys', {
    title: 'laptop',
    public_key: publicKey,
  });
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { key: { id: string; fingerprint: string } }).key;
}

async function addDeployKey(
  publicKey: string,
  readOnly?: boolean,
): Promise<{ id: string; fingerprint: string; read_only: boolean }> {
  const res = await call(owner, 'POST', `/api/v1/repos/${SLUG}/deploy-keys`, {
    title: 'ci',
    public_key: publicKey,
    ...(readOnly === undefined ? {} : { read_only: readOnly }),
  });
  expect(res.status, await res.clone().text()).toBe(201);
  return (
    (await res.json()) as { key: { id: string; fingerprint: string; read_only: boolean } }
  ).key;
}

describe('SSH key parsing', () => {
  it('takes Ed25519, ECDSA, sk-ssh-ed25519 and RSA of 3072 bits', async () => {
    for (const key of [await ed25519(), await ecdsa(), skEd25519(), await rsa(3072)]) {
      const parsed = await parseAuthKey(key);
      expect(parsed.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
      // the comment is dropped
      expect(parsed.publicKey).toBe(key.split(' ').slice(0, 2).join(' '));
    }
  });

  it('refuses DSA, short RSA, unknown types and malformed data', async () => {
    await expect(parseAuthKey(await rsa(2048))).rejects.toThrow(/under 3072 bits/);
    await expect(parseAuthKey(line('ssh-dss', 'p', 'q', 'g', 'y'))).rejects.toThrow(
      /DSA keys are not accepted/,
    );
    await expect(parseAuthKey(line('ssh-foo', 'x'))).rejects.toThrow(/unsupported/);
    await expect(parseAuthKey(line('ssh-ed25519', new Uint8Array(31)))).rejects.toThrow(
      /malformed/,
    );
    await expect(
      parseAuthKey(line('ssh-ed25519', new Uint8Array(32), 'trailing')),
    ).rejects.toThrow(/malformed/);
    await expect(parseAuthKey(line('ssh-rsa', new Uint8Array(32)))).rejects.toThrow(
      /malformed/,
    );
    await expect(parseAuthKey('ssh-ed25519 not*base64')).rejects.toThrow(/OpenSSH/);
  });

  it('matches ssh-keygen fingerprints', async () => {
    // keys from ssh-keygen -t ed25519 / ecdsa -b 384 / rsa -b 3072, and what
    // ssh-keygen -lf printed for each
    const keys: [string, string][] = [
      [
        'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINOEdx+kPFbbWwUu7b2qqFJPHC8ssmQjcAXcxlUtI0rH test',
        'SHA256:+OoWq75yT4/MH8eIQDE78S8gKM4D84Pxwb5+7AZ9LvI',
      ],
      [
        'ecdsa-sha2-nistp384 AAAAE2VjZHNhLXNoYTItbmlzdHAzODQAAAAIbmlzdHAzODQAAABhBDBuiIN/N0Tpt6/BEt3d92a9QAFuWIymhQ69Sny8Qaqc496QD3+SvUktdt3G3YKy7XAnYYkxds4UdwMIIm3R+z5ow5/BSbGWJhSJvdSNOUC1Z7gCwogBe5Lvy33AwXxU/g== test',
        'SHA256:NAum/5NLCpxhGCY8Cg8smOh3gQigIPtsYkRixZHhXm8',
      ],
      [
        'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQDdrX6R1r9+p6p9/HdON1VTsGzRglQPZ/1G/rorjBZS5HGHxLs0zkeAkdsttutwDuP7Pd1qLYUSREq1YIUtyKoxT7OPEbnjmItVf5mWE8Kfz19nRfHRCo+YQMLA1kFYYwez3VfD+fwRJda0r1sG/34ErauPELJFo9Nr0kxfkke8CPp4qnRg15vgc3Sdv1dZbLj5d5me3QkDjV22sH6m57Br7ZQ33M8xEqxOutoKjig7LmBFG1WYibbmO+JP8OgbrdhERiqe1RARrUjLI62K6ZAfLqnF4rf8zBIYhudJhKG+W66grY7XrAw9YM8VQH95dgvyfD+gbNOQhbYSSte25qjV41teoBcW+szyXonuhDNeFjRXmKHn0c8eAiYHes/0N2vX8/cgu9RwCOYjXoVAOrICIaZ2ZeaqblfXlUiZHWSS5j0ujj4/4VQw4DvK80Uh11C8UihbsMu+pTc7tNcvsdZ8iBifhHjewT+oi46VpZQYb5kCveuJEaeZ6GLgX7n8Ypk= test',
        'SHA256:rtdfipXHKDRm37+z4hTImv4Jv3TqdyxJziSn+csre4M',
      ],
    ];
    for (const [key, fingerprint] of keys)
      expect(await fingerprintOf(key)).toBe(fingerprint);
  });
});

describe('SSH key management', () => {
  it('adds, lists and removes your keys, audited', async () => {
    const key = await ed25519();
    const added = await addKey(owner, key);
    expect(added.fingerprint).toBe(await fingerprintOf(key));
    const listed = await call(owner, 'GET', '/api/v1/me/ssh-keys');
    expect(((await listed.json()) as { keys: { key_type: string }[] }).keys).toEqual([
      expect.objectContaining({ id: added.id, key_type: 'ssh-ed25519' }),
    ]);
    // nobody else sees or removes it
    expect(
      ((await (await call(reader, 'GET', '/api/v1/me/ssh-keys')).json()) as { keys: [] })
        .keys,
    ).toEqual([]);
    expect((await call(reader, 'DELETE', `/api/v1/me/ssh-keys/${added.id}`)).status).toBe(
      404,
    );
    expect((await call(owner, 'DELETE', `/api/v1/me/ssh-keys/${added.id}`)).status).toBe(
      204,
    );
    const audit = await q<{ action: string }>(
      dbEnv,
      "SELECT action FROM audit_events WHERE action LIKE 'ssh_key.%' ORDER BY id",
    );
    expect(audit.map((a) => a.action)).toEqual(['ssh_key.add', 'ssh_key.remove']);
  });

  it('refuses a key already in use, by anyone, as either kind', async () => {
    const key = await ed25519();
    await addKey(owner, key);
    const again = await call(reader, 'POST', '/api/v1/me/ssh-keys', {
      title: 'mine',
      public_key: key,
    });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe(
      'ssh_key_exists',
    );
    const asDeploy = await call(owner, 'POST', `/api/v1/repos/${SLUG}/deploy-keys`, {
      title: 'ci',
      public_key: key,
    });
    expect(asDeploy.status).toBe(409);
  });

  it('refuses weak keys with a reason', async () => {
    const res = await call(owner, 'POST', '/api/v1/me/ssh-keys', {
      title: 'old',
      public_key: await rsa(2048),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('invalid_ssh_key');
    expect(body.error.message).toMatch(/3072/);
  });

  it('is session-only: API tokens cannot add keys', async () => {
    const t = await createApiToken(dbEnv, owner.userId, {
      label: 'x',
      scopes: ['repo:read', 'repo:write'],
    });
    const headers = { authorization: `Bearer ${t.raw}` };
    const res = await call({ headers }, 'POST', '/api/v1/me/ssh-keys', {
      title: 'x',
      public_key: await ed25519(),
    });
    expect(res.status).toBe(403);
    expect(
      (
        await call({ headers }, 'POST', `/api/v1/repos/${SLUG}/deploy-keys`, {
          title: 'x',
          public_key: await ed25519(),
        })
      ).status,
    ).toBe(403);
  });

  it('deploy keys: repo admins only, read-only by default, audited', async () => {
    const added = await addDeployKey(await ed25519());
    expect(added.read_only).toBe(true);
    // a reader is not an admin; a stranger cannot see the repo
    const stranger = await loginAs(testEnv, 3, 'mallory');
    const body = { title: 'x', public_key: await ed25519() };
    expect(
      (await call(reader, 'POST', `/api/v1/repos/${SLUG}/deploy-keys`, body)).status,
    ).toBe(403);
    expect(
      (await call(stranger, 'POST', `/api/v1/repos/${SLUG}/deploy-keys`, body)).status,
    ).toBe(404);
    expect((await call(reader, 'GET', `/api/v1/repos/${SLUG}/deploy-keys`)).status).toBe(
      403,
    );
    const listed = await call(owner, 'GET', `/api/v1/repos/${SLUG}/deploy-keys`);
    expect(
      ((await listed.json()) as { keys: { id: string }[] }).keys.map((k) => k.id),
    ).toEqual([added.id]);
    expect(
      (await call(owner, 'DELETE', `/api/v1/repos/${SLUG}/deploy-keys/${added.id}`))
        .status,
    ).toBe(204);
    expect(
      (await call(owner, 'DELETE', `/api/v1/repos/${SLUG}/deploy-keys/${added.id}`))
        .status,
    ).toBe(404);
    const audit = await q<{ action: string; repo_id: string }>(
      dbEnv,
      "SELECT action, repo_id FROM audit_events WHERE action LIKE 'deploy_key.%' ORDER BY id",
    );
    expect(audit).toEqual([
      { action: 'deploy_key.add', repo_id: repoId },
      { action: 'deploy_key.remove', repo_id: repoId },
    ]);
  });
});

describe('POST /internal/ssh/authorize', () => {
  it('is refused on the public hostname, even with the gateway key', async () => {
    const fingerprint = (await addKey(owner, await ed25519())).fingerprint;
    const input = { fingerprint, repo: SLUG, service: 'git-upload-pack' };
    const pub = await authorize(input, { host: 'x' });
    expect(pub.status).toBe(404);
    expect(((await pub.json()) as { error: { code: string } }).error.code).toBe(
      'not_found',
    );
    // and nowhere when the deployment has no gateway configured
    const unset = await makeApp(dbEnv)(
      new Request(`https://${GATEWAY_HOST}/internal/ssh/authorize`, {
        method: 'POST',
        headers: { 'x-ssh-gateway-key': GATEWAY_KEY },
        body: JSON.stringify(input),
      }),
    );
    expect(unset.status).toBe(404);
  });

  it('needs the gateway key on the internal hostname', async () => {
    const fingerprint = (await addKey(owner, await ed25519())).fingerprint;
    const input = { fingerprint, repo: SLUG, service: 'git-upload-pack' };
    expect((await authorize(input, { key: null })).status).toBe(401);
    expect((await authorize(input, { key: 'wrong' })).status).toBe(401);
    // a signed-in session is not the gateway
    const res = await app(
      new Request(`https://${GATEWAY_HOST}/internal/ssh/authorize`, {
        method: 'POST',
        headers: { ...owner.headers, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }),
    );
    expect(res.status).toBe(401);
  });

  it('refuses unknown keys, unreadable repos and bad input', async () => {
    const unknown = await authorize({
      fingerprint: await fingerprintOf(await ed25519()),
      repo: SLUG,
      service: 'git-upload-pack',
    });
    expect(unknown.status).toBe(403);
    const fingerprint = (
      await addKey(await loginAs(testEnv, 3, 'mallory'), await ed25519())
    ).fingerprint;
    const hidden = await authorize({
      fingerprint,
      repo: SLUG,
      service: 'git-upload-pack',
    });
    const missing = await authorize({
      fingerprint,
      repo: 'acme/missing',
      service: 'git-upload-pack',
    });
    expect([hidden.status, missing.status]).toEqual([404, 404]);
    expect(
      (await authorize({ fingerprint, repo: SLUG, service: 'git-shell' })).status,
    ).toBe(400);
    expect((await authorize({ fingerprint, repo: SLUG })).status).toBe(400);
  });

  it('checks a key alone for the SSH handshake, minting nothing', async () => {
    const { fingerprint } = await addKey(owner, await ed25519());
    const known = await authorize({ fingerprint });
    expect(known.status).toBe(200);
    expect(await known.json()).toEqual({ ok: true });
    const deploy = await addDeployKey(await ed25519());
    expect((await authorize({ fingerprint: deploy.fingerprint })).status).toBe(200);
    const unknown = await authorize({
      fingerprint: await fingerprintOf(await ed25519()),
    });
    expect(unknown.status).toBe(403);
    expect(await q(dbEnv, 'SELECT * FROM ssh_tokens')).toEqual([]);
  });

  it('a user key clones with a read token that cannot push or reach LFS', async () => {
    const { fingerprint } = await addKey(reader, await ed25519());
    const t = await token(fingerprint, 'git-upload-pack');
    const adv = await advertise(t, 'git-upload-pack');
    expect(adv.status).toBe(200);
    expect(lines(new Uint8Array(await adv.arrayBuffer()))).toContain('version 2');
    expect((await lsRefs(t)).status).toBe(200);
    // the token covers upload-pack only
    expect((await advertise(t, 'git-receive-pack')).status).toBe(401);
    expect((await pushMain(t)).status).toBe(401);
    const lfs = await app(
      new Request(`https://x/${SLUG}.git/info/lfs/objects/batch`, {
        method: 'POST',
        headers: {
          authorization: basic(t),
          'content-type': 'application/vnd.git-lfs+json',
        },
        body: JSON.stringify({ operation: 'download', objects: [] }),
      }),
    );
    expect(lfs.status).toBe(401);
    // a read-only member gets no push token at all
    const push = await authorize({
      fingerprint,
      repo: SLUG,
      service: 'git-receive-pack',
    });
    expect(push.status).toBe(403);
    expect(((await push.json()) as { error: { code: string } }).error.code).toBe(
      'forbidden',
    );
  });

  it('a user key pushes as that person with a receive-pack token', async () => {
    const { fingerprint } = await addKey(owner, await ed25519());
    const t = await token(fingerprint, 'git-receive-pack');
    expect((await advertise(t, 'git-receive-pack')).status).toBe(200);
    const res = await pushMain(t);
    expect(res.status).toBe(200);
    const report = parseReport(new Uint8Array(await res.arrayBuffer()));
    expect(report.refs).toEqual({ 'refs/heads/main': 'ok' });
    // but not upload-pack
    expect((await lsRefs(t)).status).toBe(401);
  });

  it('a token is bound to its repository', async () => {
    await createRepo(dbEnv, {
      slug: 'acme/other',
      visibility: 'private',
      createdBy: owner.userId,
    });
    const { fingerprint } = await addKey(owner, await ed25519());
    const t = await token(fingerprint, 'git-upload-pack');
    expect((await advertise(t, 'git-upload-pack', 'acme/other')).status).toBe(404);
  });

  it('removing a key, or deactivating its owner, stops its tokens at once', async () => {
    const added = await addKey(owner, await ed25519());
    const t = await token(added.fingerprint, 'git-upload-pack');
    expect((await advertise(t, 'git-upload-pack')).status).toBe(200);
    expect((await call(owner, 'DELETE', `/api/v1/me/ssh-keys/${added.id}`)).status).toBe(
      204,
    );
    expect((await advertise(t, 'git-upload-pack')).status).toBe(401);

    const again = await addKey(owner, await ed25519());
    const t2 = await token(again.fingerprint, 'git-upload-pack');
    await run(dbEnv, 'UPDATE users SET active = 0 WHERE id = ?', [owner.userId]);
    expect((await advertise(t2, 'git-upload-pack')).status).toBe(401);
    expect(
      (
        await authorize({
          fingerprint: again.fingerprint,
          repo: SLUG,
          service: 'git-upload-pack',
        })
      ).status,
    ).toBe(403);
  });

  it('tokens last 60 seconds', async () => {
    const { fingerprint } = await addKey(owner, await ed25519());
    const t = await token(fingerprint, 'git-upload-pack');
    const now = Date.now();
    expect(await resolveSshToken(dbEnv, t, 'git-upload-pack', now)).not.toBeNull();
    expect(await resolveSshToken(dbEnv, t, 'git-upload-pack', now + 61_000)).toBeNull();
  });

  it('a read-only deploy key clones its repo and never writes', async () => {
    const key = await addDeployKey(await ed25519());
    const t = await token(key.fingerprint, 'git-upload-pack');
    expect((await lsRefs(t)).status).toBe(200);
    const push = await authorize({
      fingerprint: key.fingerprint,
      repo: SLUG,
      service: 'git-receive-pack',
    });
    expect(push.status).toBe(403);
    expect(((await push.json()) as { error: { code: string } }).error.code).toBe(
      'deploy_key_read_only',
    );
    // another repo is not there for it
    await createRepo(dbEnv, {
      slug: 'acme/other',
      visibility: 'public',
      createdBy: owner.userId,
    });
    expect(
      (
        await authorize({
          fingerprint: key.fingerprint,
          repo: 'acme/other',
          service: 'git-upload-pack',
        })
      ).status,
    ).toBe(404);
  });

  it('a read-write deploy key pushes; removing it stops it at once', async () => {
    const key = await addDeployKey(await ed25519(), false);
    expect(key.read_only).toBe(false);
    const t = await token(key.fingerprint, 'git-receive-pack');
    const res = await pushMain(t);
    expect(res.status).toBe(200);
    expect(parseReport(new Uint8Array(await res.arrayBuffer())).refs).toEqual({
      'refs/heads/main': 'ok',
    });
    expect(
      (await call(owner, 'DELETE', `/api/v1/repos/${SLUG}/deploy-keys/${key.id}`)).status,
    ).toBe(204);
    expect((await advertise(t, 'git-receive-pack')).status).toBe(401);
  });
});
