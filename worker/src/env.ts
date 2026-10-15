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
  /** Native CI is disabled until an operator deploys the container and enables it. */
  CI_RUNNER?: DurableObjectNamespace;
  CI_QUEUE?: Queue;
  CI_ENABLED?: string;
  CI_MONTHLY_BUDGET_USD?: string;
  CI_REGISTRY_HOST?: string;
  CI_REGISTRY_IMAGES?: string;
  CI_REGISTRY_USERNAME?: string;
  CI_REGISTRY_PASSWORD?: string;
  /** SPA assets (issue #20) — dashboard/dist served for non-API paths. */
  ASSETS?: Fetcher;
  /** Durable Object namespace for ref compare-and-swap locks (one per repo+ref). */
  REF_LOCK: DurableObjectNamespace;
  /** Agent runtime namespace (issue #17) — one Durable Object per task. */
  AGENT: DurableObjectNamespace;
  /** Superfan monitors (issue #19) — one Durable Object per component. */
  SUPERFAN: DurableObjectNamespace;
  /** Rate-limit shards (issue #21) — 16 DOs per bucket. */
  RATE_LIMIT: DurableObjectNamespace;
  /** HMAC key for signed cache tokens (issue #21) — secret, never in VCS. */
  CACHE_SIGNING_KEY?: string;
  /** JSON override of the rate-limit buckets (tests relax shared-IP pressure). */
  RATE_LIMIT_BUCKETS?: string;
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
