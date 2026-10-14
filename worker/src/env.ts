/**
 * Worker bindings, as declared in `wrangler.jsonc`.
 */
export interface Env {
  /** D1 — metadata (changesets, refs, derived data, auth, RBAC, agent tasks, import jobs). */
  DB: D1Database;
  /** R2 — content-addressed object store (blobs + trees). */
  OBJECTS: R2Bucket;
  /** Queue `derived-data` — deferred derived-data computation. */
  DERIVED_QUEUE: Queue;
  /** Queue `agent-jobs` — agent task dispatch. */
  AGENT_QUEUE: Queue;
  /** Queue `git-import` — git import / incremental sync jobs. */
  IMPORT_QUEUE: Queue;
  /** Durable Object namespace for ref compare-and-swap locks (one per repo+ref). */
  REF_LOCK: DurableObjectNamespace;
  /** Agent runtime namespace (issue #17) — one Durable Object per task. */
  AGENT: DurableObjectNamespace;
  /** Superfan monitors (issue #19) — one Durable Object per component. */
  SUPERFAN: DurableObjectNamespace;
  /** Workers AI binding (issue #19) — present in the `prod` env, absent in tests. */
  AI?: Ai;
  /** Model id override (default: @cf/meta/llama-3.3-70b-instruct-fp8-fast). */
  AGENT_MODEL?: string;
  /** GitHub OAuth app credentials (issue #12) — set via secrets/.dev.vars. */
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** GitHub App credentials (issue #13). */
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  GITHUB_APP_SLUG?: string;
  /** Test-only: public half of the app signing key. */
  TEST_GITHUB_APP_PUBLIC_KEY?: string;
}
