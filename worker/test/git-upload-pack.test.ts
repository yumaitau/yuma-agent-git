import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { cleanDb, loginAs, makeApp, seedSchema, type TestEnv } from './helpers';
import { commandBody, lines, parseFetch } from './git-helpers';
import { createRepo, getRef, setRef } from '../src/db/repos';
import { run } from '../src/db/client';
import { createApiToken } from '../src/auth/tokens';
import { commitChanges } from '../src/core/commit';
import { commitShas } from '../src/git/upload-pack';
import { readPack } from '../src/git/pack-reader';
import { parseCommit, parseTree } from '../src/git/objects';

const testEnv = env as unknown as TestEnv;
const dbEnv = testEnv as unknown as Env;
const app = makeApp(testEnv);
const SLUG = 'acme/wire';
const LIMITS = { maxObjects: 1000, maxObjectBytes: 1 << 20, maxTotalBytes: 1 << 24 };

let auth = '';
let repoId = '';

function b64(text: string): string {
  return btoa(text);
}

function request(
  path: string,
  init: { body?: Uint8Array; headers?: Record<string, string> } = {},
): Promise<Response> {
  return Promise.resolve(
    app(
      new Request(`https://x/${SLUG}.git/${path}`, {
        method: init.body ? 'POST' : 'GET',
        headers: {
          ...(init.body
            ? { 'content-type': 'application/x-git-upload-pack-request' }
            : {}),
          'git-protocol': 'version=2',
          authorization: auth,
          ...init.headers,
        },
        body: init.body,
      }),
    ),
  );
}

async function command(name: string, args: string[]): Promise<Uint8Array> {
  const res = await request('git-upload-pack', { body: commandBody(name, args) });
  expect(res.status).toBe(200);
  return new Uint8Array(await res.arrayBuffer());
}

/** main: c1 adds two files, c2 edits one; returns their Git SHAs. */
async function seedHistory(): Promise<{ c1: string; c2: string }> {
  const first = await commitChanges(dbEnv, repoId, {
    first_parent: null,
    message: 'first\n',
    author: { name: 'Ada', email: 'ada@example.com' },
    changes: [
      { path: 'README.md', op: 'add', content_b64: b64('hello\n') },
      { path: 'src/lib.ts', op: 'add', content_b64: b64('export {};\n') },
    ],
  });
  const second = await commitChanges(dbEnv, repoId, {
    first_parent: first.changeset.id,
    message: 'second\n',
    author: { name: 'Ada', email: 'ada@example.com' },
    changes: [{ path: 'README.md', op: 'mod', content_b64: b64('hello again\n') }],
  });
  await setRef(dbEnv, repoId, 'main', second.changeset.id);
  const shas = await commitShas(dbEnv, repoId, [first.changeset.id, second.changeset.id]);
  return {
    c1: shas.get(first.changeset.id) as string,
    c2: shas.get(second.changeset.id) as string,
  };
}

async function fetchObjects(args: string[]): Promise<{
  lines: string[];
  objects: Map<string, { type: string; body: Uint8Array }>;
}> {
  const parsed = parseFetch(await command('fetch', args));
  expect(parsed.errors).toBe('');
  const objects = await readPack(parsed.pack, LIMITS, async () => null);
  return { lines: parsed.lines, objects };
}

describe('git upload-pack (protocol v2)', () => {
  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
    const owner = await loginAs(testEnv, 1, 'ada');
    const repo = await createRepo(dbEnv, { slug: SLUG, createdBy: owner.userId });
    repoId = repo.id;
    const token = await createApiToken(dbEnv, owner.userId, { label: 'git' });
    auth = `Basic ${btoa(`git:${token.raw}`)}`;
  });

  it('asks anonymous callers for credentials and accepts Basic or Bearer tokens', async () => {
    const anon = await request('info/refs?service=git-upload-pack', {
      headers: { authorization: '' },
    });
    expect(anon.status).toBe(401);
    expect(anon.headers.get('www-authenticate')).toMatch(/^Basic realm=/);

    const basic = await request('info/refs?service=git-upload-pack');
    expect(basic.status).toBe(200);
    expect(lines(new Uint8Array(await basic.arrayBuffer()))).toEqual([
      'version 2',
      'agent=yuma-agent-git/1',
      'ls-refs=unborn',
      'fetch=shallow filter',
      'object-format=sha1',
      '0000',
    ]);

    const token = atob(auth.slice('Basic '.length)).split(':')[1] as string;
    const bearer = await request('info/refs?service=git-upload-pack', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(bearer.status).toBe(200);
  });

  it('tells protocol v0 and v1 clients to use protocol v2', async () => {
    const res = await request('info/refs?service=git-upload-pack', {
      headers: { 'git-protocol': '' },
    });
    expect(lines(new Uint8Array(await res.arrayBuffer()))).toEqual([
      '# service=git-upload-pack',
      '0000',
      expect.stringMatching(/^ERR .*protocol v2/),
    ]);
  });

  it('hides unreadable repos and refuses path-restricted readers with path_restricted', async () => {
    const stranger = await loginAs(testEnv, 2, 'mallory');
    const strangerToken = await createApiToken(dbEnv, stranger.userId, { label: 'git' });
    const hidden = await request('info/refs?service=git-upload-pack', {
      headers: { authorization: `Bearer ${strangerToken.raw}` },
    });
    expect(hidden.status).toBe(404);

    await run(
      dbEnv,
      'INSERT INTO repo_members (repo_id, user_id, role) VALUES (?, ?, ?)',
      [repoId, stranger.userId, 'read'],
    );
    await run(
      dbEnv,
      `INSERT INTO path_rules (repo_id, path_prefix, effect, principal, perms) VALUES (?, ?, 'deny', ?, ?)`,
      [repoId, 'secrets/', `user:${stranger.userId}`, JSON.stringify(['read'])],
    );
    const restricted = await request('info/refs?service=git-upload-pack', {
      headers: { authorization: `Bearer ${strangerToken.raw}` },
    });
    expect(restricted.status).toBe(200);
    const body = lines(new Uint8Array(await restricted.arrayBuffer()));
    expect(body[2]).toMatch(/^ERR path_restricted: /);
    expect(body.join('\n')).not.toContain('secrets');
  });

  it('ls-refs lists HEAD as a symref, branches and tags, and hides agent refs', async () => {
    const empty = lines(
      await command('ls-refs', ['symrefs', 'unborn', 'ref-prefix HEAD']),
    );
    expect(empty).toEqual(['unborn HEAD symref-target:refs/heads/main', '0000']);

    const { c2 } = await seedHistory();
    const head = (await getRef(dbEnv, repoId, 'main'))?.head as string;
    await setRef(dbEnv, repoId, 'refs/tags/v1', head);
    await setRef(dbEnv, repoId, 'refs/agents/t1/work', head);

    const all = lines(await command('ls-refs', ['symrefs', 'peel']));
    expect(all).toEqual([
      `${c2} HEAD symref-target:refs/heads/main`,
      `${c2} refs/heads/main`,
      `${c2} refs/tags/v1`,
      '0000',
    ]);
    const onlyHead = lines(await command('ls-refs', ['symrefs', 'ref-prefix HEAD']));
    expect(onlyHead).toEqual([`${c2} HEAD symref-target:refs/heads/main`, '0000']);
    const agents = lines(await command('ls-refs', ['ref-prefix refs/agents/']));
    expect(agents).toEqual([`${c2} refs/agents/t1/work`, '0000']);
  });

  it('fetch sends a full pack whose objects hash to the advertised SHAs', async () => {
    const { c1, c2 } = await seedHistory();
    const { lines: head, objects } = await fetchObjects([
      `want ${c2}`,
      'ofs-delta',
      'done',
    ]);
    expect(head).toEqual(['packfile', '0000']);
    // 2 commits, 2 root trees, 1 src tree, 3 blobs (README twice, lib.ts)
    expect(objects.size).toBe(8);
    const tip = parseCommit(objects.get(c2)?.body as Uint8Array);
    expect(tip.parents).toEqual([c1]);
    const root = parseTree(objects.get(tip.tree)?.body as Uint8Array);
    expect(root.map((e) => e.name)).toEqual(['README.md', 'src']);
    for (const entry of root) expect(objects.has(entry.sha)).toBe(true);
  });

  it('fetch with a common have acknowledges it and sends only the new objects', async () => {
    const { c1, c2 } = await seedHistory();
    const { lines: head, objects } = await fetchObjects([`want ${c2}`, `have ${c1}`]);
    expect(head).toEqual([
      'acknowledgments',
      `ACK ${c1}`,
      'ready',
      '0001',
      'packfile',
      '0000',
    ]);
    // the new commit, its root tree and the edited README; src/ is unchanged
    expect(objects.size).toBe(3);

    const unknown = 'f'.repeat(40);
    const nak = lines(await command('fetch', [`want ${c2}`, `have ${unknown}`]));
    expect(nak).toEqual(['acknowledgments', 'NAK', '0000']);
  });

  it('fetch honours deepen and the blob:none and tree:0 filters', async () => {
    const { c2 } = await seedHistory();
    const shallow = await fetchObjects([`want ${c2}`, 'deepen 1', 'done']);
    expect(shallow.lines).toEqual([
      'shallow-info',
      `shallow ${c2}`,
      '0001',
      'packfile',
      '0000',
    ]);
    expect([...shallow.objects.values()].filter((o) => o.type === 'commit')).toHaveLength(
      1,
    );

    const noBlobs = await fetchObjects([`want ${c2}`, 'filter blob:none', 'done']);
    expect([...noBlobs.objects.values()].map((o) => o.type).sort()).toEqual([
      'commit',
      'commit',
      'tree',
      'tree',
      'tree',
    ]);
    const commitsOnly = await fetchObjects([`want ${c2}`, 'filter tree:0', 'done']);
    expect([...commitsOnly.objects.values()].every((o) => o.type === 'commit')).toBe(
      true,
    );

    // a partial clone fetches a missing blob by its SHA
    const readme = parseTree(
      noBlobs.objects.get(parseCommit(noBlobs.objects.get(c2)?.body as Uint8Array).tree)
        ?.body as Uint8Array,
    )[0];
    const lazy = await fetchObjects([`want ${readme?.sha}`, 'done']);
    expect(new TextDecoder().decode(lazy.objects.get(readme?.sha as string)?.body)).toBe(
      'hello again\n',
    );
  });

  it('refuses objects the repo does not have and malformed requests', async () => {
    await seedHistory();
    const missing = lines(await command('fetch', [`want ${'a'.repeat(40)}`, 'done']));
    expect(missing[0]).toMatch(/^ERR upload-pack: not our ref/);
    const filter = lines(
      await command('fetch', [`want ${'a'.repeat(40)}`, 'filter blob:limit=1k']),
    );
    expect(filter[0]).toMatch(/^ERR filter "blob:limit=1k" is not supported/);
    const res = await request('git-upload-pack', {
      body: new TextEncoder().encode('zzzz'),
    });
    expect(lines(new Uint8Array(await res.arrayBuffer()))[0]).toMatch(
      /^ERR invalid pkt-line/,
    );
  });
});
