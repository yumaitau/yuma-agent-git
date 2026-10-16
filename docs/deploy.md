# Deploying yuma-agent-git

One-command deploy once the Cloudflare resources and GitHub OAuth login exist.
Native repositories and Yuma CI do not need a connected GitHub repository or App
installation. GitHub is the identity provider; repository storage and builds run
on Yuma's Cloudflare resources.

The [Yuma pilot](https://yuma-agent-git-prod.yuma-it.workers.dev) is deployed with
CI enabled and GitHub sign-in configured. Its
[live smoke report](deployment-smoke-2026-10-15.md) records verified behavior and
remaining setup, including permanent registry credentials. Commands below describe provisioning a new environment; do not
recreate the existing Yuma resources. For Yuma, run Cloudflare commands through
`cf-vault` to select the account and inject credentials.

## 1. Cloudflare resources

```sh
# D1 metadata database
npx wrangler d1 create yag-db -c worker/wrangler.jsonc          # paste the id into worker/wrangler.jsonc
npx wrangler d1 migrations apply yag-db --remote --env prod -c worker/wrangler.jsonc

# R2 content-addressed object store
npx wrangler r2 bucket create yag-objects -c worker/wrangler.jsonc

# Queues (idempotent)
./scripts/setup-queues.sh
```

`database_id` in `worker/wrangler.jsonc` currently identifies the Yuma pilot database.
For another environment, replace it in both the base and `env.prod` database bindings.
Do **not** commit secrets: CI greps `wrangler.jsonc` for
`gh[ps]_` / `-----BEGIN` material and fails.

## 2. Secrets (never in VCS)

```sh
npx wrangler secret put GITHUB_CLIENT_ID --env prod -c worker/wrangler.jsonc
npx wrangler secret put GITHUB_CLIENT_SECRET --env prod -c worker/wrangler.jsonc
npx wrangler secret put CACHE_SIGNING_KEY --env prod -c worker/wrangler.jsonc        # cache-token HMAC key
```

Only optional GitHub import/export needs the bridge secrets:

```sh
npx wrangler secret put GITHUB_APP_ID --env prod -c worker/wrangler.jsonc
npx wrangler secret put GITHUB_APP_PRIVATE_KEY --env prod -c worker/wrangler.jsonc   # PKCS#8 PEM
npx wrangler secret put GITHUB_WEBHOOK_SECRET --env prod -c worker/wrangler.jsonc
```

Audit log search and SIEM streaming (issue #65) are optional. `AUDIT_ADMIN_USER_IDS`
is a comma-separated list of user ids allowed to read `GET /api/v1/orgs/:org/audit`
until org roles land. Streaming turns on when both stream settings exist; the URL
must be HTTPS and each batch is signed with
`x-yag-signature: sha256=HMAC(secret, "<x-yag-timestamp>.<body>")`:

```sh
npx wrangler secret put AUDIT_ADMIN_USER_IDS --env prod -c worker/wrangler.jsonc
npx wrangler secret put AUDIT_STREAM_URL --env prod -c worker/wrangler.jsonc
npx wrangler secret put AUDIT_STREAM_SECRET --env prod -c worker/wrangler.jsonc
```

`GET /api/v1/audit/stream` reports delivery status, and `yag audit verify --org <org>`
(or `--file export.ndjson`) checks the hash chain.

CI secrets and OIDC workload identity (issue #50) are optional. Generate both
values with `scripts/ci-keys.mjs`, which writes a 0600 file and never prints key
material; see [ci-oidc-aws.md](ci-oidc-aws.md) for setup and rotation:

```sh
node scripts/ci-keys.mjs oidc-new --out ci-oidc-keys.json
npx wrangler secret put CI_OIDC_SIGNING_KEYS --env prod -c worker/wrangler.jsonc < ci-oidc-keys.json
node scripts/ci-keys.mjs provenance-new --out provenance-keys.json
npx wrangler secret put PROVENANCE_SIGNING_KEYS --env prod -c worker/wrangler.jsonc < provenance-keys.json
node scripts/ci-keys.mjs kek --out secrets-kek.txt
npx wrangler secret put SECRETS_KEK --env prod -c worker/wrangler.jsonc < secrets-kek.txt
npx wrangler secret put SECRETS_ADMIN_USER_IDS --env prod -c worker/wrangler.jsonc   # may run the KEK re-wrap
```

Local development uses `worker/.dev.vars` (copy `.dev.vars.example`).

## 3. GitHub login and optional migration bridge

For sign-in alone, register a GitHub OAuth app with the deployed homepage URL and
callback `https://<your-worker>.workers.dev/auth/github/callback`, then configure
`GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`. Login requests only `read:user
user:email`; it does not request repository access. No GitHub repository needs to
exist. Every API route and dashboard page requires this sign-in (or an API token).

If GitHub import/export is also needed, create an App at
https://github.com/settings/apps with:

- Callback URL: `https://<your-worker>.workers.dev/auth/github/callback`
- Setup URL / install callback: `https://<your-worker>.workers.dev/auth/github/install-callback`
- Webhook URL: `https://<your-worker>.workers.dev/webhooks/github`
- Webhook secret: the same value as `GITHUB_WEBHOOK_SECRET`
- Permissions: Contents **read**, Metadata **read**; for org bulk imports also
  Organization Members **read** (the forge checks that whoever starts an
  import is an admin of the GitHub org)
- Subscribe to: `installation`, `installation_repositories`, `push`
- Where can it be installed: any account (org installation supported)

## 3a. Yuma sign-in: OIDC, passkeys, TOTP and SCIM

GitHub is optional. To sign people in with Google Workspace, Microsoft Entra ID or
another OIDC provider, set the `OIDC_PROVIDERS` var (a JSON string, no secrets)
in `env.prod.vars`, for example:

```json
[
  {
    "id": "google",
    "preset": "google",
    "client_id": "…",
    "allowed_domains": ["example.com"]
  },
  { "id": "entra", "preset": "entra", "tenant": "<tenant id>", "client_id": "…" }
]
```

Register the redirect URI `https://<your-worker>/auth/oidc/<id>/callback` with the
provider, then store each client secret as a Worker secret named after the id:

```sh
npx wrangler secret put OIDC_GOOGLE_CLIENT_SECRET --env prod -c worker/wrangler.jsonc
npx wrangler secret put TOTP_ENCRYPTION_KEY --env prod -c worker/wrangler.jsonc   # long random string; encrypts TOTP seeds
```

- `allowed_domains` limits sign-in to verified emails in those domains (and, for
  Google, the Workspace `hd` claim). Leave it out to accept any account.
- Entra needs the tenant id (a GUID), not a domain name.
- Passkeys need no configuration. The relying party is the hostname people use.
- SCIM: set `SCIM_ADMIN_USER_IDS` (comma-separated Yuma user ids). Those users,
  after verifying a passkey or authenticator code, mint a provisioning token with
  `POST /api/v1/scim/tokens` and give the IdP `https://<your-worker>/scim/v2` with
  that bearer token. Deactivating a user revokes all their sessions and API tokens.
  To sync IdP groups to teams, mint the token with `"org": "<org slug>"`; groups
  pushed to `/scim/v2/Groups` become teams in that org, and their members join it.
- Org SSO: an org owner sets `PUT /api/v1/orgs/<org>/sso` with the `issuer` and
  `client_id` of one of the `OIDC_PROVIDERS`, optional `allowed_domains`, and
  `enforced`. Once enforced, members reach org repos (API and Git) only from a
  session that signed in through that provider, or a token minted from one;
  anything else gets `sso_required`. Owners must sign in that way before they can
  enforce it. SAML is not supported (see `docs/adr/0002-saml-sso.md`).
- Set `REQUIRE_MFA_FOR_TOKENS` to `true` to make API token creation need a passkey
  or authenticator code from the last 12 hours, even for people with none
  enrolled. It is off by default so GitHub-only users are not locked out.

Rotating `TOTP_ENCRYPTION_KEY` makes enrolled authenticator apps unreadable, so
people would need to enrol again.

## 4. Deploy

```sh
npm run deploy
```

This runs, in order:

1. `vite build` — dashboard SPA into `worker/dashboard/dist` (the assets binding)
2. `./scripts/setup-queues.sh` — provision `derived-data`, `agent-jobs`, `git-import`, `ci-runs`, `audit-stream`, `forge-events`
3. `wrangler d1 migrations apply yag-db --remote --env prod`
4. `wrangler deploy --env prod` — deploy the Worker with its production D1, R2,
   Durable Object, Queue, and Workers AI bindings. AI stays out of the base
   config so local tests do not require remote credentials.

The URL lands in the deploy output (`https://yuma-agent-git-prod.<account>.workers.dev`);
add a custom domain with `worker/wrangler.jsonc` `routes` in `env.prod` or the
dashboard, as preferred.

## 5. Verify

```sh
curl https://<your-worker>.workers.dev/healthz          # {"ok":true}
curl https://<your-worker>.workers.dev/auth/status      # {"github_configured":true}
curl https://<your-worker>.workers.dev/api/v1/repos     # 401: sign-in required
curl -H "Authorization: Bearer $YAG_TOKEN" \
  https://<your-worker>.workers.dev/api/v1/repos        # public repos + yours
```

For the full signed-in path (commits, CLI, pull requests, CI runs) run the live
smoke harness described in the [smoke report](deployment-smoke-2026-10-15.md#reproducing-the-smoke-test).

`wrangler deploy --dry-run` must pass in CI with zero plaintext secrets — the
workflow greps for key material and fails on any hit.

## Cloudflare CI runners

The base configuration keeps `CI_ENABLED=false`; Yuma's `env.prod` sets it to
`true` with a $5 monthly compute admission budget. It defines the `ci-runs`
Queue, `CiRunnerDO` SQLite migration and a production container image. Atomic D1 admission allows at most
two queued/running jobs; native container mode has no `max_instances` configuration. The new D1 migration is `0009_reviews_ci.sql`; apply migrations
before deploying the Worker that reads these tables. The native Container API and
Wrangler version in the lockfile are required; older Sandbox tutorials use a
different API/configuration shape.

1. Use a Workers Paid account with Containers enabled. For a new environment,
   replace both D1 IDs and provision R2/Queues resources. `setup-queues.sh` includes
   `ci-runs`. Keep CI disabled for the initial deploy.
2. Ensure the deployment machine has a Linux amd64 Docker builder. On Justin's
   machine the approved build context is `homelab`; explicitly select it with
   `DOCKER_CONTEXT=homelab cf-vault npm run deploy`. Elsewhere choose that environment's
   approved Docker context. Wrangler builds `worker/runner/Dockerfile` with its
   directory as the build context, then uploads it to Cloudflare's managed registry.
3. Deploy, verify repository browsing and PR creation, and configure one small
   pilot pipeline. Set `env.prod.vars.CI_MONTHLY_BUDGET_USD` to the intended shared
   admission budget (default `5`). Invalid/nonpositive values admit no new runs.
4. Set `env.prod.vars.CI_ENABLED` to `"true"`, redeploy and run the pilot checks.
   Keep the time limit small. Check actual Cloudflare usage before widening access.

The container entrypoint keeps the VM alive while the trusted boot script starts
Docker through native exec, making startup failures visible in job logs. Docker
uses `--iptables=false --ip6tables=false --bridge=none --ip-forward=false
--ip-masq=false --storage-driver=vfs`; Cloudflare's read-only network settings
reject Docker's default forwarding setup. Inner builds use `--network=host`.

For optional image publishing, set the following secret **names**, supplying
values through your approved secret manager/interactive secret workflow:

```sh
npx wrangler secret put CI_REGISTRY_HOST --env prod -c worker/wrangler.jsonc
npx wrangler secret put CI_REGISTRY_USERNAME --env prod -c worker/wrangler.jsonc
npx wrangler secret put CI_REGISTRY_PASSWORD --env prod -c worker/wrangler.jsonc
```

`CI_REGISTRY_HOST` is a hostname, e.g. `ghcr.io` (no scheme). Authorize the exact
image path for each repo using the nonsecret `CI_REGISTRY_IMAGES` JSON-string var
in `env.prod.vars`, e.g. `{"team/project":"ghcr.io/team/project"}`. Use a scoped
registry credential with only the necessary image-write access. The repository
admin's configured image must match this map and registry host. Different repos
should have different destinations. Credentials never enter the source/build VM.
ECR's short-lived password must be refreshed externally; no AWS credentials or
automatic ECR token refresh are supplied by this version.

The image is published only on an explicit admin request for the default head at
admission; later branch movement does not retag the queued immutable revision.
Publication uses `cs-<changeset>` tags and does not perform application deployment.
The 256 MiB export cap is intentional. Registry pushes can finish just before a
network error/cancellation is observed; inspect the exact tag before manually
retrying an uncertain result.

### Pilot verification and recovery

- Run a passing pipeline and a failing command. Verify completed logs and status.
- Submit the same revision twice while active: the second request must be rejected.
- Cancel a long command and test the deadline; confirm container instances stop in
  Cloudflare, not merely that the UI status changes.
- Open a PR, approve it as another writer, update its head, and verify approval is
  required again. Change pipeline configuration and verify old checks cannot merge.
- Try direct protected default-branch movement and verify it is denied.
- Publish a small Docker image to the authorized destination; verify its full
  changeset tag in the registry. Verify another repo cannot target that destination.
- Inspect actual compute, network, DO, D1, R2 and Queue usage. Configure account
  billing alerts; the reservation ledger does not cap the total Cloudflare invoice.

Turning `CI_ENABLED` off prevents new runs but does not kill an active VM. Cancel
active runs explicitly; their deadline alarms remain a second cleanup mechanism.
Queue delivery is at-most-once at the script level; jobs interrupted before claim
are failed, and claimed jobs have a deadline alarm plus a cron recovery sweep. The minute cron expires
undelivered queued jobs and removes completed logs older than seven days. Keep
`ci_runs` rows to preserve reservation accounting and the audit history.

Configure an R2 lifecycle rule for the `ci/images/` prefix to delete abandoned
temporary exports after one day, and retain R2's incomplete multipart upload
cleanup. Normal completion/cancellation removes the temporary image; lifecycle
cleanup covers process/platform failures. Never apply that rule to repository
object prefixes. These cleanup rules are operator configuration, not automatically
provisioned by this change.

The local validation suite mocks container execution for lifecycle tests. The
runner Dockerfile can be built and its tools checked without privileged Docker.
The Yuma pilot additionally verified Docker-in-Docker, native `exec` output,
deadline teardown, cancellation and a real registry push. See the
[dated evidence and reproduction commands](deployment-smoke-2026-10-15.md).
Repeat these checks for a new environment or material runner changes.

See [research and cost model](github-cloudflare-research.md) and the
[developer quickstart](developer-onboarding.md).
