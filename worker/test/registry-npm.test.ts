import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { cleanDb, loginAs, makeApp, seedSchema, type TestEnv } from './helpers';
import { createRepo } from '../src/db/repos';
import { q, run } from '../src/db/client';
import { createApiToken } from '../src/auth/tokens';
import { createRequestToken } from '../src/ci/oidc';
import type { ForgeEvent } from '../src/webhooks/events';

/**
 * npm registry (issue #53): publish, install (package document and tarball),
 * dist-tags and whoami for scoped packages, with permissions from the linked
 * repo and CI job tokens limited to their own repo.
 */

const testEnv = env as unknown as TestEnv;
const dbEnv = testEnv as unknown as Env;
const HOST = 'forge.test';

type Login = Awaited<ReturnType<typeof loginAs>>;
let owner: Login;
let reader: Login;
let stranger: Login;
let repoA = '';
let repoB = '';
let events: ForgeEvent[] = [];

const app = makeApp(
  new Proxy(testEnv, {
    get: (target, key, receiver) =>
      key === 'EVENTS_QUEUE'
        ? { send: async (m: { event: ForgeEvent }) => void events.push(m.event) }
        : Reflect.get(target, key, receiver),
  }),
);

async function bearer(
  login: Login,
  scopes = ['repo:read', 'repo:write'],
): Promise<string> {
  return `Bearer ${(await createApiToken(dbEnv, login.userId, { label: 'npm', scopes })).raw}`;
}

function npm(
  method: string,
  path: string,
  auth?: string,
  body?: unknown,
): Promise<Response> {
  const headers = new Headers({ 'npm-command': 'publish' });
  if (auth) headers.set('authorization', auth);
  if (body !== undefined) headers.set('content-type', 'application/json');
  return Promise.resolve(
    app(
      new Request(`https://${HOST}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    ),
  );
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The document `npm publish` sends: one version, its tarball base64 inline. */
async function publishDoc(
  name: string,
  version: string,
  extra: Record<string, unknown> = {},
  tarball = new TextEncoder().encode(`tarball of ${name}@${version}`),
) {
  const short = name.split('/')[1]!;
  const integrity = `sha512-${btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-512', tarball))))}`;
  const shasum = hex(await crypto.subtle.digest('SHA-1', tarball));
  return {
    tarball,
    integrity,
    doc: {
      _id: name,
      name,
      'dist-tags': { latest: version } as Record<string, string>,
      versions: {
        [version]: {
          name,
          version,
          main: 'index.js',
          ...extra,
          dist: {
            integrity,
            shasum,
            tarball: `https://${HOST}/npm/${name}/-/${short}-${version}.tgz`,
          },
        },
      },
      _attachments: {
        [`${name}-${version}.tgz`]: {
          content_type: 'application/octet-stream',
          data: btoa(String.fromCharCode(...tarball)),
          length: tarball.length,
        },
      },
    },
  };
}

function encoded(name: string): string {
  return name.replace('/', '%2f');
}

beforeEach(async () => {
  await seedSchema(testEnv);
  await cleanDb(testEnv);
  events = [];
  owner = await loginAs(testEnv, 1, 'acme');
  reader = await loginAs(testEnv, 2, 'reader');
  stranger = await loginAs(testEnv, 3, 'stranger');
  repoA = (await createRepo(dbEnv, { slug: 'acme/app', createdBy: owner.userId })).id;
  repoB = (await createRepo(dbEnv, { slug: 'acme/other', createdBy: owner.userId })).id;
  await run(
    dbEnv,
    "INSERT INTO repo_members (repo_id, user_id, role) VALUES (?, ?, 'read')",
    [repoA, reader.userId],
  );
  await run(
    dbEnv,
    `INSERT INTO webhooks (id, scope, owner_id, url, secret_ciphertext, key_owner, key_version,
                           events, created_by, created_at, updated_at)
     VALUES ('hook', 'repo', ?, 'https://hooks.example.com', 'x', 'x', 1, '["package"]', ?, 0, 0)`,
    [repoA, owner.userId],
  );
});

describe('npm registry', () => {
  it('asks anonymous callers to authenticate', async () => {
    const res = await npm('GET', `/npm/${encoded('@acme/app')}`);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/^Bearer /);
    expect(await res.json()).toEqual({
      error: 'authentication required',
      code: 'unauthorized',
    });
    expect((await npm('GET', '/npm/-/whoami', await bearer(reader))).status).toBe(200);
    expect(
      await (await npm('GET', '/npm/-/whoami', await bearer(reader))).json(),
    ).toEqual({
      username: 'reader',
    });
  });

  it('publishes and installs a scoped package', async () => {
    const auth = await bearer(owner);
    const { doc, tarball, integrity } = await publishDoc('@acme/app', '1.0.0');
    const res = await npm('PUT', `/npm/${encoded('@acme/app')}`, auth, doc);
    expect(res.status, await res.clone().text()).toBe(201);

    // install, as a reader, through both spellings of the name
    const pull = await bearer(reader, ['repo:read']);
    for (const path of [`/npm/${encoded('@acme/app')}`, '/npm/@acme/app']) {
      const got = await npm('GET', path, pull);
      expect(got.status).toBe(200);
      const body = (await got.json()) as {
        name: string;
        'dist-tags': Record<string, string>;
        versions: Record<
          string,
          { main: string; dist: { tarball: string; integrity: string } }
        >;
        time: Record<string, string>;
      };
      expect(body.name).toBe('@acme/app');
      expect(body['dist-tags']).toEqual({ latest: '1.0.0' });
      expect(body.versions['1.0.0']!.main).toBe('index.js');
      expect(body.versions['1.0.0']!.dist).toMatchObject({
        integrity,
        tarball: `https://${HOST}/npm/@acme/app/-/app-1.0.0.tgz`,
      });
      expect(body.time['1.0.0']).toBeDefined();
    }
    const tgz = await npm('GET', '/npm/@acme/app/-/app-1.0.0.tgz', pull);
    expect(tgz.status).toBe(200);
    expect(new Uint8Array(await tgz.arrayBuffer())).toEqual(tarball);
    expect((await npm('GET', '/npm/@acme/app/-/app-9.9.9.tgz', pull)).status).toBe(404);

    // no publishing over a version
    const again = await npm('PUT', `/npm/${encoded('@acme/app')}`, auth, doc);
    expect(again.status).toBe(409);
    expect(((await again.json()) as { code: string }).code).toBe('version_exists');

    const audit = await q<{ action: string; target: string }>(
      dbEnv,
      "SELECT action, target FROM audit_events WHERE action LIKE 'package.%'",
    );
    expect(audit.map((a) => a.action)).toEqual(['package.publish']);
    expect(JSON.parse(audit[0]!.target)).toMatchObject({
      kind: 'npm',
      package: '@acme/app',
      version: '1.0.0',
    });
  });

  it('checks the tarball against dist.integrity and refuses bad documents', async () => {
    const auth = await bearer(owner);
    const { doc } = await publishDoc('@acme/app', '1.0.0');
    const versions = doc.versions as Record<string, { dist: Record<string, string> }>;
    versions['1.0.0']!.dist.integrity = 'sha512-AAAA';
    const res = await npm('PUT', `/npm/${encoded('@acme/app')}`, auth, doc);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('integrity_mismatch');
    const unscoped = await publishDoc('@acme/app', '1.0.0');
    expect(
      (await npm('PUT', '/npm/lodash', auth, { ...unscoped.doc, name: 'lodash' })).status,
    ).toBe(400);
    expect(
      (await npm('PUT', `/npm/${encoded('@acme/app')}`, auth, { name: '@acme/app' }))
        .status,
    ).toBe(400);
  });

  it('links a package to the repo package.json names, on this forge only', async () => {
    const auth = await bearer(owner);
    const none = await publishDoc('@acme/lib', '1.0.0');
    const missing = await npm('PUT', `/npm/${encoded('@acme/lib')}`, auth, none.doc);
    expect(missing.status).toBe(404);
    const elsewhere = await publishDoc('@acme/lib', '1.0.0', {
      repository: { type: 'git', url: 'git+https://github.com/acme/app.git' },
    });
    expect(
      (await npm('PUT', `/npm/${encoded('@acme/lib')}`, auth, elsewhere.doc)).status,
    ).toBe(404);
    const here = await publishDoc('@acme/lib', '1.0.0', {
      repository: { type: 'git', url: `git+https://${HOST}/acme/app.git` },
    });
    expect(
      (await npm('PUT', `/npm/${encoded('@acme/lib')}`, auth, here.doc)).status,
    ).toBe(201);
    const linked = await q<{ name: string; repo_id: string }>(
      dbEnv,
      "SELECT name, repo_id FROM packages WHERE kind = 'npm'",
    );
    expect(linked).toEqual([{ name: '@acme/lib', repo_id: repoA }]);
    // and inherits that repo's roles
    expect(
      (await npm('GET', `/npm/${encoded('@acme/lib')}`, await bearer(reader))).status,
    ).toBe(200);
  });

  it('maps install and publish to repo roles', async () => {
    const { doc } = await publishDoc('@acme/app', '1.0.0');
    const denied = await npm(
      'PUT',
      `/npm/${encoded('@acme/app')}`,
      await bearer(reader),
      doc,
    );
    expect(denied.status).toBe(403);
    expect(
      (await npm('PUT', `/npm/${encoded('@acme/app')}`, await bearer(owner), doc)).status,
    ).toBe(201);
    const hidden = await npm(
      'GET',
      `/npm/${encoded('@acme/app')}`,
      await bearer(stranger),
    );
    expect(hidden.status).toBe(404);
    const readOnly = await bearer(owner, ['repo:read']);
    const next = await publishDoc('@acme/app', '1.0.1');
    expect(
      (await npm('PUT', `/npm/${encoded('@acme/app')}`, readOnly, next.doc)).status,
    ).toBe(403);
  });

  it('moves dist-tags', async () => {
    const auth = await bearer(owner);
    for (const version of ['1.0.0', '2.0.0-beta.1']) {
      const { doc } = await publishDoc('@acme/app', version);
      if (version !== '1.0.0') doc['dist-tags'] = { next: version };
      expect((await npm('PUT', `/npm/${encoded('@acme/app')}`, auth, doc)).status).toBe(
        201,
      );
    }
    const tags = `/npm/-/package/${encoded('@acme/app')}/dist-tags`;
    expect(await (await npm('GET', tags, auth)).json()).toEqual({
      latest: '1.0.0',
      next: '2.0.0-beta.1',
    });
    expect((await npm('PUT', `${tags}/latest`, auth, '2.0.0-beta.1')).status).toBe(200);
    expect((await npm('PUT', `${tags}/latest`, auth, '3.0.0')).status).toBe(404);
    expect((await npm('PUT', `${tags}/beta`, await bearer(reader), '1.0.0')).status).toBe(
      403,
    );
    expect((await npm('DELETE', `${tags}/latest`, auth)).status).toBe(400);
    expect((await npm('DELETE', `${tags}/next`, auth)).status).toBe(200);
    expect(await (await npm('GET', tags, auth)).json()).toEqual({
      latest: '2.0.0-beta.1',
    });
    const audit = await q<{ action: string }>(
      dbEnv,
      "SELECT action FROM audit_events WHERE action = 'package.tag'",
    );
    expect(audit).toHaveLength(2);
  });

  it("lets a CI job token publish to its own repo's packages only", async () => {
    const id = 'run-a';
    await run(
      dbEnv,
      `INSERT INTO ci_runs (id, repo_id, head_cs, settings_version, config, requested_by, state,
                            month, reserved_micros, created_at, deadline)
       VALUES (?, ?, 'cs', 1, ?, ?, 'running', '2026-10', 0, ?, ?)`,
      [
        id,
        repoA,
        JSON.stringify({ commands: ['true'], permissions: { packages: 'write' } }),
        owner.userId,
        Date.now(),
        Date.now() + 60_000,
      ],
    );
    const auth = `Bearer ${await createRequestToken(dbEnv, id, Date.now() + 60_000)}`;
    const own = await publishDoc('@acme/app', '1.0.0');
    expect((await npm('PUT', `/npm/${encoded('@acme/app')}`, auth, own.doc)).status).toBe(
      201,
    );
    const other = await publishDoc('@acme/other', '1.0.0');
    const refused = await npm('PUT', `/npm/${encoded('@acme/other')}`, auth, other.doc);
    expect(refused.status).toBe(404);
    expect(await q(dbEnv, 'SELECT 1 FROM packages WHERE repo_id = ?', [repoB])).toEqual(
      [],
    );
    expect(events.map((e) => [e.event, e.action, e.data.version])).toEqual([
      ['package', 'published', '1.0.0'],
    ]);
  });

  it('refuses a publish from a job without permissions.packages: write', async () => {
    const id = 'run-oidc-only';
    await run(
      dbEnv,
      `INSERT INTO ci_runs (id, repo_id, head_cs, settings_version, config, requested_by, state,
                            month, reserved_micros, created_at, deadline)
       VALUES (?, ?, 'cs', 1, ?, ?, 'running', '2026-10', 0, ?, ?)`,
      [
        id,
        repoA,
        JSON.stringify({ commands: ['true'], permissions: { id_token: 'write' } }),
        owner.userId,
        Date.now(),
        Date.now() + 60_000,
      ],
    );
    const auth = `Bearer ${await createRequestToken(dbEnv, id, Date.now() + 60_000)}`;
    const doc = await publishDoc('@acme/app', '1.0.0');
    expect((await npm('PUT', `/npm/${encoded('@acme/app')}`, auth, doc.doc)).status).toBe(
      403,
    );
    expect(await q(dbEnv, 'SELECT 1 FROM packages WHERE repo_id = ?', [repoA])).toEqual(
      [],
    );
  });
});
