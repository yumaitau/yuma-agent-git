import { applyD1Migrations } from 'cloudflare:test';
import type { Env } from '../src/env';
import { app } from '../src/app';

/** `worker/migrations/*.sql` loaded at vitest config time (see vitest.config.ts). */
interface D1Migration {
  name: string;
  queries: string[];
}

export type TestEnv = Env & { TEST_MIGRATIONS: D1Migration[] };

/**
 * Apply every `worker/migrations/*.sql` (in migration order) to the test D1
 * database — the same files `wrangler d1 migrations apply` runs in deploys.
 */
export async function seedSchema(env: TestEnv): Promise<void> {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
}

/** Table names in safe wipe order (children before parents). */
const WIPE_ORDER = [
  'pull_reviews',
  'pull_requests',
  'ci_runs',
  'ci_settings',
  'superfan_findings',
  'component_metrics',
  'export_jobs',
  'webhook_deliveries',
  'installations',
  'api_tokens',
  'oauth_states',
  'path_rules',
  'repo_members',
  'import_jobs',
  'agent_tasks',
  'derived_data',
  'tags',
  'git_commits',
  'git_trees',
  'git_blobs',
  'refs',
  'changesets',
  'sessions',
  'users',
  'repos',
];

/** Empty every table (schema stays). */
export async function cleanDb(env: TestEnv): Promise<void> {
  for (const table of WIPE_ORDER) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
}

/** Hex SHA-256 of raw bytes (WebCrypto). */
export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface ObjectProbe {
  env: Env;
  puts: string[];
  gets: string[];
  heads: string[];
}

/**
 * Env with R2 access instrumented — lets tests assert *how much* object I/O an
 * operation performs (content-addressed dedupe makes key counts blind to
 * redundant work, so claims like "only touched trees are written" need call
 * accounting).
 */
export function instrumentObjects(base: TestEnv): ObjectProbe {
  const puts: string[] = [];
  const gets: string[] = [];
  const heads: string[] = [];
  const target = base.OBJECTS;
  const proxied = new Proxy(target, {
    get(t, prop, _recv) {
      if (prop === 'put') {
        return (key: string, ...rest: unknown[]): unknown => {
          puts.push(key);
          return (t.put as (...a: unknown[]) => unknown).call(t, key, ...rest);
        };
      }
      if (prop === 'get') {
        return (key: string, ...rest: unknown[]): unknown => {
          gets.push(key);
          return (t.get as (...a: unknown[]) => unknown).call(t, key, ...rest);
        };
      }
      if (prop === 'head') {
        return (key: string, ...rest: unknown[]): unknown => {
          heads.push(key);
          return (t.head as (...a: unknown[]) => unknown).call(t, key, ...rest);
        };
      }
      const v = Reflect.get(t, prop, t) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
  // Shadow OBJECTS on a wrapper — never assign into the miniflare env itself
  // (its bindings forward assignments and the probe would leak onto the base
  // env, silently counting unrelated calls).
  const env = new Proxy(base, {
    get(t, prop, _recv) {
      return prop === 'OBJECTS' ? proxied : Reflect.get(t, prop, t);
    },
  }) as TestEnv;
  return { env, puts, gets, heads };
}

export interface DbProbe {
  env: Env;
  prepares: string[];
}

/**
 * Env with D1 instrumented — counts prepared statements so tests can assert
 * read complexity (the O(log n) ancestry claims).
 */
export function instrumentDb(base: TestEnv): DbProbe {
  const prepares: string[] = [];
  const target = base.DB;
  const proxied = new Proxy(target, {
    get(t, prop, _recv) {
      if (prop === 'prepare') {
        return (sql: string): unknown => {
          prepares.push(sql);
          return (t.prepare as (s: string) => unknown).call(t, sql);
        };
      }
      const v = Reflect.get(t, prop, t) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
  const env = new Proxy(base, {
    get(t, prop, _recv) {
      return prop === 'DB' ? proxied : Reflect.get(t, prop, t);
    },
  }) as TestEnv;
  return { env, prepares };
}

export interface QueueProbe {
  env: TestEnv;
  sends: { queue: string; body: unknown }[];
}

/** Env with queue sends recorded — lets tests assert what got enqueued. */
export function instrumentQueues(base: TestEnv): QueueProbe {
  const sends: { queue: string; body: unknown }[] = [];
  const wrap = (name: 'IMPORT_QUEUE' | 'DERIVED_QUEUE' | 'AGENT_QUEUE'): unknown => {
    const target = base[name] as unknown as { send: (b: unknown) => Promise<void> };
    return new Proxy(target, {
      get(t, prop, _recv) {
        if (prop === 'send') {
          return (body: unknown): Promise<void> => {
            sends.push({ queue: name, body });
            return t.send.call(t, body);
          };
        }
        const v = Reflect.get(t, prop, t) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
  };
  const env = new Proxy(base, {
    get(t, prop, _recv) {
      if (prop === 'IMPORT_QUEUE' || prop === 'DERIVED_QUEUE' || prop === 'AGENT_QUEUE') {
        return wrap(prop);
      }
      return Reflect.get(t, prop, t);
    },
  }) as TestEnv;
  return { env, sends };
}

/** Signed-in user + session cookie — fixtures for guarded routes. */
export async function loginAs(
  env: TestEnv,
  githubId: number,
  login: string,
): Promise<{ userId: string; cookie: string; headers: Record<string, string> }> {
  const { upsertUser, createSession } = await import('../src/auth/session');
  const user = await upsertUser(env as unknown as Env, { id: githubId, login });
  const session = await createSession(env as unknown as Env, user.id);
  const cookie = `yag_session=${session.token}`;
  return { userId: user.id, cookie, headers: { cookie } };
}

interface FetchLike {
  (request: Request): Response | Promise<Response>;
}

/** A fake ExecutionContext for route tests. */
function fakeCtx(): ExecutionContext {
  return {
    waitUntil: () => {},
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
}

/**
 * Hono `app.fetch` bound to the given bindings and a fake execution context,
 * shaped as a plain `(request) => response` function for route tests.
 */
export function makeApp(env: Env): FetchLike {
  const ctx = fakeCtx();
  return (request: Request) => app.fetch(request, env, ctx);
}

/**
 * `makeApp` as a signed-in viewer with no repo membership — the caller for
 * public-repo reads now that the API refuses anonymous requests. Requests
 * that already carry a cookie or bearer token keep their own credentials.
 */
export function makeViewerApp(env: TestEnv): FetchLike {
  const fetch = makeApp(env);
  let viewer: Promise<string> | null = null;
  return async (request: Request) => {
    if (request.headers.has('cookie') || request.headers.has('authorization')) {
      return fetch(request);
    }
    viewer ??= loginAs(env, 990_001, 'viewer').then((v) => v.cookie);
    const signed = new Request(request);
    signed.headers.set('cookie', await viewer);
    return fetch(signed);
  };
}
