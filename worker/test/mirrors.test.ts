import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { cleanDb, loginAs, makeApp, seedSchema, type TestEnv } from './helpers';
import type { Env } from '../src/env';
import { createRepo, getRef } from '../src/db/repos';
import { q, q1, run } from '../src/db/client';
import { createApiToken } from '../src/auth/tokens';
import { clearInstallationToken } from '../src/bridge/github';
import { commitShas } from '../src/git/upload-pack';
import { mirrorQueue, scheduleMirrors, syncMirror } from '../src/mirrors/sync';
import {
  lsRemote,
  packOfFetchResponse,
  remoteUrlProblem,
  RemoteError,
} from '../src/mirrors/remote';
import type { MirrorMessage } from '../src/mirrors/queue';
import { concatBytes, FLUSH, pktLine, sideband } from '../src/git/pktline';
import { blob, commit, packOf, pushBody, tree, ZERO, type Obj } from './git-helpers';

/**
 * Mirrors and cutover (issues #36, #73). "GitHub" here is a second forge
 * repository reached over real Git smart HTTP: the outbound fetch stub
 * routes https://github.com/<owner>/<repo>.git/... into the forge's own
 * upload-pack and receive-pack, so every byte goes through both Git
 * protocol implementations. The GitHub REST API (App tokens, archive) and
 * DNS-over-HTTPS are stubbed; nothing leaves the test.
 */

const testEnv = env as unknown as TestEnv;
type Login = Awaited<ReturnType<typeof loginAs>>;
let ada: Login; // forge admin who owns the mirrored repositories
let gh: Login; // owns the "GitHub" repositories
let stranger: Login;
let ghToken: string;

const kek = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
let queued: MirrorMessage[] = [];

function bindings(): Env {
  const values: Record<string, unknown> = {
    SECRETS_KEK: kek,
    MIRROR_QUEUE: {
      send: async (body: MirrorMessage) => {
        queued.push(body);
      },
      sendBatch: async (messages: { body: MirrorMessage }[]) => {
        queued.push(...messages.map((m) => m.body));
      },
    },
  };
  return new Proxy(testEnv, {
    get(target, key, receiver) {
      if (typeof key === 'string' && key in values) return values[key];
      return Reflect.get(target, key, receiver);
    },
  });
}

async function api(
  path: string,
  method = 'GET',
  body?: unknown,
  as: { headers: Record<string, string> } = ada,
): Promise<Response> {
  return makeApp(bindings())(
    new Request(`https://forge.test/api/v1${path}`, {
      method,
      headers: { ...as.headers, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

// --- outbound fetch: "GitHub" is the forge itself -----------------------------

const realFetch = globalThis.fetch;
let remoteCalls: Request[] = [];
let archived: boolean[] = [];
/** Overrides one remote answer (status code tests). */
let remoteOverride: ((req: Request) => Response | null) | null = null;

beforeEach(() => {
  remoteCalls = [];
  archived = [];
  clearInstallationToken(7);
  remoteOverride = null;
  queued = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as RequestInfo, init);
    const url = new URL(req.url);
    if (url.hostname === 'cloudflare-dns.com') {
      return Response.json({ Answer: [{ type: 1, data: '140.82.112.3' }] });
    }
    if (url.hostname === 'github.com') {
      remoteCalls.push(req.clone());
      const override = remoteOverride?.(req);
      if (override) return override;
      return makeApp(bindings())(
        new Request(`https://x${url.pathname}${url.search}`, req),
      );
    }
    if (url.hostname === 'api.github.com') {
      if (url.pathname === '/app/installations/7/access_tokens')
        return Response.json({ token: ghToken, expires_at: '2999-01-01T00:00:00Z' });
      if (url.pathname === '/repositories/99' && req.method === 'GET')
        return Response.json({ full_name: 'gh/widgets' });
      if (url.pathname === '/repos/gh/widgets' && req.method === 'PATCH') {
        archived.push(((await req.json()) as { archived: boolean }).archived);
        return Response.json({ full_name: 'gh/widgets' });
      }
    }
    throw new Error(`unexpected outbound fetch in test: ${req.method} ${req.url}`);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

// --- fixtures -----------------------------------------------------------------

/** Push hand-built Git objects to a forge repo over receive-pack, as `as`. */
async function gitPush(
  slug: string,
  commands: [string, string, string][],
  objects: Obj[],
  token = ghToken,
  options: string[] = [],
): Promise<Record<string, string>> {
  const pack = objects.length ? await packOf(objects) : null;
  const body = options.length
    ? concatBytes([
        pushBody(commands, null, 'report-status push-options'),
        ...options.map((o) => pktLine(o)),
        FLUSH,
        pack ?? new Uint8Array(),
      ])
    : pushBody(commands, pack, 'report-status');
  const res = await makeApp(bindings())(
    new Request(`https://x/${slug}.git/git-receive-pack`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-git-receive-pack-request',
        authorization: `Basic ${btoa(`git:${token}`)}`,
      },
      body,
    }),
  );
  expect(res.status).toBe(200);
  const text = new TextDecoder().decode(new Uint8Array(await res.arrayBuffer()));
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/(ok|ng) (\S+)( [^\n]*)?\n/g)) {
    out[m[2] as string] = m[1] === 'ok' ? 'ok' : (m[3] ?? '').trim();
  }
  return out;
}

/** A commit with one file, built as Git would (independent SHA-1s). */
async function gitCommit(
  file: string,
  parents: string[],
  message: string,
  seconds?: number,
): Promise<{ commit: Obj; objects: Obj[] }> {
  const b = await blob(file);
  const t = await tree([{ name: 'README.md', sha: b.sha }]);
  const c = await commit(t.sha, parents, message, seconds);
  return { commit: c, objects: [c, t, b] };
}

/** Git SHA-1 of every forge branch and tag, by Git ref name. */
async function shasOf(slug: string): Promise<Record<string, string>> {
  const repo = await q1<{ id: string }>(testEnv, 'SELECT id FROM repos WHERE slug = ?', [
    slug,
  ]);
  const refs = await q<{ name: string; head: string }>(
    testEnv,
    "SELECT name, head FROM refs WHERE repo_id = ? AND name NOT LIKE 'refs/agents/%'",
    [repo!.id],
  );
  const shas = await commitShas(
    testEnv,
    repo!.id,
    refs.map((r) => r.head),
  );
  return Object.fromEntries(
    refs.map((r) => [
      r.name.startsWith('refs/') ? r.name : `refs/heads/${r.name}`,
      shas.get(r.head) as string,
    ]),
  );
}

async function createMirror(
  slug: string,
  body: Record<string, unknown>,
): Promise<{ id: string }> {
  const res = await api(`/repos/${slug}/mirrors`, 'POST', body);
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { mirror: { id: string } }).mirror;
}

async function mirrorRow(id: string) {
  return (await q1(testEnv, 'SELECT * FROM mirrors WHERE id = ?', [id])) as {
    last_error: string | null;
    last_result: string;
    last_refs: string;
    enabled: number;
    credential_ciphertext: string | null;
  };
}

async function sync(id: string) {
  const outcome = await syncMirror(bindings(), id);
  if (typeof outcome === 'string') throw new Error(`sync ${outcome}`);
  return outcome;
}

let upstream: { commit: Obj; objects: Obj[] };

beforeEach(async () => {
  await seedSchema(testEnv);
  await cleanDb(testEnv);
  ada = await loginAs(testEnv, 1, 'ada');
  gh = await loginAs(testEnv, 2, 'gh');
  stranger = await loginAs(testEnv, 3, 'mallory');
  ghToken = (await createApiToken(testEnv, gh.userId, { label: 'mirror' })).raw;
  await createRepo(testEnv, {
    slug: 'gh/widgets',
    visibility: 'private',
    createdBy: gh.userId,
  });
  await createRepo(testEnv, {
    slug: 'acme/widgets',
    visibility: 'private',
    createdBy: ada.userId,
    githubInstallationId: 7,
    githubRepoId: 99,
  });
  upstream = await gitCommit('v1\n', [], 'first');
  expect(
    await gitPush(
      'gh/widgets',
      [[ZERO, upstream.commit.sha, 'refs/heads/main']],
      upstream.objects,
    ),
  ).toEqual({ 'refs/heads/main': 'ok' });
});

const REMOTE = 'https://github.com/gh/widgets.git';

// --- remote URL and client ----------------------------------------------------

describe('remote URLs and the Git client', () => {
  it('refuses URLs that would leak credentials or reach private networks', () => {
    expect(remoteUrlProblem('https://github.com/gh/widgets.git')).toBeNull();
    expect(remoteUrlProblem('http://github.com/gh/widgets.git')).toMatch(/https/);
    expect(remoteUrlProblem('https://u:p@github.com/gh/widgets.git')).toMatch(
      /credentials/,
    );
    expect(remoteUrlProblem('https://127.0.0.1/x.git')).toMatch(/private/);
    expect(remoteUrlProblem('https://169.254.169.254/x.git')).toMatch(/private/);
    expect(remoteUrlProblem('https://github.com/')).toMatch(/path/);
  });

  it('reads the pack out of a fetch response with an acknowledgments section', () => {
    const pack = new TextEncoder().encode('PACK-bytes');
    const body = concatBytes([
      pktLine('acknowledgments\n'),
      pktLine('ready\n'),
      new TextEncoder().encode('0001'),
      pktLine('packfile\n'),
      ...sideband(2, 'progress\n'),
      ...sideband(1, pack),
      FLUSH,
    ]);
    expect(new TextDecoder().decode(packOfFetchResponse(body))).toBe('PACK-bytes');
  });

  it('says so when a remote does not speak protocol v2', async () => {
    remoteOverride = () =>
      new Response(
        concatBytes([
          pktLine('# service=git-upload-pack\n'),
          FLUSH,
          pktLine(`${'a'.repeat(40)} HEAD\0multi_ack\n`),
          FLUSH,
        ]),
      );
    await expect(lsRemote({ url: REMOTE, basic: null })).rejects.toThrow(
      new RemoteError('remote does not speak Git protocol v2'),
    );
  });
});

// --- pull mirrors ---------------------------------------------------------------

describe('pull mirrors', () => {
  it('copies branches and tags with the same SHAs and follows an upstream force push', async () => {
    const tagged = await gitCommit('v2\n', [upstream.commit.sha], 'second');
    await gitPush(
      'gh/widgets',
      [
        [upstream.commit.sha, tagged.commit.sha, 'refs/heads/main'],
        [ZERO, tagged.commit.sha, 'refs/heads/feature'],
        [ZERO, upstream.commit.sha, 'refs/tags/v1'],
      ],
      tagged.objects,
    );
    const mirror = await createMirror('acme/widgets', {
      direction: 'pull',
      remote_url: REMOTE,
      auth: 'token',
      token: ghToken,
    });
    expect(queued).toEqual([{ mirror_id: mirror.id }]);

    const first = await sync(mirror.id);
    expect(first).toMatchObject({ ok: true, error: null });
    expect(await shasOf('acme/widgets')).toEqual({
      'refs/heads/main': tagged.commit.sha,
      'refs/heads/feature': tagged.commit.sha,
      'refs/tags/v1': upstream.commit.sha,
    });
    // the credential went to the remote as HTTP Basic, never in a URL
    expect(remoteCalls.every((r) => !r.url.includes(ghToken))).toBe(true);
    expect(remoteCalls[0]!.headers.get('authorization')).toBe(
      `Basic ${btoa(`x-access-token:${ghToken}`)}`,
    );

    // upstream force-pushes a branch: the mirror follows (it owns the ref)
    const rewritten = await gitCommit('v2 rewritten\n', [upstream.commit.sha], 'redo');
    expect(
      await gitPush(
        'gh/widgets',
        [[tagged.commit.sha, rewritten.commit.sha, 'refs/heads/feature']],
        rewritten.objects,
      ),
    ).toEqual({ 'refs/heads/feature': 'ok' });
    const second = await sync(mirror.id);
    expect(second.ok).toBe(true);
    expect(second.results).toContainEqual({
      ref: 'refs/heads/feature',
      status: 'updated',
    });
    expect((await shasOf('acme/widgets'))['refs/heads/feature']).toBe(
      rewritten.commit.sha,
    );

    // a deleted upstream tag goes too, and the sync is audited
    await gitPush('gh/widgets', [[upstream.commit.sha, ZERO, 'refs/tags/v1']], []);
    expect((await sync(mirror.id)).results).toContainEqual({
      ref: 'refs/tags/v1',
      status: 'deleted',
    });
    expect(await shasOf('acme/widgets')).toEqual({
      'refs/heads/main': tagged.commit.sha,
      'refs/heads/feature': rewritten.commit.sha,
    });
    const audits = await q<{ action: string; actor_kind: string; target: string }>(
      testEnv,
      "SELECT action, actor_kind, target FROM audit_events WHERE action = 'mirror.sync'",
    );
    expect(audits).toHaveLength(3);
    expect(audits.every((a) => a.actor_kind === 'system')).toBe(true);
    expect(audits.map((a) => a.target).join('')).not.toContain(ghToken);
  });

  it('leaves a ref the forge moved itself and reports the divergence', async () => {
    await gitPush('gh/widgets', [[ZERO, upstream.commit.sha, 'refs/heads/feature']], []);
    const mirror = await createMirror('acme/widgets', {
      direction: 'pull',
      remote_url: REMOTE,
      auth: 'token',
      token: ghToken,
    });
    await sync(mirror.id);
    // someone pushes to the forge while GitHub is authoritative
    const adaToken = (await createApiToken(testEnv, ada.userId, { label: 'push' })).raw;
    const local = await gitCommit('forge only\n', [upstream.commit.sha], 'local');
    await gitPush(
      'acme/widgets',
      [[upstream.commit.sha, local.commit.sha, 'refs/heads/feature']],
      local.objects,
      adaToken,
    );
    const theirs = await gitCommit('github only\n', [upstream.commit.sha], 'remote');
    await gitPush(
      'gh/widgets',
      [[upstream.commit.sha, theirs.commit.sha, 'refs/heads/feature']],
      theirs.objects,
    );

    const outcome = await sync(mirror.id);
    expect(outcome.ok).toBe(false);
    expect(outcome.results).toContainEqual(
      expect.objectContaining({ ref: 'refs/heads/feature', status: 'diverged' }),
    );
    expect((await shasOf('acme/widgets'))['refs/heads/feature']).toBe(local.commit.sha);
    const listed = (await (await api('/repos/acme/widgets/mirrors')).json()) as {
      mirrors: { last_error: string }[];
    };
    expect(listed.mirrors[0]!.last_error).toMatch(/refs\/heads\/feature diverged/);
    const audit = await q1<{ target: string }>(
      testEnv,
      "SELECT target FROM audit_events WHERE action = 'mirror.sync' ORDER BY id DESC",
    );
    expect(JSON.parse(audit!.target)).toMatchObject({ ok: false });

    // force mirroring overwrites the forge's ref with GitHub's
    await api(`/repos/acme/widgets/mirrors/${mirror.id}`, 'PATCH', { force: true });
    expect((await sync(mirror.id)).ok).toBe(true);
    expect((await shasOf('acme/widgets'))['refs/heads/feature']).toBe(theirs.commit.sha);
  });

  it('fast-forwards a ref the forge already had (an earlier import) on the first sync', async () => {
    const adaToken = (await createApiToken(testEnv, ada.userId, { label: 'push' })).raw;
    await gitPush(
      'acme/widgets',
      [[ZERO, upstream.commit.sha, 'refs/heads/main']],
      upstream.objects,
      adaToken,
    );
    const next = await gitCommit('v2\n', [upstream.commit.sha], 'second');
    await gitPush(
      'gh/widgets',
      [[upstream.commit.sha, next.commit.sha, 'refs/heads/main']],
      next.objects,
    );
    const mirror = await createMirror('acme/widgets', {
      direction: 'pull',
      remote_url: REMOTE,
      auth: 'token',
      token: ghToken,
    });
    expect((await sync(mirror.id)).ok).toBe(true);
    expect((await shasOf('acme/widgets'))['refs/heads/main']).toBe(next.commit.sha);
  });

  it('raises secret alerts for upstream history but still mirrors it (#66)', async () => {
    // built at run time so this file holds no literal key
    const key = `AKIA${Array.from({ length: 16 }, (_, i) => 'QRSTUVWXYZ234567'[(i * 7) % 16]).join('')}`;
    const leaked = await gitCommit(`aws_key = ${key}\n`, [upstream.commit.sha], 'leak');
    // "GitHub" only holds it past its own push protection
    expect(
      await gitPush(
        'gh/widgets',
        [[upstream.commit.sha, leaked.commit.sha, 'refs/heads/main']],
        leaked.objects,
        ghToken,
        ['secret-scanning.bypass=will_fix'],
      ),
    ).toEqual({ 'refs/heads/main': 'ok' });
    const mirror = await createMirror('acme/widgets', {
      direction: 'pull',
      remote_url: REMOTE,
      auth: 'token',
      token: ghToken,
    });
    expect(await sync(mirror.id)).toMatchObject({ ok: true, error: null });
    expect((await shasOf('acme/widgets'))['refs/heads/main']).toBe(leaked.commit.sha);
    const repo = await q1<{ id: string }>(
      testEnv,
      'SELECT id FROM repos WHERE slug = ?',
      ['acme/widgets'],
    );
    const alerts = await q<{
      source: string;
      path: string;
      state: string;
      changeset_id: string;
    }>(
      testEnv,
      'SELECT source, path, state, changeset_id FROM secret_alerts WHERE repo_id = ?',
      [repo!.id],
    );
    expect(alerts).toEqual([
      expect.objectContaining({ source: 'history', path: 'README.md', state: 'open' }),
    ]);
    expect(alerts[0]!.changeset_id).toBe((await getRef(testEnv, repo!.id, 'main'))!.head);
  });

  it('records remote failures without the credential', async () => {
    const spies = [
      vi.spyOn(console, 'error'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'log'),
    ];
    const mirror = await createMirror('acme/widgets', {
      direction: 'pull',
      remote_url: REMOTE,
      auth: 'token',
      token: ghToken,
    });
    remoteOverride = () => new Response(`bad credentials ${ghToken}`, { status: 401 });
    const outcome = await sync(mirror.id);
    expect(outcome).toMatchObject({
      ok: false,
      error: 'remote refused the credentials (HTTP 401)',
    });
    const row = await mirrorRow(mirror.id);
    expect(JSON.stringify(row)).not.toContain(ghToken);
    const audits = await q(testEnv, 'SELECT * FROM audit_events');
    expect(JSON.stringify(audits)).not.toContain(ghToken);
    const listed = await (await api('/repos/acme/widgets/mirrors')).text();
    expect(listed).not.toContain(ghToken);
    expect(listed).toContain('"has_token":true');
    for (const spy of spies)
      expect(JSON.stringify(spy.mock.calls)).not.toContain(ghToken);
  });

  it('stops when the creator is no longer an admin', async () => {
    const mirror = await createMirror('acme/widgets', {
      direction: 'pull',
      remote_url: REMOTE,
      auth: 'token',
      token: ghToken,
    });
    await run(testEnv, 'UPDATE mirrors SET created_by = ? WHERE id = ?', [
      stranger.userId,
      mirror.id,
    ]);
    expect((await sync(mirror.id)).error).toMatch(/no longer an admin/);
    expect(remoteCalls).toHaveLength(0);
  });
});

// --- push mirrors ---------------------------------------------------------------

describe('push mirrors', () => {
  async function seedForge(): Promise<void> {
    const adaToken = (await createApiToken(testEnv, ada.userId, { label: 'push' })).raw;
    await gitPush(
      'acme/widgets',
      [[ZERO, upstream.commit.sha, 'refs/heads/main']],
      upstream.objects,
      adaToken,
    );
  }

  it('pushes forge refs with the same SHAs, and follows every ref move', async () => {
    await createRepo(testEnv, {
      slug: 'gh/empty',
      visibility: 'private',
      createdBy: gh.userId,
    });
    const adaToken = (await createApiToken(testEnv, ada.userId, { label: 'push' })).raw;
    const second = await gitCommit('v2\n', [upstream.commit.sha], 'second');
    await gitPush(
      'acme/widgets',
      [
        [ZERO, second.commit.sha, 'refs/heads/main'],
        [ZERO, upstream.commit.sha, 'refs/tags/v1'],
      ],
      [...upstream.objects, ...second.objects],
      adaToken,
    );
    const mirror = await createMirror('acme/widgets', {
      direction: 'push',
      remote_url: 'https://github.com/gh/empty.git',
      auth: 'token',
      token: ghToken,
    });
    expect((await sync(mirror.id)).ok).toBe(true);
    expect(await shasOf('gh/empty')).toEqual(await shasOf('acme/widgets'));
    expect((await shasOf('gh/empty'))['refs/heads/main']).toBe(second.commit.sha);

    // an accepted push to the forge queues the push mirror at once
    queued = [];
    const third = await gitCommit('v3\n', [second.commit.sha], 'third');
    await gitPush(
      'acme/widgets',
      [[second.commit.sha, third.commit.sha, 'refs/heads/main']],
      third.objects,
      adaToken,
    );
    expect(queued).toEqual([{ mirror_id: mirror.id }]);
    const acks: string[] = [];
    await mirrorQueue(
      {
        queue: 'mirror-sync',
        messages: queued.map((body) => ({
          body,
          attempts: 1,
          ack: () => acks.push('ack'),
          retry: () => acks.push('retry'),
        })),
      } as unknown as MessageBatch<MirrorMessage>,
      bindings(),
    );
    expect(acks).toEqual(['ack']);
    expect((await shasOf('gh/empty'))['refs/heads/main']).toBe(third.commit.sha);
  });

  it('never rewrites remote history unless force is on', async () => {
    await seedForge();
    // GitHub gets commits the forge does not have, on main and on a branch
    const theirs = await gitCommit('github only\n', [upstream.commit.sha], 'remote');
    await gitPush(
      'gh/widgets',
      [
        [upstream.commit.sha, theirs.commit.sha, 'refs/heads/main'],
        [ZERO, theirs.commit.sha, 'refs/heads/feature'],
      ],
      theirs.objects,
    );
    const ours = await gitCommit('forge\n', [upstream.commit.sha], 'forge');
    const adaToken = (await createApiToken(testEnv, ada.userId, { label: 'push2' })).raw;
    await gitPush(
      'acme/widgets',
      [
        [upstream.commit.sha, ours.commit.sha, 'refs/heads/main'],
        [ZERO, ours.commit.sha, 'refs/heads/feature'],
      ],
      ours.objects,
      adaToken,
    );
    const mirror = await createMirror('acme/widgets', {
      direction: 'push',
      remote_url: REMOTE,
      auth: 'token',
      token: ghToken,
    });
    const blocked = await sync(mirror.id);
    expect(blocked.ok).toBe(false);
    expect(blocked.results.map((r) => [r.ref, r.status]).sort()).toEqual([
      ['refs/heads/feature', 'diverged'],
      ['refs/heads/main', 'diverged'],
    ]);
    expect((await shasOf('gh/widgets'))['refs/heads/feature']).toBe(theirs.commit.sha);

    // force overwrites; the remote's own refusal (its default branch is
    // protected, as a GitHub branch protection would be) is reported per ref
    await api(`/repos/acme/widgets/mirrors/${mirror.id}`, 'PATCH', { force: true });
    const forced = await sync(mirror.id);
    expect(forced.results).toContainEqual({
      ref: 'refs/heads/feature',
      status: 'forced',
    });
    expect(forced.results).toContainEqual({
      ref: 'refs/heads/main',
      status: 'failed',
      detail: 'protected_branch: force pushes to the default branch are not allowed',
    });
    expect((await shasOf('gh/widgets'))['refs/heads/feature']).toBe(ours.commit.sha);
    expect((await shasOf('gh/widgets'))['refs/heads/main']).toBe(theirs.commit.sha);
  });

  it('reports a refusal from the remote per ref', async () => {
    await seedForge();
    const mirror = await createMirror('acme/widgets', {
      direction: 'push',
      remote_url: 'https://github.com/gh/missing.git',
      auth: 'token',
      token: ghToken,
    });
    expect((await sync(mirror.id)).error).toBe('remote repository not found (HTTP 404)');
  });
});

// --- scheduling and the queue -----------------------------------------------------

describe('scheduling', () => {
  it('queues due mirrors and retries a held one', async () => {
    const mirror = await createMirror('acme/widgets', {
      direction: 'pull',
      remote_url: REMOTE,
      auth: 'token',
      token: ghToken,
      interval_s: 600,
    });
    queued = [];
    await scheduleMirrors(bindings());
    expect(queued).toEqual([{ mirror_id: mirror.id }]);
    await sync(mirror.id);
    queued = [];
    await scheduleMirrors(bindings());
    expect(queued).toEqual([]);
    await scheduleMirrors(bindings(), Date.now() + 601_000);
    expect(queued).toEqual([{ mirror_id: mirror.id }]);

    await run(testEnv, 'UPDATE mirrors SET lease_until = ? WHERE id = ?', [
      Date.now() + 60_000,
      mirror.id,
    ]);
    const acks: string[] = [];
    await mirrorQueue(
      {
        queue: 'mirror-sync',
        messages: [
          {
            body: { mirror_id: mirror.id },
            attempts: 1,
            ack: () => acks.push('ack'),
            retry: () => acks.push('retry'),
          },
        ],
      } as unknown as MessageBatch<MirrorMessage>,
      bindings(),
    );
    expect(acks).toEqual(['retry']);
  });
});

// --- API --------------------------------------------------------------------------

describe('mirror API', () => {
  it('is for repository admins with a session, and keeps the token write-only', async () => {
    const body = { direction: 'pull', remote_url: REMOTE, auth: 'token', token: ghToken };
    expect(
      (await api('/repos/acme/widgets/mirrors', 'POST', body, stranger)).status,
    ).toBe(404);
    const token = (await createApiToken(testEnv, ada.userId, { label: 'api' })).raw;
    const viaToken = await api('/repos/acme/widgets/mirrors', 'GET', undefined, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(viaToken.status).toBe(401);
    for (const [bad, code] of [
      [{ ...body, remote_url: `https://x:${ghToken}@github.com/gh/widgets.git` }, 400],
      [{ ...body, remote_url: 'https://10.0.0.1/repo.git' }, 400],
      [{ ...body, token: undefined }, 400],
      [
        {
          ...body,
          auth: 'github_app',
          token: undefined,
          remote_url: 'https://gitlab.com/a/b.git',
        },
        400,
      ],
    ] as const) {
      expect((await api('/repos/acme/widgets/mirrors', 'POST', bad)).status).toBe(code);
    }
    const created = await createMirror('acme/widgets', body);
    const row = await mirrorRow(created.id);
    expect(row.credential_ciphertext).not.toBeNull();
    expect(JSON.stringify(row)).not.toContain(ghToken);
    const audit = await q1<{ target: string }>(
      testEnv,
      "SELECT target FROM audit_events WHERE action = 'mirror.create'",
    );
    expect(JSON.parse(audit!.target)).toMatchObject({
      host: 'github.com',
      auth: 'token',
    });
    expect(audit!.target).not.toContain(ghToken);

    const synced = await api(`/repos/acme/widgets/mirrors/${created.id}/sync`, 'POST');
    expect(synced.status).toBe(200);
    expect(await synced.json()).toMatchObject({ ok: true, mirror: { enabled: true } });
    expect(
      (await api(`/repos/acme/widgets/mirrors/${created.id}`, 'DELETE')).status,
    ).toBe(200);
    expect(await q(testEnv, 'SELECT id FROM mirrors')).toEqual([]);
  });

  it('uses the GitHub App installation token when asked to', async () => {
    const mirror = await createMirror('acme/widgets', {
      direction: 'pull',
      remote_url: REMOTE,
      auth: 'github_app',
    });
    expect((await sync(mirror.id)).ok).toBe(true);
    expect((await shasOf('acme/widgets'))['refs/heads/main']).toBe(upstream.commit.sha);
  });
});

// --- cutover ----------------------------------------------------------------------

describe('cutover state machine', () => {
  async function move(body: Record<string, unknown>) {
    const res = await api('/repos/acme/widgets/migration', 'POST', body);
    return {
      status: res.status,
      body: (await res.json()) as {
        migration?: { state: string };
        error?: {
          code: string;
          message: string;
          checks?: { name: string; ok: boolean }[];
        };
      },
    };
  }

  it('moves github -> mirror -> dual -> cutover -> dual without losing commits or issues', async () => {
    const pullMirror = await createMirror('acme/widgets', {
      direction: 'pull',
      remote_url: REMOTE,
      auth: 'github_app',
      enabled: false,
    });
    const pushMirror = await createMirror('acme/widgets', {
      direction: 'push',
      remote_url: REMOTE,
      auth: 'github_app',
      enabled: false,
    });

    // skipping a stage is refused
    expect((await move({ to: 'dual' })).body.error?.code).toBe('invalid_transition');
    const noMirror = await move({ to: 'mirror' });
    expect(noMirror.status).toBe(409);
    expect(noMirror.body.error?.code).toBe('transition_blocked');

    expect(
      (await move({ to: 'mirror', pull_mirror_id: pullMirror.id })).body.migration,
    ).toMatchObject({ state: 'mirror' });
    expect(queued).toContainEqual({ mirror_id: pullMirror.id });
    expect((await mirrorRow(pullMirror.id)).enabled).toBe(1);

    // the pull mirror cannot be turned on again once the forge is primary
    const issue = await api('/repos/acme/widgets/issues', 'POST', { title: 'keep me' });
    expect(issue.status).toBe(201);

    // dual needs rulesets, members and green forge CI: blocked with reasons
    const blocked = await move({ to: 'dual', push_mirror_id: pushMirror.id });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error?.code).toBe('transition_blocked');
    const failing = blocked.body.error?.checks?.filter((c) => !c.ok).map((c) => c.name);
    expect(failing).toEqual(['rulesets', 'members', 'ci']);
    expect((await shasOf('acme/widgets'))['refs/heads/main']).toBe(upstream.commit.sha);

    const repo = await q1<{ id: string }>(
      testEnv,
      "SELECT id FROM repos WHERE slug = 'acme/widgets'",
    );
    await api('/repos/acme/widgets/rulesets', 'POST', {
      name: 'main',
      target: 'branch',
      enforcement: 'active',
      conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
      rules: [{ type: 'deletion' }],
      bypass: ['role:admin'],
    });
    await run(testEnv, "INSERT INTO repo_members VALUES (?, ?, 'write')", [
      repo!.id,
      gh.userId,
    ]);
    const head = await getRef(testEnv, repo!.id, 'main');
    await run(
      testEnv,
      `INSERT INTO ci_runs (id, repo_id, head_cs, settings_version, config, requested_by, state, month, reserved_micros, created_at)
       VALUES ('run1', ?, ?, 1, '{}', ?, 'passed', '2026-10', 0, ?)`,
      [repo!.id, head!.head, ada.userId, Date.now()],
    );
    const dual = await move({ to: 'dual', push_mirror_id: pushMirror.id });
    expect(dual.body.migration).toMatchObject({ state: 'dual' });
    expect((await mirrorRow(pullMirror.id)).enabled).toBe(0);
    expect((await mirrorRow(pushMirror.id)).enabled).toBe(1);
    const reenable = await api(`/repos/acme/widgets/mirrors/${pullMirror.id}`, 'PATCH', {
      enabled: true,
    });
    expect(reenable.status).toBe(409);

    // in dual a forge push queues the push mirror, which lands the same SHA
    queued = [];
    const adaToken = (await createApiToken(testEnv, ada.userId, { label: 'push' })).raw;
    const work = await gitCommit('forge work\n', [upstream.commit.sha], 'forge work');
    expect(
      await gitPush(
        'acme/widgets',
        [[upstream.commit.sha, work.commit.sha, 'refs/heads/main']],
        work.objects,
        adaToken,
      ),
    ).toEqual({ 'refs/heads/main': 'ok' });
    expect(queued).toEqual([{ mirror_id: pushMirror.id }]);
    await sync(pushMirror.id);
    expect((await shasOf('gh/widgets'))['refs/heads/main']).toBe(work.commit.sha);

    // cutover archives GitHub only with the typed approval
    const unapproved = await move({ to: 'cutover' });
    expect(
      unapproved.body.error?.checks?.filter((c) => !c.ok).map((c) => c.name),
    ).toEqual(['approval']);
    expect(archived).toEqual([]);
    const cutover = await move({ to: 'cutover', confirm: 'acme/widgets' });
    expect(cutover.body.migration).toMatchObject({ state: 'cutover' });
    expect(archived).toEqual([true]);
    expect((await mirrorRow(pushMirror.id)).enabled).toBe(0);

    // and back to dual: unarchive, push mirror on again
    expect((await move({ to: 'dual' })).status).toBe(409);
    const back = await move({ to: 'dual', confirm: 'acme/widgets' });
    expect(back.body.migration).toMatchObject({ state: 'dual' });
    expect(archived).toEqual([true, false]);
    expect((await mirrorRow(pushMirror.id)).enabled).toBe(1);

    expect((await shasOf('acme/widgets'))['refs/heads/main']).toBe(work.commit.sha);
    expect((await shasOf('gh/widgets'))['refs/heads/main']).toBe(work.commit.sha);
    const issues = (await (await api('/repos/acme/widgets/issues')).json()) as {
      issues: { title: string }[];
    };
    expect(issues.issues.map((i) => i.title)).toEqual(['keep me']);

    const status = (await (await api('/repos/acme/widgets/migration')).json()) as {
      state: string;
      transitions: { to: string }[];
    };
    expect(status.state).toBe('dual');
    expect(status.transitions.map((t) => t.to)).toEqual(['cutover', 'mirror']);
    const audits = await q<{ target: string }>(
      testEnv,
      "SELECT target FROM audit_events WHERE action = 'repo.migration' ORDER BY id",
    );
    expect(audits.map((a) => JSON.parse(a.target).to)).toEqual([
      'mirror',
      'dual',
      'cutover',
      'dual',
    ]);
  });

  it('blocks dual -> mirror while GitHub is behind the forge', async () => {
    const pullMirror = await createMirror('acme/widgets', {
      direction: 'pull',
      remote_url: REMOTE,
      auth: 'github_app',
      enabled: false,
    });
    const pushMirror = await createMirror('acme/widgets', {
      direction: 'push',
      remote_url: REMOTE,
      auth: 'github_app',
      enabled: false,
    });
    const repo = await q1<{ id: string }>(
      testEnv,
      "SELECT id FROM repos WHERE slug = 'acme/widgets'",
    );
    await run(
      testEnv,
      `INSERT INTO repo_migrations (repo_id, state, pull_mirror_id, push_mirror_id, updated_by, updated_at)
       VALUES (?, 'dual', ?, ?, ?, ?)`,
      [repo!.id, pullMirror.id, pushMirror.id, ada.userId, Date.now()],
    );
    await run(testEnv, 'UPDATE mirrors SET enabled = 1 WHERE id = ?', [pushMirror.id]);
    // GitHub refuses the push: the remote stays behind
    remoteOverride = (req) =>
      req.url.includes('git-receive-pack') ? new Response('', { status: 403 }) : null;
    const adaToken = (await createApiToken(testEnv, ada.userId, { label: 'push' })).raw;
    const work = await gitCommit('forge work\n', [], 'forge root');
    await gitPush(
      'acme/widgets',
      [[ZERO, work.commit.sha, 'refs/heads/main']],
      work.objects,
      adaToken,
    );
    const res = await api('/repos/acme/widgets/migration', 'POST', { to: 'mirror' });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/last sync failed/);
  });
});
