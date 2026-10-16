import type { Context, Next } from 'hono';
import type { Env } from '../env';
import type { AppEnv, Principal } from '../auth/principal';
import { apiError } from '../api/errors';
import { timePhase } from '../observability/phase';

/**
 * Rate limiting (issue #21) — sliding-window counters per
 * (principal-or-ip, bucket), sharded 16 ways per bucket so no single Durable
 * Object becomes the bottleneck. The DO is the counter; state lives in DO
 * storage with a 60s alarm-based sweep.
 *
 * Buckets (per minute): api_read 600, api_write 120, agent_run 20,
 * object_fetch 2000, auth 10, git 300 (smart HTTP, issue #31). Webhooks are
 * **exempt** — HMAC is the gate.
 */

export const BUCKETS = {
  api_read: 600,
  api_write: 120,
  agent_run: 20,
  object_fetch: 2000,
  auth: 10,
  git: 300,
} as const;

export type Bucket = keyof typeof BUCKETS;
const SHARDS = 16;
const WINDOW_MS = 60_000;

export interface AllowResult {
  allowed: boolean;
  retry_after_s: number;
  remaining: number;
}

/**
 * Sliding-window counter DO. One instance per (bucket, shard); keys are
 * principals or IPs within the shard.
 */
export class RateLimitDO {
  private readonly state: DurableObjectState;
  private readonly env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/allow') {
      return new Response('not found', { status: 404 });
    }
    const body = (await request.json()) as {
      key: string;
      bucket: Bucket;
      limit: number;
      /** Test clock. Production callers omit it and the DO uses Date.now(). */
      now?: number;
    };
    void this.env;
    return this.state.blockConcurrencyWhile(async () => {
      const now = typeof body.now === 'number' ? body.now : Date.now();
      const store =
        ((await this.state.storage.get('hits')) as
          Record<string, number[]> | undefined) ?? {};
      const hits = (store[body.key] ?? []).filter((t) => now - t < WINDOW_MS);
      if (hits.length >= body.limit) {
        const oldest = hits[0] as number;
        const retryAfter = Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000));
        return Response.json({
          allowed: false,
          retry_after_s: retryAfter,
          remaining: 0,
        } satisfies AllowResult);
      }
      hits.push(now);
      store[body.key] = hits;
      await this.state.storage.put('hits', store);
      await this.state.storage.setAlarm(now + WINDOW_MS + 1000);
      return Response.json({
        allowed: true,
        retry_after_s: 0,
        remaining: Math.max(0, body.limit - hits.length),
      } satisfies AllowResult);
    });
  }

  /** Alarm sweep: drop expired windows. */
  async alarm(): Promise<void> {
    const now = Date.now();
    const store =
      ((await this.state.storage.get('hits')) as Record<string, number[]> | undefined) ??
      {};
    for (const [key, hits] of Object.entries(store)) {
      const fresh = hits.filter((t) => now - t < WINDOW_MS);
      if (fresh.length === 0) delete store[key];
      else store[key] = fresh;
    }
    await this.state.storage.put('hits', store);
    await this.state.storage.setAlarm(now + WINDOW_MS + 1000);
  }
}

export function shardOf(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % SHARDS;
}

export function bucketFor(method: string, path: string): Bucket | null {
  if (path.startsWith('/webhooks/')) return null; // HMAC is the gate
  // before /auth/: an owner may be called `auth`
  if (/^\/[^/]+\/[^/]+\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.test(path)) {
    return 'git';
  }
  // package registry (#53): a push or pull is many content-addressed blob requests
  if (path.startsWith('/v2/') || path.startsWith('/npm/')) return 'object_fetch';
  if (path.startsWith('/auth/')) return 'auth';
  if (path === '/mcp' || path.includes('/agents/mcp') || path.includes('/agents/tasks'))
    return 'agent_run';
  if (path.includes('/fetch-objects') || path.includes('/object/')) return 'object_fetch';
  return method === 'GET' || method === 'HEAD' ? 'api_read' : 'api_write';
}

function limits(env: Env): Record<Bucket, number> {
  if (!env.RATE_LIMIT_BUCKETS) return BUCKETS;
  try {
    return {
      ...BUCKETS,
      ...(JSON.parse(env.RATE_LIMIT_BUCKETS) as Record<string, number>),
    };
  } catch {
    return BUCKETS;
  }
}

export async function check(env: Env, bucket: Bucket, key: string): Promise<AllowResult> {
  const id = env.RATE_LIMIT.idFromName(`${bucket}:${shardOf(key)}`);
  const stub = env.RATE_LIMIT.get(id);
  const res = await timePhase('do', () =>
    stub.fetch('https://rate-limit/allow', {
      method: 'POST',
      body: JSON.stringify({
        key: `${bucket}:${key}`,
        bucket,
        limit: limits(env)[bucket],
      }),
    }),
  );
  return (await res.json()) as AllowResult;
}

/** Global middleware: 429 + Retry-After when the window is spent. */
export async function rateLimitMiddleware(
  c: Context<AppEnv>,
  next: Next,
): Promise<Response | void> {
  const bucket = bucketFor(c.req.method, new URL(c.req.url).pathname);
  if (bucket === null) {
    await next();
    return;
  }
  const principal = (c.get('principal') ?? null) as Principal | null;
  const key = principal
    ? `${principal.kind}:${principal.userId}`
    : (c.req.header('cf-connecting-ip') ?? 'unknown-ip');

  const result = await check(c.env, bucket, key);
  if (!result.allowed) {
    const response = apiError(c, 429, 'rate_limited', 'too many requests', {
      retry_after_s: result.retry_after_s,
      bucket,
    });
    response.headers.set('retry-after', String(result.retry_after_s));
    return response;
  }
  await next();
}
