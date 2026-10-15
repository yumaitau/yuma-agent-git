import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { gzipSync } from 'node:zlib';
import type { Env } from '../../src/env';
import { cleanDb, instrumentQueues, makeApp, seedSchema } from '../helpers';
import type { TestEnv } from '../helpers';
import { C, T } from '../../src/db/schema';
import { q, q1 } from '../../src/db/client';
import { isAncestorDag } from '../../src/core/ancestry';
import { setChatProvider, type ChatResult } from '../../src/agents/llm';
import { importQueue } from '../../src/queues/import';
import { agentJobsQueue, type AgentJobMessage } from '../../src/queues/agentJobs';
import type { ImportMessage } from '../../src/bridge/import';
import { concat, gunzipIfNeeded, parseTar, tarEnd, tarEntry } from '../../src/bridge/tar';

/**
 * Golden path (issue #22): one continuous story through the HTTP surface —
 * OAuth login → create repo → connect GitHub → snapshot import → browse →
 * agent task (scripted model) reads, commits, lands → diff → export.
 *
 * Queues are not consumed by the test runtime, so sends are captured with
 * `instrumentQueues` and handed to the real consumers as mock batches. The
 * model is the scripted chat provider (Workers AI has no local simulator).
 * Superfan anomaly detection is not part of this story — it has no HTTP
 * trigger beyond config and is covered by test/agent-loop.test.ts.
 */

const testEnv = env as unknown as TestEnv;
const dbEnv = testEnv as unknown as Env;
const enc = new TextEncoder();
const dec = new TextDecoder();
const SLUG = 'acme/golden';
const GH_SHA = 'f'.repeat(40);

// ---------------------------------------------------------------------------
// GitHub stub: OAuth + App installation + repo + tarball, one global fetch
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;
const outbound: string[] = [];

const snapshotFiles: Record<string, string> = {
  'README.md': '# golden\n',
  'src/app.ts': 'export const answer = 42;\n',
  'src/util/math.ts': 'export const add = (a: number, b: number) => a + b;\n',
};

function snapshotTarball(): Uint8Array {
  const chunks = Object.entries(snapshotFiles).map(([path, content]) =>
    tarEntry(`acme-golden-${GH_SHA.slice(0, 7)}/${path}`, enc.encode(content)),
  );
  chunks.push(tarEnd());
  return gzipSync(Buffer.from(concat(chunks))) as unknown as Uint8Array;
}

function mockGithub(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as RequestInfo, init);
    const url = new URL(req.url);
    outbound.push(`${req.method} ${url.host}${url.pathname}`);
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    // OAuth (same shapes as test/auth.test.ts)
    if (url.href === 'https://github.com/login/oauth/access_token') {
      return json({ access_token: 'gh-access-token' });
    }
    if (url.href === 'https://api.github.com/user') {
      return json({ id: 4242, login: 'octo', avatar_url: 'https://x/a.png' });
    }
    if (url.href === 'https://api.github.com/user/emails') {
      return json([{ email: 'octo@example.com', primary: true, verified: true }]);
    }

    // GitHub App: installation token + connect checks
    if (url.pathname.endsWith('/access_tokens')) {
      return json({
        token: 'inst-token',
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      });
    }
    if (url.pathname === '/installation') return json({ id: 42 });
    if (url.pathname === '/repositories/777') {
      return json({ full_name: 'acme/golden', permissions: { admin: true } });
    }
    if (url.pathname === '/repos/acme/golden') {
      return json({ full_name: 'acme/golden', permissions: { admin: true } });
    }

    // snapshot import
    if (/^\/repos\/acme\/golden\/commits\/[^/]+$/.test(url.pathname)) {
      return json({ sha: GH_SHA, commit: { message: 'head' }, parents: [] });
    }
    if (/^\/repos\/acme\/golden\/tarball\/[^/]+$/.test(url.pathname)) {
      return new Response(snapshotTarball() as unknown as BodyInit, {
        status: 200,
        headers: { 'content-type': 'application/x-gzip' },
      });
    }
    // anything else (export-sync side effects etc.) is a harmless 404
    return json({ message: 'Not Found' }, 404);
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function mockBatch<B>(queue: string, body: B): MessageBatch<B> {
  return {
    queue,
    messages: [
      {
        body,
        attempts: 1,
        id: 'm0',
        timestamp: new Date(),
        ack: (): void => {},
        retry: (): void => {},
      },
    ],
    ackAll: (): void => {},
    retryAll: (): void => {
      throw new Error(`${queue} consumer asked for a retry`);
    },
  } as unknown as MessageBatch<B>;
}

/** Scripted model: returns each queued response once, in order. */
function scriptModel(script: ChatResult[]): void {
  let index = 0;
  setChatProvider(async () => script[Math.min(index++, script.length - 1)] as ChatResult);
}

const call = (name: string, args: Record<string, unknown> = {}): ChatResult => ({
  tool_calls: [{ name, arguments: args }],
});

async function count(table: string, repoId?: string): Promise<number> {
  const row = (await q1(
    dbEnv,
    `SELECT COUNT(*) AS n FROM ${table}${repoId ? ` WHERE repo_id = ?` : ''}`,
    repoId ? [repoId] : [],
  )) as { n: number };
  return row.n;
}

async function mainHead(repoId: string): Promise<string | null> {
  const row = await q1(
    dbEnv,
    `SELECT ${C.refs.head} FROM ${T.refs} WHERE ${C.refs.repoId} = ? AND ${C.refs.name} = 'main'`,
    [repoId],
  );
  return (row as { head: string } | null)?.head ?? null;
}

/** R2 object keys under the repo prefix, grouped by kind (blobs/trees/…). */
async function r2Kinds(repoId: string): Promise<Record<string, number>> {
  const kinds: Record<string, number> = {};
  let cursor: string | undefined;
  do {
    const page = await testEnv.OBJECTS.list({ prefix: `repos/${repoId}/`, cursor });
    for (const obj of page.objects) {
      const kind = obj.key.split('/')[2] as string;
      kinds[kind] = (kinds[kind] ?? 0) + 1;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return kinds;
}

async function collect(body: ArrayBuffer): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(body));
      controller.close();
    },
  });
  for await (const entry of parseTar(await gunzipIfNeeded(stream, true))) {
    if (entry.type === 'file') files.set(entry.name, dec.decode(entry.body));
  }
  return files;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  setChatProvider(null);
});

describe('golden-path lifecycle', () => {
  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
    outbound.length = 0;
    mockGithub();
  });

  it('login → create → import → browse → agent lands → diff → export', async () => {
    const probe = instrumentQueues(testEnv);
    const fetchApp = makeApp(probe.env);
    let cookie = '';
    const api = async (path: string, init: RequestInit = {}): Promise<Response> =>
      fetchApp(
        new Request(`https://x${path}`, {
          ...init,
          headers: {
            'content-type': 'application/json',
            ...(cookie ? { cookie } : {}),
            ...(init.headers as Record<string, string> | undefined),
          },
        }),
      );

    // -- 1. anonymous is refused, then OAuth login mints a session ----------
    expect((await api('/api/v1/repos')).status).toBe(401);
    const start = await api('/auth/github');
    expect(start.status).toBe(302);
    const state = new URL(start.headers.get('location') as string).searchParams.get(
      'state',
    ) as string;
    const callback = await api(`/auth/github/callback?code=abc&state=${state}`);
    expect(callback.status).toBe(302);
    cookie = (callback.headers.get('set-cookie') as string).split(';')[0] as string;
    expect(cookie).toMatch(/^yag_session=[0-9a-f]{64}$/);
    expect(await count(T.users)).toBe(1);
    expect(await count(T.sessions)).toBe(1);
    expect(await count(T.oauthStates)).toBe(0); // single-use state consumed

    // -- 2. create the repo; creator is admin, nothing landed yet -----------
    const created = await api('/api/v1/repos', {
      method: 'POST',
      body: JSON.stringify({ slug: SLUG, visibility: 'private' }),
    });
    expect(created.status).toBe(201);
    const repoId = ((await created.json()) as { repo: { id: string } }).repo.id;
    const meta = (await (await api(`/api/v1/repos/${SLUG}`)).json()) as {
      can_admin: boolean;
    };
    expect(meta.can_admin).toBe(true);
    expect(await count(T.changesets, repoId)).toBe(0);
    expect(await mainHead(repoId)).toBeNull();

    // -- 3. connect GitHub (installation must hold admin on the repo) -------
    const connected = await api(`/api/v1/repos/${SLUG}/connect`, {
      method: 'POST',
      body: JSON.stringify({ installation_id: 42, github_repo_id: 777 }),
    });
    expect(connected.status).toBe(200);
    expect(
      await q1(dbEnv, `SELECT * FROM ${T.repos} WHERE ${C.repos.id} = ?`, [repoId]),
    ).toMatchObject({ github_installation_id: 42, github_repo_id: 777 });

    // -- 4. snapshot import: route enqueues, the real consumer runs it ------
    const started = await api(`/api/v1/repos/${SLUG}/import`, {
      method: 'POST',
      body: JSON.stringify({ source: `github:${SLUG}`, mode: 'snapshot', ref: 'main' }),
    });
    expect(started.status).toBe(202);
    const jobId = ((await started.json()) as { job_id: string }).job_id;
    const importSend = probe.sends.find((s) => s.queue === 'IMPORT_QUEUE');
    expect(importSend?.body).toMatchObject({ type: 'import_job', job_id: jobId });
    await importQueue(mockBatch('git-import', importSend?.body as ImportMessage), dbEnv);

    const job = (await (await api(`/api/v1/repos/${SLUG}/import/${jobId}`)).json()) as {
      status: string;
      commits_done: number;
    };
    expect(job).toMatchObject({ status: 'done', commits_done: 1 });
    const importedCs = (await mainHead(repoId)) as string;
    expect(importedCs).toMatch(/^[0-9a-f]{64}$/);
    expect(await count(T.changesets, repoId)).toBe(1);
    const afterImport = await r2Kinds(repoId);
    expect(afterImport.blobs).toBe(Object.keys(snapshotFiles).length);
    // root + src/ + src/util/
    expect(afterImport.trees).toBe(3);

    // -- 5. browse: tree + file RPCs at ref:main ----------------------------
    const root = (await (await api(`/api/v1/repos/${SLUG}/tree?cs=ref:main`)).json()) as {
      entries: { name: string; kind: string }[];
    };
    expect(root.entries.map((e) => `${e.kind}:${e.name}`).sort()).toEqual([
      'blob:README.md',
      'tree:src',
    ]);
    const deep = (await (
      await api(`/api/v1/repos/${SLUG}/tree?cs=${importedCs}&path=src&recursive=1`)
    ).json()) as { entries: { path?: string; name?: string }[] };
    expect(JSON.stringify(deep.entries)).toContain('math.ts');
    for (const [path, content] of Object.entries(snapshotFiles)) {
      const file = await api(`/api/v1/repos/${SLUG}/file?cs=${importedCs}&path=${path}`);
      expect(file.status).toBe(200);
      const body = (await file.json()) as { path: string; content_b64: string };
      expect(body.path).toBe(path);
      expect(atob(body.content_b64)).toBe(content); // byte-identical through import
    }

    // -- 6. agent task: route enqueues; consumer runs the scripted loop -----
    const healthz = 'export const healthz = () => "ok";\n';
    scriptModel([
      call('read_file', { path: 'src/app.ts' }),
      call('commit', {
        message: 'add healthz',
        changes: [{ path: 'src/healthz.ts', op: 'add', content_b64: btoa(healthz) }],
      }),
      call('land', {}),
      call('finish', { summary: 'added healthz' }),
    ]);
    const task = await api(`/api/v1/repos/${SLUG}/agents/tasks`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'freeform', prompt: 'add a healthz module' }),
    });
    expect(task.status).toBe(202);
    const taskId = ((await task.json()) as { task_id: string }).task_id;
    const agentSend = probe.sends.find((s) => s.queue === 'AGENT_QUEUE');
    expect(agentSend?.body).toEqual({ task_id: taskId });
    await agentJobsQueue(
      mockBatch('agent-jobs', agentSend?.body as AgentJobMessage),
      dbEnv,
    );

    const taskRow = await q1(dbEnv, `SELECT * FROM ${T.agentTasks} WHERE id = ?`, [
      taskId,
    ]);
    expect(taskRow).toMatchObject({ status: 'landed', base_cs: importedCs });
    const transcript = await api(`/api/v1/agents/tasks/${taskId}/transcript`);
    expect(transcript.status).toBe(200);
    const transcriptText = await transcript.text();
    for (const tool of ['read_file', 'commit', 'land', 'finish']) {
      expect(transcriptText).toContain(tool);
    }

    // -- 7. main moved forward, descending from the import ------------------
    const landedCs = (await mainHead(repoId)) as string;
    expect(landedCs).not.toBe(importedCs);
    expect(await isAncestorDag(dbEnv, repoId, importedCs, landedCs)).toBe(true);
    expect(await count(T.changesets, repoId)).toBe(2);
    expect(await count(T.refs, repoId)).toBe(1);
    // land queues a post-merge check
    const check = await q1(
      dbEnv,
      `SELECT * FROM ${T.agentTasks} WHERE ${C.agentTasks.kind} = 'post_merge_check'`,
    );
    expect(check).toMatchObject({ status: 'queued' });
    const afterLand = await r2Kinds(repoId);
    expect(afterLand.blobs).toBe((afterImport.blobs ?? 0) + 1);
    // root + src/ rewritten; src/util/ untouched and shared
    expect(afterLand.trees).toBe((afterImport.trees ?? 0) + 2);

    // -- 8. diff RPC shows exactly the landed change ------------------------
    const diff = await api(
      `/api/v1/repos/${SLUG}/diff?from=${importedCs}&to=ref:main&text=1`,
    );
    expect(diff.status).toBe(200);
    const diffBody = (await diff.json()) as {
      files: { path: string; kind: string }[];
      texts?: { path: string; unified: string }[];
    };
    expect(diffBody.files.map((f) => `${f.kind}:${f.path}`)).toEqual([
      'add:src/healthz.ts',
    ]);
    expect(diffBody.texts?.[0]?.unified).toContain('+export const healthz');

    // -- 9. export tarball parses back to the full landed tree --------------
    const tarball = await api(`/api/v1/repos/${SLUG}/export/tarball?cs=${landedCs}`);
    expect(tarball.status).toBe(200);
    expect(tarball.headers.get('cache-control') ?? '').not.toContain('public');
    const exported = await collect(await tarball.arrayBuffer());
    expect(Object.fromEntries(exported)).toEqual({
      ...snapshotFiles,
      'src/healthz.ts': healthz,
    });

    // every outbound call went to the stubbed GitHub — nothing leaked
    expect(outbound.every((u) => /github\.com/.test(u))).toBe(true);
    const tasks = await q(dbEnv, `SELECT * FROM ${T.agentTasks}`);
    expect(tasks.length).toBeGreaterThanOrEqual(2);
  });
});
