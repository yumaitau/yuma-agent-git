/**
 * Worker bindings, as declared in `wrangler.jsonc`.
 */
export interface Env {
  /** D1 — metadata (changesets, refs, derived data, auth, RBAC, agent tasks, import jobs). */
  DB: D1Database;
  /** Metadata shards (issue #78, ADR 0006), named by `shard_directory`; see db/router.ts. */
  [shard: `DB_SHARD_${number}`]: D1Database | undefined;
  /** R2 — content-addressed object store (blobs + trees). */
  OBJECTS: R2Bucket;
  /**
   * Backups (issue #70): a separate bucket, ideally in another account. Unset
   * disables scheduled backups (docs/operations/backup-dr.md).
   */
  BACKUPS?: R2Bucket;
  /** AES-256-GCM key for backup parts, base64 of 32 bytes; secret, kept out of D1 and R2. */
  BACKUP_ENCRYPTION_KEY?: string;
  /** Minutes between scheduled backups (default 15) and days kept (default 30). */
  BACKUP_INTERVAL_MINUTES?: string;
  BACKUP_RETENTION_DAYS?: string;
  /** Comma-separated user ids allowed to list and start backups. */
  BACKUP_ADMIN_USER_IDS?: string;
  /** Set only in a fresh environment: the backup id the cron restores. */
  RESTORE_BACKUP_ID?: string;
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
  /**
   * CI workload identity (issue #50): JWK set `{"keys":[…]}` of RSA keys,
   * secret. The first key signs; every key is published in the JWKS.
   */
  CI_OIDC_SIGNING_KEYS?: string;
  /** Issuer URL override for a custom domain (default `{origin}/ci/oidc`). */
  CI_OIDC_ISSUER?: string;
  /**
   * Commit signatures (issue #58): PEM roots (Sigstore Fulcio root and
   * intermediate) that x509 (gitsign) signatures must chain to. Unset: x509
   * signatures stay unverified.
   */
  SIGSTORE_TRUST_ROOTS?: string;
  /**
   * Signed provenance (issue #58), secret: Ed25519 JWK key ring
   * `{"keys":[...]}`, the first (with `d`) signs and all are published.
   */
  PROVENANCE_SIGNING_KEYS?: string;
  /**
   * Git over SSH (issue #34, ADR 0007): the internal hostname the SSH gateway
   * calls `/internal/ssh/authorize` on. Unset, that endpoint answers 404.
   */
  SSH_GATEWAY_HOST?: string;
  /** Secret: the key the SSH gateway sends in `x-ssh-gateway-key`. */
  SSH_GATEWAY_KEY?: string;
  /** Key-encryption key for CI secrets, secret: base64 key or key ring JSON. */
  SECRETS_KEK?: string;
  /** Comma-separated user ids allowed to run the KEK re-wrap. */
  SECRETS_ADMIN_USER_IDS?: string;
  /** Audit log (issue #65): queue `audit-stream` ships events to the SIEM sink. */
  AUDIT_QUEUE?: Queue;
  /** HTTPS ingest endpoint for audit streaming; unset disables streaming. */
  AUDIT_STREAM_URL?: string;
  /** HMAC key for audit stream batches — secret, never logged. */
  AUDIT_STREAM_SECRET?: string;
  /** Comma-separated user ids allowed to search and export the audit log. */
  AUDIT_ADMIN_USER_IDS?: string;
  /** Comma-separated user ids allowed to pause every agent on the instance (#62). */
  AGENTS_ADMIN_USER_IDS?: string;
  /** Comma-separated user ids allowed to set per-org CI capacity (#52). */
  CI_ADMIN_USER_IDS?: string;
  /** Dependency alerts (issue #67): user ids that may load OSV advisory snapshots. */
  SECURITY_ADMIN_USER_IDS?: string;
  /** "off" stops the hourly OSV advisory sync (issue #67). */
  OSV_SYNC?: string;
  /** Queue `forge-events` (issue #75): domain events and webhook delivery retries. */
  EVENTS_QUEUE?: Queue;
  /** Queue `mirror-sync` (issues #36, #73): pull and push mirror syncs. */
  MIRROR_QUEUE?: Queue;
  /** Queue `notifications` (issue #44): domain events fanned out to inboxes and email. */
  NOTIFY_QUEUE?: Queue;
  /** HMAC key for unsubscribe links, secret. Unset: no notification email is sent. */
  NOTIFY_SIGNING_KEY?: string;
  /** Notification email over HTTPS (PaperBoy): endpoint, bearer key (secret), sender. */
  PAPERBOY_API_URL?: string;
  PAPERBOY_API_KEY?: string;
  PAPERBOY_FROM?: string;
  /** Or Cloudflare Email Routing: a `send_email` binding and its sender address. */
  EMAIL?: SendEmail;
  NOTIFY_EMAIL_FROM?: string;
  /** "true" lets webhooks use http:// URLs (local testing). Private addresses stay refused. */
  WEBHOOKS_ALLOW_HTTP?: string;
  /** Package registry (issue #53): storage quota per owner in bytes (default 10 GiB). */
  REGISTRY_QUOTA_BYTES?: string;
  /** Git LFS (issue #35): stored bytes allowed per repo (default 10 GiB) and per org (100 GiB). */
  LFS_REPO_QUOTA_BYTES?: string;
  LFS_ORG_QUOTA_BYTES?: string;
  /** SPA assets (issue #20) — dashboard/dist served for non-API paths. */
  ASSETS?: Fetcher;
  /** Durable Object namespace for ref compare-and-swap locks (one per repo+ref). */
  REF_LOCK: DurableObjectNamespace;
  /** Merge queues (issue #43) — one Durable Object per repo and base ref. */
  MERGE_QUEUE: DurableObjectNamespace;
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
  /**
   * OIDC sign-in providers (issue #27), a JSON array (see auth/oidc.ts). Each
   * client secret is the Worker secret `OIDC_<ID>_CLIENT_SECRET`.
   */
  OIDC_PROVIDERS?: string;
  /** Secret that encrypts TOTP seeds at rest (issue #27). */
  TOTP_ENCRYPTION_KEY?: string;
  /** Comma-separated user ids allowed to mint SCIM provisioning tokens. */
  SCIM_ADMIN_USER_IDS?: string;
  /** "true": creating an API token needs a second factor in the last 12 hours. */
  REQUIRE_MFA_FOR_TOKENS?: string;
  /** GitHub App credentials (issue #13). */
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  GITHUB_APP_SLUG?: string;
  /** Test-only: public half of the app signing key. */
  TEST_GITHUB_APP_PUBLIC_KEY?: string;
}
