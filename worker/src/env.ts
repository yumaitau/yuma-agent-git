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
  /** GitHub OAuth app credentials (issue #12) — set via secrets/.dev.vars. */
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
}
