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

/** Hex SHA-256 of raw bytes (WebCrypto). */
export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
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
