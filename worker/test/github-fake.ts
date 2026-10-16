import type { Env } from '../src/env';
import { runBulkStep, type BulkImportMessage } from '../src/bridge/bulk-import';
import { q1 } from '../src/db/client';
import { concatBytes, FLUSH, pktLine } from '../src/git/pktline';

/**
 * A fake github.com for the bulk importer (issue #72), installed as the global
 * `fetch`: REST lists with Link pagination and rate-limit headers, the App
 * token endpoint, LFS batch and asset downloads, and Git smart HTTP that is
 * our own upload-pack serving a source repo (a real protocol v2 server, so
 * the importer's client and SHA round trip are exercised end to end).
 */

type AppFetch = (request: Request) => Response | Promise<Response>;

export interface Fault {
  /** Matched against `METHOD /path` (REST) or the full URL (git, LFS). */
  match: RegExp;
  /** Answer with this status and headers instead of the real reply. */
  status?: number;
  headers?: Record<string, string>;
  /** Throw (a dropped connection) instead of answering. */
  throws?: boolean;
  /** How many matching calls to fail (default 1). */
  times?: number;
}

export interface FakeGithub {
  owner: string;
  calls: string[];
  /** Permissions asked for when installation tokens were minted. */
  tokenPermissions: unknown[];
  /** REST path (no query) → every item of a list endpoint. */
  lists: Record<string, unknown[]>;
  /** REST path → a single JSON object. */
  objects: Record<string, unknown>;
  /** GitHub repo name → the forge repo that serves its Git history. */
  git: Record<string, { slug: string; authorization: string }>;
  /** Reject `filter` in fetch, like a server without partial clone. */
  noFilter: boolean;
  lfs: Record<string, Uint8Array>;
  assets: Record<number, Uint8Array>;
  faults: Fault[];
  /** `x-ratelimit-remaining` on REST replies. */
  remaining: number;
  reset: number;
}

export function fakeGithub(owner: string): FakeGithub {
  return {
    owner,
    calls: [],
    tokenPermissions: [],
    lists: {},
    objects: {},
    git: {},
    noFilter: false,
    lfs: {},
    assets: {},
    faults: [],
    remaining: 5000,
    reset: Math.floor(Date.now() / 1000) + 3600,
  };
}

const json = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

function fault(gh: FakeGithub, key: string): Response | null {
  const found = gh.faults.find((f) => f.match.test(key));
  if (!found) return null;
  found.times = (found.times ?? 1) - 1;
  if (found.times <= 0) gh.faults.splice(gh.faults.indexOf(found), 1);
  if (found.throws) throw new TypeError('simulated network failure');
  return json({ message: 'fault' }, found.status ?? 500, found.headers ?? {});
}

/** Install the fake as global `fetch`; returns the restore function. */
export function installFakeGithub(gh: FakeGithub, app: AppFetch): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as RequestInfo, init);
    const url = new URL(req.url);
    if (url.hostname === 'github.com') {
      gh.calls.push(`${req.method} ${url.pathname}`);
      const failed = fault(gh, req.url);
      if (failed) return failed;
      const git =
        /^\/([^/]+)\/([^/]+)\.git\/(git-upload-pack|info\/lfs\/objects\/batch)$/.exec(
          url.pathname,
        );
      const source = git ? gh.git[git[2] as string] : undefined;
      if (!git || !source) return json({ message: 'Not Found' }, 404);
      if (git[3] === 'info/lfs/objects/batch') {
        const body = (await req.json()) as { objects: { oid: string; size: number }[] };
        return json({
          objects: body.objects.map((o) =>
            gh.lfs[o.oid]
              ? {
                  ...o,
                  actions: {
                    download: {
                      href: `https://lfs.example/${o.oid}`,
                      header: { authorization: 'lfs-token' },
                    },
                  },
                }
              : { ...o, error: { code: 404, message: 'Object does not exist' } },
          ),
        });
      }
      const body = new Uint8Array(await req.arrayBuffer());
      if (gh.noFilter && new TextDecoder().decode(body).includes('filter ')) {
        return new Response(concatBytes([pktLine('ERR filter not supported\n'), FLUSH]));
      }
      return app(
        new Request(`https://x/${source.slug}.git/git-upload-pack`, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-git-upload-pack-request',
            'git-protocol': 'version=2',
            authorization: source.authorization,
          },
          body,
        }),
      );
    }
    if (url.hostname === 'lfs.example') {
      const bytes = gh.lfs[url.pathname.slice(1)];
      return bytes ? new Response(bytes) : new Response('missing', { status: 404 });
    }
    if (url.hostname === 'assets.example') {
      const bytes = gh.assets[Number(url.pathname.slice(1))];
      return bytes ? new Response(bytes) : new Response('missing', { status: 404 });
    }
    if (url.hostname !== 'api.github.com') return real(input, init);

    const key = `${req.method} ${url.pathname}`;
    gh.calls.push(`${key}${url.search}`);
    if (url.pathname.endsWith('/access_tokens')) {
      const text = await req.text();
      gh.tokenPermissions.push(
        text ? (JSON.parse(text) as { permissions?: unknown }).permissions : null,
      );
      return json({
        token: 'inst-token',
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      });
    }
    const failed = fault(gh, `${key}${url.search}`);
    if (failed) return failed;
    const quota = {
      'x-ratelimit-remaining': String(gh.remaining),
      'x-ratelimit-reset': String(gh.reset),
    };
    const asset = /\/releases\/assets\/(\d+)$/.exec(url.pathname);
    if (asset) {
      return new Response(null, {
        status: 302,
        headers: { location: `https://assets.example/${asset[1]}` },
      });
    }
    const list = gh.lists[url.pathname];
    if (list) {
      const perPage = Number(url.searchParams.get('per_page') ?? '30');
      const page = Number(url.searchParams.get('page') ?? '1');
      const headers: Record<string, string> = { ...quota };
      if (page * perPage < list.length) {
        const next = new URLSearchParams(url.searchParams);
        next.set('page', String(page + 1));
        headers.link = `<https://api.github.com${url.pathname}?${next.toString()}>; rel="next"`;
      }
      return json(list.slice((page - 1) * perPage, page * perPage), 200, headers);
    }
    const object = gh.objects[url.pathname];
    if (object !== undefined) return json(object, 200, quota);
    return json({ message: 'Not Found' }, 404, quota);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

/** Env whose import queue records sends instead of delivering them. */
export function capturedQueue(base: Env): {
  env: Env;
  sent: { body: BulkImportMessage; delaySeconds?: number }[];
} {
  const sent: { body: BulkImportMessage; delaySeconds?: number }[] = [];
  const queue = {
    send: async (body: BulkImportMessage, opts?: { delaySeconds?: number }) => {
      sent.push({ body, delaySeconds: opts?.delaySeconds });
    },
  };
  const env = new Proxy(base, {
    get: (t, prop) => (prop === 'IMPORT_QUEUE' ? queue : Reflect.get(t, prop, t)),
  });
  return { env, sent };
}

/** Run one-step messages until the job finishes; returns its final status. */
export async function driveImport(
  env: Env,
  jobId: string,
  opts: { chunk?: number; maxSteps?: number } = {},
): Promise<string> {
  for (let i = 0; i < (opts.maxSteps ?? 500); i++) {
    const job = await q1<{ seq: number; status: string }>(
      env,
      'SELECT seq, status FROM bulk_imports WHERE id = ?',
      [jobId],
    );
    if (!job || ['done', 'partial', 'failed'].includes(job.status))
      return job?.status ?? '';
    await runBulkStep(
      env,
      { type: 'bulk_import', job_id: jobId, seq: job.seq },
      {
        budgetMs: 0,
        chunk: opts.chunk,
      },
    );
  }
  throw new Error('import did not finish');
}
