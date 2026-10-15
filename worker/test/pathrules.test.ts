import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { cleanDb, instrumentDb, loginAs, makeApp, seedSchema } from './helpers';
import type { TestEnv } from './helpers';
import { C, T } from '../src/db/schema';
import { run } from '../src/db/client';
import { createRepo, setRef } from '../src/db/repos';
import { parsePathRuleInput } from '../src/auth/rbac';
import { commitChanges } from '../src/core/commit';

/**
 * Path rules on every surface that can expose or change a path (#14 follow-up):
 * content-addressed surfaces need whole-repository access, listings drop
 * hidden paths, and commits need `write` on each touched path.
 *
 * Fixture: `secrets/` is unreadable for `role:read` (with a user grant
 * reopening `secrets/public/`) and unwritable for `role:write`; the admin
 * member is unrestricted.
 */

const testEnv = env as unknown as TestEnv;
const dbEnv = testEnv as unknown as Env;
const author = { name: 'Ada', email: 'ada@example.com' };
const SECRET = 'TOPSECRET-VALUE';
const BASE = '/api/v1/repos/acme/mono';

type Actor = Awaited<ReturnType<typeof loginAs>>;
let admin: Actor;
let reader: Actor;
let writer: Actor;
let repoId: string;
let base: string; // README only
let head: string; // + src/app.ts, secrets/key.pem, secrets/public/ok.txt
let secretBlob: string;

async function addMember(
  userId: string,
  role: 'admin' | 'write' | 'read',
): Promise<void> {
  await run(
    dbEnv,
    `INSERT INTO ${T.repoMembers} (${C.repoMembers.repoId}, ${C.repoMembers.userId}, ${C.repoMembers.role}) VALUES (?, ?, ?)`,
    [repoId, userId, role],
  );
}

async function addRule(input: unknown): Promise<void> {
  const rule = parsePathRuleInput(input);
  await run(
    dbEnv,
    `INSERT INTO ${T.pathRules} (${C.pathRules.repoId}, ${C.pathRules.pathPrefix}, ${C.pathRules.effect}, ${C.pathRules.principal}, ${C.pathRules.perms}) VALUES (?, ?, ?, ?, ?)`,
    [repoId, rule.path_prefix, rule.effect, rule.principal, JSON.stringify(rule.perms)],
  );
}

async function call(
  actor: Actor,
  method: string,
  tail: string,
  body?: unknown,
  bindings: Env = testEnv,
): Promise<Response> {
  return makeApp(bindings)(
    new Request(`https://x${BASE}${tail}`, {
      method,
      headers: { ...actor.headers, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

async function expectWholeRepoRequired(res: Response, prefix: string): Promise<void> {
  expect(res.status).toBe(403);
  const body = (await res.json()) as {
    error: { code: string; denied_by?: { path_prefix: string; effect: string } };
  };
  expect(body.error.code).toBe('whole_repository_required');
  expect(body.error.denied_by).toMatchObject({ path_prefix: prefix, effect: 'deny' });
}

beforeEach(async () => {
  await seedSchema(testEnv);
  await cleanDb(testEnv);
  admin = await loginAs(testEnv, 1, 'ada');
  reader = await loginAs(testEnv, 2, 'rita');
  writer = await loginAs(testEnv, 3, 'walt');
  repoId = (await createRepo(dbEnv, { slug: 'acme/mono', visibility: 'private' })).id;
  await addMember(admin.userId, 'admin');
  await addMember(reader.userId, 'read');
  await addMember(writer.userId, 'write');
  await addRule({
    path_prefix: 'secrets/',
    effect: 'deny',
    principal: 'role:read',
    perms: ['read', 'history'],
  });
  await addRule({
    path_prefix: 'secrets/public/',
    effect: 'grant',
    principal: `user:${reader.userId}`,
    perms: ['read'],
  });
  await addRule({
    path_prefix: 'secrets/',
    effect: 'deny',
    principal: 'role:write',
    perms: ['write'],
  });

  base = (
    await commitChanges(dbEnv, repoId, {
      first_parent: null,
      message: 'base',
      author,
      changes: [{ path: 'README.md', op: 'add', content_b64: btoa('hello\n') }],
    })
  ).changeset.id;
  const second = await commitChanges(dbEnv, repoId, {
    first_parent: base,
    message: 'add code and secrets',
    author,
    changes: [
      { path: 'src/app.ts', op: 'add', content_b64: btoa('export {};\n') },
      { path: 'secrets/key.pem', op: 'add', content_b64: btoa(`${SECRET}\n`) },
      { path: 'secrets/public/ok.txt', op: 'add', content_b64: btoa('fine\n') },
    ],
  });
  head = second.changeset.id;
  secretBlob = second.changeset.changed_files.find((f) => f.path === 'secrets/key.pem')
    ?.hash as string;
  await setRef(dbEnv, repoId, 'main', head);
});

describe('content-addressed surfaces need whole-repository read', () => {
  it('object/blob, object/tree, fetch-objects, checkout-info refuse partial readers', async () => {
    const root = (
      (await (await call(admin, 'GET', `/checkout-info?cs=${head}`)).json()) as {
        root_tree: string;
      }
    ).root_tree;

    const probes: [string, string, unknown?][] = [
      ['GET', `/object/blob/${secretBlob}?encoding=identity`],
      ['GET', `/object/tree/${root}`],
      ['POST', '/fetch-objects', { blobs: [secretBlob], blob_encoding: 'identity' }],
      ['GET', `/checkout-info?cs=${head}`],
    ];
    for (const [method, tail, body] of probes) {
      await expectWholeRepoRequired(await call(reader, method, tail, body), 'secrets/');
      // unrestricted member and a writer (read is not restricted for them) still work
      expect((await call(admin, method, tail, body)).status).toBe(200);
      expect((await call(writer, method, tail, body)).status).toBe(200);
    }
    const blob = await call(admin, 'GET', `/object/blob/${secretBlob}?encoding=identity`);
    expect(await blob.text()).toBe(`${SECRET}\n`);
  });

  it('tarball, fast-import and GitHub export refuse partial callers', async () => {
    await expectWholeRepoRequired(
      await call(reader, 'GET', `/export/tarball?cs=${head}`),
      'secrets/',
    );
    await expectWholeRepoRequired(
      await call(reader, 'GET', `/export/fast-import?head=${head}`),
      'secrets/',
    );
    // the writer may read everything but not write secrets/: a push to GitHub
    // replaces every path, so it needs whole-repo write
    await expectWholeRepoRequired(
      await call(writer, 'POST', '/export/github', { target_branch: 'yag-sync' }),
      'secrets/',
    );

    const tar = await call(admin, 'GET', `/export/tarball?cs=${head}`);
    expect(tar.status).toBe(200);
    await tar.arrayBuffer();
    const fi = await call(admin, 'GET', `/export/fast-import?head=${head}`);
    expect(fi.status).toBe(200);
    expect(await fi.text()).toContain(SECRET);
  });
});

describe('path-addressed listings drop hidden paths', () => {
  it('diff text=1 omits denied files and their contents', async () => {
    const res = await call(reader, 'GET', `/diff?from=${base}&to=${head}&text=1`);
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain(SECRET);
    const body = JSON.parse(raw) as {
      files: { path: string }[];
      texts: { path: string }[];
      omitted_paths_count?: number;
    };
    expect(body.files.map((f) => f.path).sort()).toEqual([
      'secrets/public/ok.txt',
      'src/app.ts',
    ]);
    expect(body.texts.map((t) => t.path)).not.toContain('secrets/key.pem');
    expect(body.omitted_paths_count).toBe(1);

    const full = (await (
      await call(admin, 'GET', `/diff?from=${base}&to=${head}&text=1`)
    ).json()) as { files: unknown[]; omitted_paths_count?: number };
    expect(full.files).toHaveLength(3);
    expect(full.omitted_paths_count).toBeUndefined();
  });

  it('changed-paths, changesets and history omit denied paths', async () => {
    const changed = (await (
      await call(reader, 'GET', `/changed-paths?cs=${head}`)
    ).json()) as { changed_files: { path: string }[]; omitted_paths_count?: number };
    expect(changed.changed_files.map((f) => f.path)).not.toContain('secrets/key.pem');
    expect(changed.omitted_paths_count).toBe(1);

    const one = (await (await call(reader, 'GET', `/changesets/${head}`)).json()) as {
      changeset: { changed_files: { path: string }[]; omitted_paths_count?: number };
    };
    expect(one.changeset.changed_files).toHaveLength(2);
    expect(one.changeset.omitted_paths_count).toBe(1);

    for (const tail of ['/changesets', `/history?cs=${head}`]) {
      const raw = await (await call(reader, 'GET', tail)).text();
      expect(raw, tail).not.toContain('secrets/key.pem');
      expect(raw, tail).toContain('src/app.ts');
    }

    const unrestricted = (await (
      await call(admin, 'GET', `/changed-paths?cs=${head}`)
    ).json()) as { changed_files: unknown[]; omitted_paths_count?: number };
    expect(unrestricted.changed_files).toHaveLength(3);
    expect(unrestricted.omitted_paths_count).toBeUndefined();
  });

  it('tree listings hide denied entries but honour a longer grant', async () => {
    const recursive = (await (
      await call(reader, 'GET', `/tree?cs=${head}&recursive=1`)
    ).json()) as {
      entries: { path: string; hash: string }[];
      omitted_paths_count?: number;
    };
    const paths = recursive.entries.map((e) => e.path);
    expect(paths).toContain('src/app.ts');
    expect(paths).toContain('secrets/public/ok.txt');
    expect(paths).not.toContain('secrets/key.pem');
    expect(paths).not.toContain('secrets'); // the denied directory itself
    expect(recursive.entries.map((e) => e.hash)).not.toContain(secretBlob);
    expect(recursive.omitted_paths_count).toBe(2);

    const flat = (await (
      await call(reader, 'GET', `/tree?cs=${head}&path=secrets`)
    ).json()) as { error: { code: string } };
    expect(flat.error.code).toBe('forbidden'); // requested path itself is guarded

    const root = (await (await call(reader, 'GET', `/tree?cs=${head}`)).json()) as {
      entries: { name: string }[];
      omitted_paths_count?: number;
    };
    expect(root.entries.map((e) => e.name).sort()).toEqual(['README.md', 'src']);
    expect(root.omitted_paths_count).toBe(1);

    const full = (await (
      await call(admin, 'GET', `/tree?cs=${head}&recursive=1`)
    ).json()) as { entries: { path: string }[]; omitted_paths_count?: number };
    expect(full.entries.map((e) => e.path)).toContain('secrets/key.pem');
    expect(full.omitted_paths_count).toBeUndefined();
  });

  it('loads path rules once per listing, not once per entry', async () => {
    const probe = instrumentDb(testEnv);
    const res = await call(
      reader,
      'GET',
      `/tree?cs=${head}&recursive=1`,
      undefined,
      probe.env,
    );
    expect(res.status).toBe(200);
    const ruleLoads = probe.prepares.filter((sql) => sql.includes(T.pathRules));
    // guardPathRead on the requested path + the batched listing filter
    expect(ruleLoads.length).toBeLessThanOrEqual(2);
  });
});

describe('deny-write path rules are enforced', () => {
  const commitBody = (path: string) => ({
    first_parent: head,
    message: 'touch',
    author,
    changes: [{ path, op: 'add', content_b64: btoa('x') }],
  });

  it('POST changesets refuses any change under a write-denied prefix', async () => {
    const denied = await call(
      writer,
      'POST',
      '/changesets',
      commitBody('secrets/new.pem'),
    );
    expect(denied.status).toBe(403);
    const body = (await denied.json()) as {
      error: { code: string; path: string; denied_by: { path_prefix: string } };
    };
    expect(body.error.code).toBe('forbidden');
    expect(body.error.path).toBe('secrets/new.pem');
    expect(body.error.denied_by.path_prefix).toBe('secrets/');

    // one denied path poisons the whole commit
    const mixed = await call(writer, 'POST', '/changesets', {
      ...commitBody('src/ok.ts'),
      changes: [
        { path: 'src/ok.ts', op: 'add', content_b64: btoa('x') },
        { path: 'secrets/key.pem', op: 'del' },
      ],
    });
    expect(mixed.status).toBe(403);

    expect(
      (await call(writer, 'POST', '/changesets', commitBody('src/ok.ts'))).status,
    ).toBe(201);
    expect(
      (await call(admin, 'POST', '/changesets', commitBody('secrets/new.pem'))).status,
    ).toBe(201);
  });

  it('PUT refs needs whole-repository write', async () => {
    const child = (
      await commitChanges(dbEnv, repoId, {
        first_parent: head,
        message: 'child',
        author,
        changes: [{ path: 'src/b.ts', op: 'add', content_b64: btoa('b') }],
      })
    ).changeset.id;
    await expectWholeRepoRequired(
      await call(writer, 'PUT', '/refs/release/x', { from: null, to: child }),
      'secrets/',
    );
    expect(
      (await call(admin, 'PUT', '/refs/release/x', { from: null, to: child })).status,
    ).toBe(200);
  });

  it('GitHub import needs whole-repository write', async () => {
    // refused before any GitHub call: an import rewrites the default branch
    await expectWholeRepoRequired(
      await call(writer, 'POST', '/import', { source: 'github:acme/app' }),
      'secrets/',
    );
  });
});
