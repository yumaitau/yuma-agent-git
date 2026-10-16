# API reference

The HTTP surface of the yuma-agent-git Worker: the `/api/v1` JSON API, OAuth, the GitHub
webhook receiver, the MCP endpoint, and the `yag` CLI that drives them.

> **Regenerating.** Run `npm run docs:api -w worker` after changing routes, guards,
> token scopes or rate-limit buckets. The generator (`worker/scripts/gen-api-docs.ts`)
> loads the real Hono app and rewrites only the blocks between
> `<!-- generated:<name>:start -->` and `<!-- generated:<name>:end -->`. Everything else
> in this file is hand-written and survives regeneration. Edit it by hand, and keep it in
> step with the code.

## Overview

### Base URL

| Environment | Base URL                                          |
| ----------- | ------------------------------------------------- |
| Production  | `https://yuma-agent-git-prod.yuma-it.workers.dev` |
| Local dev   | `http://localhost:8787` (`npm run dev`)           |

JSON routes live under `/api/v1`. OAuth lives under `/auth/*`, the GitHub webhook at
`/webhooks/github`, and liveness at `/healthz`. Any other unrouted path falls through to
the dashboard SPA. An unrouted path under `/api/`, `/auth/`, `/webhooks/` or `/healthz`
returns `404 not_found` in the error envelope.

### Conventions

- **`:repo`** in a path is the full `owner/name` slug, slash included, for example
  `/api/v1/repos/acme/web/file`. The router matches it with `:repo{.+}`.
  `GET /api/v1/repos/:owner/:name` is the same slug split in two.
- **Revisions** (`cs`, `head`, `from`, `to`, `a`, `b`, `base_cs`, `first_parent`) accept
  a 64-hex changeset id, `ref:<name>`, or a bare ref name (`main`, `release/1.2`). An
  unresolvable revision is `404 revision_not_found`.
- **Content addresses** (changeset ids, tree and blob hashes) are lowercase 64-hex
  SHA-256.
- **Paths** in query strings are NFC-normalized and must be relative, with no leading or
  trailing `/` and no `.`/`..` segments. A bad path is `400 invalid_path`.
- **Timestamps** are Unix epoch **milliseconds**.
- Request bodies are JSON unless noted. A malformed body is `400 invalid_json`.
- Responses carry an `x-request-id` header for log correlation.

## Authentication

**Every `/api/*` route requires sign-in.** A request with no valid session cookie and no
valid bearer token gets `401 unauthorized` before any route logic runs. This applies to
**public repositories as well**. Anonymous callers cannot read anything under `/api`. The
only routes that work without credentials are `/healthz`, `/auth/*` (the OAuth flow
itself) and `/webhooks/github`, which is gated by its HMAC signature instead.

The Worker resolves the caller on every request, in this order:

1. **Session cookie `yag_session`**: set by the GitHub OAuth callback. The token is 32
   random bytes, stored only as its SHA-256. It is `HttpOnly; SameSite=Lax; Path=/`
   (plus `Secure` on https) and lasts 30 days, with sliding renewal once it is past
   halfway. A session principal acts as the full user and holds every token scope.
2. **`Authorization: Bearer yag_<40 hex>`**: an API token. Tokens are created from a
   browser session (`POST /api/v1/tokens`), stored as SHA-256, and the raw value is
   returned **once**. A token can be bound to one repo (`repo_id`) and can expire
   (`expires_at`). Expired or unknown tokens resolve to no principal, which means 401.

Token scopes:

<!-- generated:scopes:start -->

- `repo:read`
- `repo:write`
- `agent:run`
- `audit:read`

<!-- generated:scopes:end -->

| Scope        | Grants                                                                                                                        |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `repo:read`  | `read` and `history` on repos the token's user can see                                                                        |
| `repo:write` | Everything `repo:read` grants, plus `write`. Also required (with the user's role) for `admin`                                 |
| `agent:run`  | `POST /api/v1/repos/:repo/agents/tasks`, superfan registration and the MCP endpoint (repo `read`; `write` for mutating tools) |

Scopes only narrow access. A token never exceeds its user's role. A repo-bound token
cannot see any other repo, which surfaces as 404.

**Session-only routes.** Routes marked `session` in the route table require a browser
session and reject bearer tokens with `401 unauthorized` (`session required`), so a
leaked token cannot mint more tokens or change repo administration. These are token
management, repo creation, `cache-token`, members, path rules, metrics, superfans and
the GitHub App routes. The MCP endpoint is the reverse: it accepts **only** bearer
tokens.

### OAuth flow

1. `GET /auth/status` returns `{github_configured: boolean}`.
2. `GET /auth/github` responds 302 to GitHub with a single-use `state` (10-minute TTL)
   and scope `read:user user:email`, and sets the state in an HttpOnly
   `yag_login_state` cookie that binds the sign-in to this browser. It returns `500
not_configured` when the OAuth secrets are missing.
3. `GET /auth/github/callback?code&state` requires the `yag_login_state` cookie to
   match `state`, then checks and consumes the state (`400 invalid_state` if the
   cookie is missing or different, or the state is unknown, reused or expired),
   exchanges the code, upserts the user by GitHub id, sets `yag_session`, clears
   `yag_login_state`, and responds 302 to `/`. OIDC sign-in binds its state the same
   way. A failed exchange is `502
oauth_exchange_failed` or `502 github_api_failed`.
4. `POST /auth/logout` revokes the session and clears the cookie, returning `{ok: true}`.

## Authorization (RBAC)

Repo permissions are `read`, `history`, `write` and `admin`. The first matching step
below decides (`worker/src/auth/rbac.ts`):

1. **Token limits**: a repo-bound token is denied on other repos. `write`/`admin` need
   `repo:write`. `read`/`history` need `repo:read` or `repo:write`.
2. **Path rules** (when the route checks a path): the longest matching `path_prefix`
   wins. At equal length, the most specific principal wins (`user:`/`agent:` over `role:`
   over `*`). At equal specificity, `deny` beats `grant`. A rule decides only the perms
   it lists.
3. **Membership role**: `admin` gets everything. `write` gets read/history/write.
   `read` gets read/history.
4. **Repo creator** is admin.
5. **Public repos** grant `read` and `history` to every signed-in principal. Writes stay
   membership-only.
6. Otherwise the request is denied.

In the route table, **Permission** names the guard the handler calls:

- `read` / `write` / `admin`: the repo-level check.
- `path:read` / `path:history`: an additional check of path rules on the requested
  `path`.
- `(whole repo)`: the route can expose or replace any source path, so the caller must
  not be restricted by **any** path rule (`read` for reads, `read` and `write` for
  writes), or the request is `403 whole_repository_required` with `denied_by` naming the
  restricting rule. This covers pull requests and CI, content-addressed objects
  (`object/*`, `fetch-objects`, `checkout-info`: a hash cannot be mapped back to a path),
  every export, and ref moves (pointing a ref at a changeset publishes all its paths).
  On these routes a token also needs `repo:read` (reads) or `repo:write` (everything
  else), otherwise `403 insufficient_scope`.

Path rules also shape two kinds of route the table marks only `read` or `write`:

- **Listings** (`tree`, `diff`, `changed-paths`, `history`, `changesets`) drop every
  path the caller may not `read` instead of failing. Each response that dropped
  something carries `omitted_paths_count` (on the body, or on each changeset).
- **Commits** (`POST …/changesets`) need `write` on every changed path. The first denied
  path fails the whole commit with `403 forbidden`, `path` and `denied_by`.

### 404 vs 403 contract

Repo existence is never leaked (`worker/src/auth/guards.ts`):

| Situation                                                                   | Response                                                           |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| No credentials on `/api/*`                                                  | `401 unauthorized`                                                 |
| Repo does not exist                                                         | `404 repo_not_found`                                               |
| Repo exists but the caller cannot `read` it, whatever perm the route needed | `404 repo_not_found`                                               |
| Caller can read the repo but lacks the needed perm                          | `403 forbidden`, with `denied_by` when a path rule denied          |
| A path rule explicitly denies `history` or `read` on a blame/history path   | `403 forbidden` with `denied_by`                                   |
| A path rule denies `write` on a path a commit changes                       | `403 forbidden` with `path` and `denied_by`                        |
| Any path rule restricts the caller on a `(whole repo)` route                | `403 whole_repository_required` with `denied_by`                   |
| Token bound to another repo (pulls/CI)                                      | `404 repo_not_found`                                               |
| Token lacks the scope a route checks                                        | `403 insufficient_scope`, or `403 forbidden` with `required_scope` |

`denied_by` is `{id, path_prefix, effect, principal}` of the deciding rule, so the UI
can name it.

## Errors

Every error uses one envelope (`worker/src/api/errors.ts`):

```json
{ "error": { "code": "repo_not_found", "message": "no repo acme/web" } }
```

Extra fields sit next to `code` and `message` when they help. Examples are `issues:
[{path, message}]` on schema failures, `denied_by`, `required_scope`, `retry_after_s` and
`bucket` on 429, `expected`/`actual` on a stale ref, and limits on 413. Unexpected
failures are logged and returned as `500 internal_error` with no internals.

| Status | Common codes                                                                                                                                                                            |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `invalid_json`, `invalid_request`, `invalid_path`, `missing_sha256`, `hash_mismatch`, `unknown_parent`, `unknown_target`, `not_a_tree`, `invalid_ci_config`, `invalid_review`           |
| 401    | `unauthorized`, `invalid_signature` (webhook)                                                                                                                                           |
| 403    | `forbidden`, `insufficient_scope`, `whole_repository_required`, `protected_branch`, `self_review`, `not_admin`                                                                          |
| 404    | `not_found`, `repo_not_found`, `revision_not_found`, `path_not_found`, `object_not_found`, `changeset_not_found`, `ref_not_found`, `task_not_found`, `token_not_found`, `run_not_found` |
| 409    | `repo_exists`, `repo_initialized`, `ref_stale`, `ref_not_fast_forward`, `no_changes`, `pull_stale`, `pull_closed`, `merge_blocked`, `tree_too_large`                                    |
| 413    | `file_too_large`, `fetch_too_large`, `payload_too_large`, `export_too_large`                                                                                                            |
| 429    | `rate_limited`, `write_too_large`                                                                                                                                                       |
| 500    | `internal_error`, `object_corrupt`, `not_configured`                                                                                                                                    |

## Rate limits

Requests are counted in sliding 60-second windows per (principal, bucket). The key is
`user:<id>` for sessions and bearer tokens alike, or the client IP when there is no
principal. Defaults per minute:

<!-- generated:rate-limits:start -->

| Bucket         | Requests per minute |
| -------------- | ------------------- |
| `agent_run`    | 20                  |
| `api_read`     | 600                 |
| `api_write`    | 120                 |
| `auth`         | 10                  |
| `git`          | 300                 |
| `object_fetch` | 2000                |

<!-- generated:rate-limits:end -->

Bucket selection (`bucketFor` in `worker/src/middleware/ratelimit.ts`), in order:
`/webhooks/*` is exempt (HMAC is the gate). `/auth/*` uses `auth`. Paths containing
`/agents/mcp` or `/agents/tasks` use `agent_run`. Paths containing `/fetch-objects` or
`/object/` use `object_fetch`. Everything else uses `api_read` for GET/HEAD and
`api_write` otherwise. Operators can override limits with the `RATE_LIMIT_BUCKETS` JSON
var.

When a window is spent the response is:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 17

{"error":{"code":"rate_limited","message":"too many requests","retry_after_s":17,"bucket":"api_write"}}
```

Separately, `POST /changesets` returns `429 write_too_large` for commits over 1000 files
or 64 MiB of inline content.

## Caching

Every `/api/*` response is per-user, so **no API response is ever `public`**. Any
`public` directive a route sets is rewritten to `private` on the way out. Browsers may
keep immutable reads, but shared caches never store them.

| Response                                                                           | `Cache-Control`                        |
| ---------------------------------------------------------------------------------- | -------------------------------------- |
| Public repo, every revision content-addressed (64-hex) or hash-addressed objects   | `private, max-age=31536000, immutable` |
| Public repo, ref-addressed revision (`main`, `ref:main`), or history               | `private, max-age=10`                  |
| Private repo, and all metadata (refs, changesets, pulls, CI, tasks, tokens, repos) | `private, no-store`                    |

Immutable responses carry an `ETag` derived from the content address. The server sends
it but does not answer conditional requests with 304.

**Edge cache tier.** `GET` routes that serve content-addressed bytes (`object/tree`,
`object/blob`, `file`, `tree`, `diff`, `export/tarball`, `export/fast-import`) also pass
through the cache tier (`worker/src/middleware/cachetier.ts`). Because every API caller
is authenticated, these responses are forced to `private, no-store` with
`x-yag-cache: bypass` **unless** the URL carries a valid `cache_token`:

1. `POST /api/v1/cache-token` (session only) with `{"url": "<absolute or path URL>"}`
   returns `{token, expires_at}`. The token is `<expiry>.<HMAC-SHA256(url|expiry)>`,
   signed with `CACHE_SIGNING_KEY` and valid for 1 hour.
2. Append `&cache_token=<token>` to that exact URL. The token is stripped from the cache
   key. The route still re-checks authorization on every request, hits included.
3. A signed 200 response (8 MiB or less) is stored in the Workers edge cache for at most
   10 seconds under a key separate from unsigned reads. The response reports
   `x-yag-cache: miss` or `hit`. The browser-facing `Cache-Control` stays private.

Without a configured signing key, tokens fail closed.

## Routes

<!-- generated:routes:start -->

346 routes. Auth: `any` = session cookie or bearer token, `session` = browser session only, `token` = bearer token only. Every `/api/*` route rejects anonymous callers with 401 before any of these checks run.

| Method | Path                                                       | Auth                           | Permission                                                                      | Rate bucket  | Purpose                                                                                                                                                                       |
| ------ | ---------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/.well-known/oauth-authorization-server`                  | none                           | —                                                                               | api_read     | RFC 8414 authorization server metadata                                                                                                                                        |
| GET    | `/.well-known/oauth-protected-resource`                    | none                           | —                                                                               | api_read     | RFC 9728 metadata for the `/mcp` resource                                                                                                                                     |
| GET    | `/.well-known/oauth-protected-resource/mcp`                | none                           | —                                                                               | api_read     | RFC 9728 metadata for `/mcp` (path-inserted form)                                                                                                                             |
| GET    | `/.well-known/yag-provenance-keys`                         | none                           | —                                                                               | api_read     | Provenance signing keys, current and previous (public)                                                                                                                        |
| POST   | `/:owner/:repo.git/git-receive-pack`                       | token (Basic or Bearer)        | write; read (whole repo)                                                        | api_write    | Git push: pack, pre-receive checks, ref CAS                                                                                                                                   |
| POST   | `/:owner/:repo.git/git-upload-pack`                        | token (Basic or Bearer)        | read (whole repo)                                                               | api_write    | Git protocol v2 `ls-refs` and `fetch` (clone, fetch)                                                                                                                          |
| GET    | `/:owner/:repo.git/info/refs`                              | token (Basic or Bearer)        | read (whole repo); write for `git-receive-pack`                                 | api_read     | Git smart HTTP advertisement: v2 capabilities, or refs for `git-receive-pack`                                                                                                 |
| GET    | `/api/v1`                                                  | any                            | —                                                                               | api_read     | API root: `{ok, service, api: "v1"}`                                                                                                                                          |
| GET    | `/api/v1/admin/agents/pause`                               | session                        | —                                                                               | api_read     | Whether every agent on the instance is paused                                                                                                                                 |
| POST   | `/api/v1/admin/agents/pause`                               | session                        | —                                                                               | api_write    | Pause every agent: revoke agent tokens, cancel runs (`AGENTS_ADMIN_USER_IDS`)                                                                                                 |
| DELETE | `/api/v1/admin/agents/pause`                               | session                        | —                                                                               | api_write    | Resume agents on the instance                                                                                                                                                 |
| GET    | `/api/v1/admin/metrics`                                    | session                        | admin on any repo                                                               | api_read     | Operational metrics (`?component=&window=`)                                                                                                                                   |
| POST   | `/api/v1/admin/secrets/rewrap`                             | session                        | —                                                                               | api_write    | Re-wrap secret data keys under the current KEK (`SECRETS_ADMIN_USER_IDS`)                                                                                                     |
| GET    | `/api/v1/agents`                                           | session                        | —                                                                               | api_read     | Agent identities you manage, with live token counts                                                                                                                           |
| POST   | `/api/v1/agents`                                           | session                        | —                                                                               | api_write    | Create an agent identity (you or an org own it)                                                                                                                               |
| PATCH  | `/api/v1/agents/:id`                                       | session                        | —                                                                               | api_write    | Disable (kill switch, revokes tokens) or enable an agent                                                                                                                      |
| DELETE | `/api/v1/agents/:id/tokens`                                | session                        | —                                                                               | api_write    | Revoke every live token of an agent                                                                                                                                           |
| GET    | `/api/v1/agents/tasks/:id`                                 | any                            | read                                                                            | agent_run    | Agent task row plus live agent state                                                                                                                                          |
| POST   | `/api/v1/agents/tasks/:id/cancel`                          | any                            | write                                                                           | agent_run    | Cancel an agent task                                                                                                                                                          |
| GET    | `/api/v1/agents/tasks/:id/transcript`                      | any                            | read                                                                            | agent_run    | Transcript entries (`?since=` ms)                                                                                                                                             |
| GET    | `/api/v1/apps`                                             | session                        | —                                                                               | api_read     | Apps you manage                                                                                                                                                               |
| POST   | `/api/v1/apps`                                             | session                        | —                                                                               | api_write    | Create an app (private key returned once), optionally with its webhook                                                                                                        |
| GET    | `/api/v1/apps/:id`                                         | session                        | app owner                                                                       | api_read     | An app you manage, its installations and webhook                                                                                                                              |
| DELETE | `/api/v1/apps/:id`                                         | session                        | app owner                                                                       | api_write    | Delete an app, its installations, tokens and webhook                                                                                                                          |
| POST   | `/api/v1/apps/:id/installations`                           | session                        | admin (whole repo)                                                              | api_write    | Install an app on repositories you administer                                                                                                                                 |
| GET    | `/api/v1/audit/stream`                                     | any                            | —                                                                               | api_read     | SIEM stream delivery status                                                                                                                                                   |
| POST   | `/api/v1/cache-token`                                      | session                        | —                                                                               | api_write    | Mint a signed `cache_token` for one URL                                                                                                                                       |
| POST   | `/api/v1/ci/actions/check`                                 | any                            | —                                                                               | api_write    | Compatibility report for workflow files sent in the body; nothing is stored (`yag actions check`)                                                                             |
| GET    | `/api/v1/github/install-url`                               | session                        | —                                                                               | api_read     | 302 to the GitHub App install page                                                                                                                                            |
| GET    | `/api/v1/hooks/:id`                                        | session                        | manages the hook's repo, org or app                                             | api_read     | A webhook (never its secret)                                                                                                                                                  |
| PATCH  | `/api/v1/hooks/:id`                                        | session                        | manages the hook's repo, org or app                                             | api_write    | Change a webhook URL, secret, events, format or state                                                                                                                         |
| DELETE | `/api/v1/hooks/:id`                                        | session                        | manages the hook's repo, org or app                                             | api_write    | Delete a webhook and its delivery log                                                                                                                                         |
| GET    | `/api/v1/hooks/:id/deliveries`                             | session                        | manages the hook's repo, org or app                                             | api_read     | Recent deliveries: status, attempts, response code                                                                                                                            |
| POST   | `/api/v1/hooks/:id/deliveries/:delivery/redeliver`         | session                        | manages the hook's repo, org or app                                             | api_write    | Send a delivery again                                                                                                                                                         |
| GET    | `/api/v1/installations`                                    | session                        | —                                                                               | api_read     | App installations you made                                                                                                                                                    |
| DELETE | `/api/v1/installations/:id`                                | session                        | —                                                                               | api_write    | Remove an installation (its tokens stop at once)                                                                                                                              |
| POST   | `/api/v1/me/passkeys`                                      | session                        | —                                                                               | api_write    | Register a passkey                                                                                                                                                            |
| DELETE | `/api/v1/me/passkeys/:id`                                  | session                        | —                                                                               | api_write    | Remove a passkey                                                                                                                                                              |
| POST   | `/api/v1/me/passkeys/options`                              | session                        | —                                                                               | api_write    | Passkey registration challenge                                                                                                                                                |
| GET    | `/api/v1/me/security`                                      | session                        | —                                                                               | api_read     | Sign-in method, MFA freshness and enrolled factors                                                                                                                            |
| GET    | `/api/v1/me/signing-keys`                                  | session                        | —                                                                               | api_read     | Your commit signing keys                                                                                                                                                      |
| POST   | `/api/v1/me/signing-keys`                                  | session                        | —                                                                               | api_write    | Register an SSH or OpenPGP commit signing key                                                                                                                                 |
| DELETE | `/api/v1/me/signing-keys/:id`                              | session                        | —                                                                               | api_write    | Remove a commit signing key                                                                                                                                                   |
| POST   | `/api/v1/me/totp`                                          | session                        | —                                                                               | api_write    | Start authenticator app enrolment                                                                                                                                             |
| DELETE | `/api/v1/me/totp`                                          | session                        | —                                                                               | api_write    | Remove the authenticator app (recent MFA)                                                                                                                                     |
| POST   | `/api/v1/me/totp/confirm`                                  | session                        | —                                                                               | api_write    | Confirm authenticator enrolment with a code                                                                                                                                   |
| GET    | `/api/v1/oauth-apps`                                       | session                        | —                                                                               | api_read     | OAuth apps you manage                                                                                                                                                         |
| POST   | `/api/v1/oauth-apps`                                       | session                        | —                                                                               | api_write    | Register an OAuth app (client secret returned once)                                                                                                                           |
| DELETE | `/api/v1/oauth-apps/:id`                                   | session                        | —                                                                               | api_write    | Delete an OAuth app and revoke its tokens                                                                                                                                     |
| GET    | `/api/v1/oauth/authorize`                                  | session                        | —                                                                               | api_read     | Check an authorization request for the consent page                                                                                                                           |
| POST   | `/api/v1/oauth/authorize`                                  | session                        | —                                                                               | api_write    | Approve or deny an authorization request (returns the redirect)                                                                                                               |
| GET    | `/api/v1/openapi.json`                                     | any                            | —                                                                               | api_read     | This API as an OpenAPI 3.1 document                                                                                                                                           |
| GET    | `/api/v1/orgs`                                             | session                        | —                                                                               | api_read     | Orgs the caller belongs to                                                                                                                                                    |
| POST   | `/api/v1/orgs`                                             | session                        | —                                                                               | api_write    | Create an org (caller becomes owner)                                                                                                                                          |
| GET    | `/api/v1/orgs/:org`                                        | session                        | org member                                                                      | api_read     | One org and the caller role                                                                                                                                                   |
| PATCH  | `/api/v1/orgs/:org`                                        | session                        | org owner                                                                       | api_write    | Org settings (owners)                                                                                                                                                         |
| GET    | `/api/v1/orgs/:org/agents/pause`                           | session                        | org member                                                                      | api_read     | Org and instance agent pause, and who paused                                                                                                                                  |
| POST   | `/api/v1/orgs/:org/agents/pause`                           | session                        | org owner or admin                                                              | api_write    | Pause org agents: revoke their tokens, cancel runs, refuse writes                                                                                                             |
| DELETE | `/api/v1/orgs/:org/agents/pause`                           | session                        | org owner or admin                                                              | api_write    | Resume org agents                                                                                                                                                             |
| GET    | `/api/v1/orgs/:org/audit`                                  | any                            | —                                                                               | api_read     | Search or export the org audit chain                                                                                                                                          |
| GET    | `/api/v1/orgs/:org/ci/limits`                              | session                        | org owner or admin                                                              | api_read     | Org CI limits (null: shared pool), this month's reservations and budget alerts                                                                                                |
| PUT    | `/api/v1/orgs/:org/ci/limits`                              | session                        | —                                                                               | api_write    | CI admins: give the org its own CI pool                                                                                                                                       |
| DELETE | `/api/v1/orgs/:org/ci/limits`                              | session                        | —                                                                               | api_write    | CI admins: move the org back to the shared pool                                                                                                                               |
| GET    | `/api/v1/orgs/:org/hooks`                                  | session                        | org owner                                                                       | api_read     | List org webhooks                                                                                                                                                             |
| POST   | `/api/v1/orgs/:org/hooks`                                  | session                        | org owner                                                                       | api_write    | Create an org webhook (all org repositories)                                                                                                                                  |
| GET    | `/api/v1/orgs/:org/imports`                                | any                            | org owner or admin; token needs `repo:write`, no agents                         | api_read     | Recent GitHub bulk imports                                                                                                                                                    |
| POST   | `/api/v1/orgs/:org/imports`                                | any                            | org owner or admin; token needs `repo:write`, no agents                         | api_write    | Import a GitHub org (history, issues, pulls, releases, LFS); the caller must administer it on GitHub                                                                          |
| GET    | `/api/v1/orgs/:org/imports/:id`                            | any                            | org owner or admin; token needs `repo:write`, no agents                         | api_read     | Bulk import progress and per-repo report                                                                                                                                      |
| POST   | `/api/v1/orgs/:org/imports/:id/resume`                     | any                            | org owner or admin; token needs `repo:write`, no agents                         | api_write    | Retry failed repos from their checkpoints                                                                                                                                     |
| GET    | `/api/v1/orgs/:org/members`                                | session                        | org member                                                                      | api_read     | List org members                                                                                                                                                              |
| PUT    | `/api/v1/orgs/:org/members`                                | session                        | org owner or admin                                                              | api_write    | Add or change an org member                                                                                                                                                   |
| DELETE | `/api/v1/orgs/:org/members/:userId`                        | session                        | org owner or admin                                                              | api_write    | Remove an org member (and from its teams)                                                                                                                                     |
| GET    | `/api/v1/orgs/:org/policy`                                 | session                        | org member                                                                      | api_read     | Agent policy in force (the default pack when unset)                                                                                                                           |
| PUT    | `/api/v1/orgs/:org/policy`                                 | session                        | org owner or admin                                                              | api_write    | Save a new agent policy version                                                                                                                                               |
| GET    | `/api/v1/orgs/:org/policy/versions`                        | session                        | org owner or admin                                                              | api_read     | Agent policy version history                                                                                                                                                  |
| GET    | `/api/v1/orgs/:org/release-settings`                       | session                        | org member                                                                      | api_read     | Release asset size cap for the org                                                                                                                                            |
| PUT    | `/api/v1/orgs/:org/release-settings`                       | session                        | org owner                                                                       | api_write    | Set the org release asset size cap                                                                                                                                            |
| GET    | `/api/v1/orgs/:org/repos`                                  | session                        | org member                                                                      | api_read     | Org repos the caller can read                                                                                                                                                 |
| GET    | `/api/v1/orgs/:org/rulesets`                               | session                        | org owner or admin                                                              | api_read     | List org rulesets                                                                                                                                                             |
| POST   | `/api/v1/orgs/:org/rulesets`                               | session                        | org owner or admin                                                              | api_write    | Create an org ruleset                                                                                                                                                         |
| PUT    | `/api/v1/orgs/:org/rulesets/:id`                           | session                        | org owner or admin                                                              | api_write    | Replace an org ruleset                                                                                                                                                        |
| DELETE | `/api/v1/orgs/:org/rulesets/:id`                           | session                        | org owner or admin                                                              | api_write    | Delete an org ruleset                                                                                                                                                         |
| GET    | `/api/v1/orgs/:org/rulesets/evaluations`                   | session                        | org owner or admin                                                              | api_read     | Evaluate-mode log for org rulesets                                                                                                                                            |
| GET    | `/api/v1/orgs/:org/runners`                                | session                        | org owner or admin                                                              | api_read     | Org self-hosted runners                                                                                                                                                       |
| PATCH  | `/api/v1/orgs/:org/runners/:id`                            | session                        | org owner or admin                                                              | api_write    | Disable, enable or mark an org runner trusted-only                                                                                                                            |
| DELETE | `/api/v1/orgs/:org/runners/:id`                            | session                        | org owner or admin                                                              | api_write    | Revoke an org runner and fail its running job                                                                                                                                 |
| POST   | `/api/v1/orgs/:org/runners/registration-token`             | session                        | org owner or admin                                                              | api_write    | One-time org runner registration token (1 hour, recent MFA)                                                                                                                   |
| GET    | `/api/v1/orgs/:org/secrets`                                | session                        | org owner or admin                                                              | api_read     | Org secret names; values are write-only                                                                                                                                       |
| PUT    | `/api/v1/orgs/:org/secrets/:name`                          | session                        | org owner or admin                                                              | api_write    | Set an org secret `{value}`                                                                                                                                                   |
| DELETE | `/api/v1/orgs/:org/secrets/:name`                          | session                        | org owner or admin                                                              | api_write    | Delete an org secret                                                                                                                                                          |
| GET    | `/api/v1/orgs/:org/sso`                                    | session                        | org member                                                                      | api_read     | Org SSO settings and whether the caller meets them                                                                                                                            |
| PUT    | `/api/v1/orgs/:org/sso`                                    | session                        | org owner                                                                       | api_write    | Set org SSO (owners, recent MFA)                                                                                                                                              |
| DELETE | `/api/v1/orgs/:org/sso`                                    | session                        | org owner                                                                       | api_write    | Remove org SSO (owners, recent MFA)                                                                                                                                           |
| GET    | `/api/v1/orgs/:org/teams`                                  | session                        | org member                                                                      | api_read     | List teams                                                                                                                                                                    |
| POST   | `/api/v1/orgs/:org/teams`                                  | session                        | org owner or admin                                                              | api_write    | Create a team (optional parent)                                                                                                                                               |
| GET    | `/api/v1/orgs/:org/teams/:team`                            | session                        | org member                                                                      | api_read     | Team, members and repo grants                                                                                                                                                 |
| PUT    | `/api/v1/orgs/:org/teams/:team/members`                    | session                        | org owner or admin                                                              | api_write    | Add a team member                                                                                                                                                             |
| DELETE | `/api/v1/orgs/:org/teams/:team/members/:userId`            | session                        | org owner or admin                                                              | api_write    | Remove a team member                                                                                                                                                          |
| PUT    | `/api/v1/orgs/:org/teams/:team/repos`                      | session                        | org owner or admin                                                              | api_write    | Grant the team a repo role                                                                                                                                                    |
| DELETE | `/api/v1/orgs/:org/teams/:team/repos/:repo`                | session                        | org owner or admin                                                              | api_write    | Remove a team repo grant                                                                                                                                                      |
| GET    | `/api/v1/orgs/:org/variables`                              | session                        | org owner or admin                                                              | api_read     | Org variables with values                                                                                                                                                     |
| PUT    | `/api/v1/orgs/:org/variables/:name`                        | session                        | org owner or admin                                                              | api_write    | Set an org variable `{value}`                                                                                                                                                 |
| DELETE | `/api/v1/orgs/:org/variables/:name`                        | session                        | org owner or admin                                                              | api_write    | Delete an org variable                                                                                                                                                        |
| POST   | `/api/v1/policy/test`                                      | any                            | —                                                                               | api_write    | Run an agent policy (or the default pack) against test cases                                                                                                                  |
| GET    | `/api/v1/repos`                                            | any                            | token needs `repo:read` or `repo:write`                                         | api_read     | List repos visible to the caller (keyset paged)                                                                                                                               |
| POST   | `/api/v1/repos`                                            | session                        | —                                                                               | api_write    | Create a repo (creator becomes admin)                                                                                                                                         |
| GET    | `/api/v1/repos/:owner/:name`                               | any                            | read                                                                            | api_read     | Repo metadata plus `can_admin`                                                                                                                                                |
| PUT    | `/api/v1/repos/:owner/:name`                               | any                            | admin                                                                           | api_write    | Change the default branch or ref naming mode                                                                                                                                  |
| POST   | `/api/v1/repos/:owner/:name/initialize`                    | any                            | admin                                                                           | api_write    | Seed `README.md` on an empty repo default branch                                                                                                                              |
| POST   | `/api/v1/repos/:repo/agents/mcp`                           | token                          | read; write for `commit`/`land`/`create_task` + `agent:run`                     | agent_run    | Deprecated per-repo MCP JSON-RPC subset; use `/mcp`                                                                                                                           |
| GET    | `/api/v1/repos/:repo/agents/superfans`                     | any                            | admin                                                                           | api_read     | List the repo's superfans and their findings                                                                                                                                  |
| POST   | `/api/v1/repos/:repo/agents/superfans`                     | any                            | admin + `agent:run`                                                             | api_write    | Start a per-component monitor on this repo                                                                                                                                    |
| DELETE | `/api/v1/repos/:repo/agents/superfans/:component`          | any                            | admin                                                                           | api_write    | Stop a superfan                                                                                                                                                               |
| GET    | `/api/v1/repos/:repo/agents/tasks`                         | any                            | read                                                                            | agent_run    | List agent tasks (`?status=&limit=`)                                                                                                                                          |
| POST   | `/api/v1/repos/:repo/agents/tasks`                         | any                            | write + `agent:run`                                                             | agent_run    | Queue an agent task                                                                                                                                                           |
| GET    | `/api/v1/repos/:repo/ancestor-distance`                    | any                            | read                                                                            | api_read     | First-parent distance between `a` and `b`                                                                                                                                     |
| GET    | `/api/v1/repos/:repo/approvals`                            | any                            | admin (whole repo)                                                              | api_read     | Agent actions held for a human (`?state=pending\|approved\|rejected\|all`)                                                                                                    |
| POST   | `/api/v1/repos/:repo/approvals/:id`                        | session                        | admin (whole repo)                                                              | api_write    | Approve or reject a held agent action                                                                                                                                         |
| POST   | `/api/v1/repos/:repo/attestations/verify`                  | any                            | read (whole repo)                                                               | api_write    | Verify a DSSE envelope against the published CI keys (optional `sha256` subject)                                                                                              |
| GET    | `/api/v1/repos/:repo/blame`                                | any                            | read + path:history                                                             | api_read     | Line ranges to changesets for one file                                                                                                                                        |
| PUT    | `/api/v1/repos/:repo/blob`                                 | any                            | write                                                                           | api_write    | Pre-upload a blob (hash-verified, max 64 MiB)                                                                                                                                 |
| GET    | `/api/v1/repos/:repo/changed-paths`                        | any                            | read                                                                            | api_read     | Files changed by one changeset                                                                                                                                                |
| GET    | `/api/v1/repos/:repo/changesets`                           | any                            | read                                                                            | api_read     | First-parent changeset log (cursor paged)                                                                                                                                     |
| POST   | `/api/v1/repos/:repo/changesets`                           | any                            | write                                                                           | api_write    | Commit: create a changeset (never moves refs)                                                                                                                                 |
| GET    | `/api/v1/repos/:repo/changesets/:id`                       | any                            | read                                                                            | api_read     | One changeset                                                                                                                                                                 |
| GET    | `/api/v1/repos/:repo/checkout-info`                        | any                            | read (whole repo)                                                               | api_read     | Root tree and size estimate for a checkout                                                                                                                                    |
| GET    | `/api/v1/repos/:repo/ci`                                   | any                            | read (whole repo)                                                               | api_read     | CI policy, recent runs, budget and capabilities                                                                                                                               |
| PUT    | `/api/v1/repos/:repo/ci`                                   | any                            | admin (whole repo)                                                              | api_write    | Save the CI policy                                                                                                                                                            |
| GET    | `/api/v1/repos/:repo/ci/actions`                           | any                            | read (whole repo)                                                               | api_read     | GitHub Actions compatibility report for `.github/workflows` at `?head=` (default branch): per-workflow status, reasons by line and the translated pipeline                    |
| PUT    | `/api/v1/repos/:repo/ci/actions`                           | any                            | admin (whole repo)                                                              | api_write    | Opt in or out of running translated `.github/workflows` as pipelines when the repo has no `.yuma/pipelines` (admin)                                                           |
| GET    | `/api/v1/repos/:repo/ci/artifacts/:id`                     | any                            | read (whole repo)                                                               | api_read     | Download a CI artifact (kept 14 days)                                                                                                                                         |
| GET    | `/api/v1/repos/:repo/ci/caches`                            | any                            | read (whole repo)                                                               | api_read     | CI cache entries, bytes used and the quota                                                                                                                                    |
| DELETE | `/api/v1/repos/:repo/ci/caches/:id`                        | session                        | admin (whole repo)                                                              | api_write    | Delete a CI cache entry                                                                                                                                                       |
| GET    | `/api/v1/repos/:repo/ci/detect`                            | any                            | admin (whole repo)                                                              | api_read     | Suggest CI commands from the default branch                                                                                                                                   |
| GET    | `/api/v1/repos/:repo/ci/pipelines`                         | any                            | read (whole repo)                                                               | api_read     | Pipeline runs with their jobs and spec errors (`?head=`)                                                                                                                      |
| POST   | `/api/v1/repos/:repo/ci/pipelines/runs`                    | any                            | write (whole repo)                                                              | api_write    | Start a pipeline with a manual trigger                                                                                                                                        |
| GET    | `/api/v1/repos/:repo/ci/pipelines/runs/:id/artifacts`      | any                            | read (whole repo)                                                               | api_read     | Every job's live artifacts for a pipeline run                                                                                                                                 |
| POST   | `/api/v1/repos/:repo/ci/pipelines/runs/:id/cancel`         | any                            | write (whole repo)                                                              | api_write    | Cancel a pipeline run                                                                                                                                                         |
| POST   | `/api/v1/repos/:repo/ci/runs`                              | any                            | write (whole repo); admin if `publish` + agent identity for `refs/agents/<id>/` | api_write    | Queue a CI run                                                                                                                                                                |
| GET    | `/api/v1/repos/:repo/ci/runs/:id/artifacts`                | any                            | read (whole repo)                                                               | api_read     | One CI job's live artifacts                                                                                                                                                   |
| POST   | `/api/v1/repos/:repo/ci/runs/:id/cancel`                   | any                            | write (whole repo)                                                              | api_write    | Cancel a CI run                                                                                                                                                               |
| GET    | `/api/v1/repos/:repo/ci/runs/:id/log`                      | any                            | read (whole repo)                                                               | api_read     | CI run log (`text/plain`)                                                                                                                                                     |
| POST   | `/api/v1/repos/:repo/ci/runs/:id/retry`                    | any                            | write (whole repo)                                                              | api_write    | Run a CI run again with its original trigger                                                                                                                                  |
| GET    | `/api/v1/repos/:repo/codeowners`                           | any                            | read (whole repo)                                                               | api_read     | CODEOWNERS at a revision: rules, resolved owners, errors and the owners of a path                                                                                             |
| POST   | `/api/v1/repos/:repo/connect`                              | session                        | admin                                                                           | api_write    | Link the repo to a GitHub repo via the App                                                                                                                                    |
| GET    | `/api/v1/repos/:repo/diff`                                 | any                            | read                                                                            | api_read     | Server-side diff between two revisions                                                                                                                                        |
| GET    | `/api/v1/repos/:repo/environment-approvals`                | any                            | read (whole repo)                                                               | api_read     | Runs waiting on environments (`?state=`)                                                                                                                                      |
| POST   | `/api/v1/repos/:repo/environment-approvals/:id`            | session                        | read (whole repo)                                                               | api_write    | Approve or reject a waiting run (listed reviewers, not the requester)                                                                                                         |
| GET    | `/api/v1/repos/:repo/environments`                         | any                            | read (whole repo)                                                               | api_read     | Deployment environments and protection rules                                                                                                                                  |
| PUT    | `/api/v1/repos/:repo/environments/:env`                    | session                        | admin (whole repo)                                                              | api_write    | Create or update an environment                                                                                                                                               |
| DELETE | `/api/v1/repos/:repo/environments/:env`                    | session                        | admin (whole repo)                                                              | api_write    | Delete an environment and its secrets and variables                                                                                                                           |
| GET    | `/api/v1/repos/:repo/export/fast-import`                   | any                            | read (whole repo)                                                               | api_read     | Stream a `git fast-import` export                                                                                                                                             |
| POST   | `/api/v1/repos/:repo/export/github`                        | any                            | write (whole repo)                                                              | api_write    | Queue a push of a revision to GitHub                                                                                                                                          |
| GET    | `/api/v1/repos/:repo/export/tarball`                       | any                            | read (whole repo)                                                               | api_read     | Stream a `.tar.gz` of one revision                                                                                                                                            |
| POST   | `/api/v1/repos/:repo/fetch-objects`                        | any                            | read (whole repo)                                                               | object_fetch | Batched want-only object fetch                                                                                                                                                |
| GET    | `/api/v1/repos/:repo/file`                                 | any                            | read + path:read                                                                | api_read     | Read one file at a revision                                                                                                                                                   |
| GET    | `/api/v1/repos/:repo/history`                              | any                            | read + path:history                                                             | api_read     | First-parent or per-path history                                                                                                                                              |
| GET    | `/api/v1/repos/:repo/hooks`                                | session                        | admin (whole repo)                                                              | api_read     | List repository webhooks                                                                                                                                                      |
| POST   | `/api/v1/repos/:repo/hooks`                                | session                        | admin (whole repo)                                                              | api_write    | Create a repository webhook                                                                                                                                                   |
| POST   | `/api/v1/repos/:repo/import`                               | any                            | write (whole repo)                                                              | api_write    | Queue a GitHub import job                                                                                                                                                     |
| GET    | `/api/v1/repos/:repo/import/:job_id`                       | any                            | read                                                                            | api_read     | Import job progress                                                                                                                                                           |
| GET    | `/api/v1/repos/:repo/is-ancestor`                          | any                            | read                                                                            | api_read     | Whether `a` is a first-parent ancestor of `b`                                                                                                                                 |
| GET    | `/api/v1/repos/:repo/issue-templates`                      | any                            | read                                                                            | api_read     | Issue templates and forms from `.yuma/` and `.github/ISSUE_TEMPLATE`                                                                                                          |
| GET    | `/api/v1/repos/:repo/issues`                               | any                            | read                                                                            | api_read     | List issues (`?state=&label=a,b&assignee=&milestone=&before=`) plus pinned issues                                                                                             |
| POST   | `/api/v1/repos/:repo/issues`                               | any                            | read                                                                            | api_write    | Open an issue; labels, assignees, milestone and parent apply with `triage`                                                                                                    |
| GET    | `/api/v1/repos/:repo/issues/:number`                       | any                            | read                                                                            | api_read     | Issue with comments, timeline, sub-issues and milestone                                                                                                                       |
| PATCH  | `/api/v1/repos/:repo/issues/:number`                       | any                            | read                                                                            | api_write    | Edit, close (with reason) or reopen (author or `triage`); milestone needs `triage`                                                                                            |
| DELETE | `/api/v1/repos/:repo/issues/:number`                       | any                            | admin                                                                           | api_write    | Delete an issue (its number is not reused)                                                                                                                                    |
| PUT    | `/api/v1/repos/:repo/issues/:number/assignees`             | any                            | triage                                                                          | api_write    | Replace assignees (logins, `user:`, `team:` or `agent:` principals)                                                                                                           |
| POST   | `/api/v1/repos/:repo/issues/:number/comments`              | any                            | read                                                                            | api_write    | Comment on an issue (`triage` when locked)                                                                                                                                    |
| PUT    | `/api/v1/repos/:repo/issues/:number/labels`                | any                            | triage                                                                          | api_write    | Replace an issue's labels                                                                                                                                                     |
| PUT    | `/api/v1/repos/:repo/issues/:number/lock`                  | any                            | triage                                                                          | api_write    | Lock or unlock comments (`{on}`)                                                                                                                                              |
| PUT    | `/api/v1/repos/:repo/issues/:number/pin`                   | any                            | triage                                                                          | api_write    | Pin or unpin (at most 3 per repo)                                                                                                                                             |
| POST   | `/api/v1/repos/:repo/issues/:number/sub-issues`            | any                            | triage                                                                          | api_write    | Add a sub-issue (`{number}`)                                                                                                                                                  |
| PUT    | `/api/v1/repos/:repo/issues/:number/sub-issues`            | any                            | triage                                                                          | api_write    | Reorder sub-issues (`{order}`)                                                                                                                                                |
| DELETE | `/api/v1/repos/:repo/issues/:number/sub-issues/:child`     | any                            | triage                                                                          | api_write    | Remove a sub-issue                                                                                                                                                            |
| GET    | `/api/v1/repos/:repo/labels`                               | any                            | read                                                                            | api_read     | List labels                                                                                                                                                                   |
| POST   | `/api/v1/repos/:repo/labels`                               | any                            | write                                                                           | api_write    | Create a label                                                                                                                                                                |
| DELETE | `/api/v1/repos/:repo/labels/:name`                         | any                            | write                                                                           | api_write    | Delete a label and remove it from issues                                                                                                                                      |
| GET    | `/api/v1/repos/:repo/members`                              | session                        | admin                                                                           | api_read     | List repo members                                                                                                                                                             |
| PUT    | `/api/v1/repos/:repo/members`                              | session                        | admin                                                                           | api_write    | Add or change a member role                                                                                                                                                   |
| DELETE | `/api/v1/repos/:repo/members/:userId`                      | session                        | admin                                                                           | api_write    | Remove a member                                                                                                                                                               |
| GET    | `/api/v1/repos/:repo/merge-base`                           | any                            | read                                                                            | api_read     | Merge base of `a` and `b`                                                                                                                                                     |
| GET    | `/api/v1/repos/:repo/merge-queue`                          | any                            | read (whole repo)                                                               | api_read     | Merge queue of a branch: entries in order and groups                                                                                                                          |
| GET    | `/api/v1/repos/:repo/migration`                            | session                        | admin (whole repo)                                                              | api_read     | Cutover state and the checks for each next move                                                                                                                               |
| POST   | `/api/v1/repos/:repo/migration`                            | session                        | admin (whole repo)                                                              | api_write    | Move the cutover state (checked; audited)                                                                                                                                     |
| GET    | `/api/v1/repos/:repo/milestones`                           | any                            | read                                                                            | api_read     | List milestones with open and closed counts                                                                                                                                   |
| POST   | `/api/v1/repos/:repo/milestones`                           | any                            | write                                                                           | api_write    | Create a milestone                                                                                                                                                            |
| PATCH  | `/api/v1/repos/:repo/milestones/:id`                       | any                            | write                                                                           | api_write    | Edit, close or reopen a milestone                                                                                                                                             |
| GET    | `/api/v1/repos/:repo/mirrors`                              | session                        | admin (whole repo)                                                              | api_read     | List pull and push mirrors with their last sync                                                                                                                               |
| POST   | `/api/v1/repos/:repo/mirrors`                              | session                        | admin (whole repo)                                                              | api_write    | Create a pull or push mirror (token write-only; `github_app` reaches the connected GitHub repo only)                                                                          |
| PATCH  | `/api/v1/repos/:repo/mirrors/:id`                          | session                        | admin (whole repo)                                                              | api_write    | Change a mirror remote, token, interval or state (a new remote URL needs the token again)                                                                                     |
| DELETE | `/api/v1/repos/:repo/mirrors/:id`                          | session                        | admin (whole repo)                                                              | api_write    | Delete a mirror                                                                                                                                                               |
| POST   | `/api/v1/repos/:repo/mirrors/:id/sync`                     | session                        | admin (whole repo)                                                              | api_write    | Sync a mirror now and return the outcome                                                                                                                                      |
| GET    | `/api/v1/repos/:repo/object/blob/:hash`                    | any                            | read (whole repo)                                                               | object_fetch | One blob (`?encoding=zstd\|identity`)                                                                                                                                         |
| GET    | `/api/v1/repos/:repo/object/tree/:hash`                    | any                            | read (whole repo)                                                               | object_fetch | One tree object                                                                                                                                                               |
| GET    | `/api/v1/repos/:repo/packages`                             | any                            | read                                                                            | api_read     | Packages linked to the repo (registry, #53)                                                                                                                                   |
| PATCH  | `/api/v1/repos/:repo/packages/:id`                         | any                            | admin                                                                           | api_write    | Set a package retention rule (`keep_untagged`)                                                                                                                                |
| GET    | `/api/v1/repos/:repo/path-rules`                           | session                        | admin                                                                           | api_read     | List directory-level permission rules                                                                                                                                         |
| POST   | `/api/v1/repos/:repo/path-rules`                           | session                        | admin                                                                           | api_write    | Add a path rule                                                                                                                                                               |
| DELETE | `/api/v1/repos/:repo/path-rules/:id`                       | session                        | admin                                                                           | api_write    | Delete a path rule                                                                                                                                                            |
| GET    | `/api/v1/repos/:repo/provenance`                           | any                            | read (whole repo)                                                               | api_read     | Signed provenance records for a changeset or ref, checked against the keys                                                                                                    |
| GET    | `/api/v1/repos/:repo/pulls`                                | any                            | read (whole repo)                                                               | api_read     | List pull requests (50 per page)                                                                                                                                              |
| POST   | `/api/v1/repos/:repo/pulls`                                | any                            | write (whole repo)                                                              | api_write    | Open a pull request                                                                                                                                                           |
| GET    | `/api/v1/repos/:repo/pulls/:id`                            | any                            | read (whole repo)                                                               | api_read     | Pull request, reviews and merge gate                                                                                                                                          |
| GET    | `/api/v1/repos/:repo/pulls/:id/codeowners`                 | any                            | read (whole repo)                                                               | api_read     | Code owners of each changed file and whether one approved                                                                                                                     |
| GET    | `/api/v1/repos/:repo/pulls/:id/conflicts`                  | any                            | read (whole repo)                                                               | api_read     | Would it merge into the current target? Conflicting paths and hunks                                                                                                           |
| POST   | `/api/v1/repos/:repo/pulls/:id/merge`                      | any                            | write (whole repo)                                                              | api_write    | Merge a pull request (merge commit, squash or rebase)                                                                                                                         |
| POST   | `/api/v1/repos/:repo/pulls/:id/queue`                      | any                            | write (whole repo)                                                              | api_write    | Add a pull request to its target branch merge queue (agents cannot)                                                                                                           |
| DELETE | `/api/v1/repos/:repo/pulls/:id/queue`                      | any                            | write (whole repo)                                                              | api_write    | Take a pull request out of the merge queue                                                                                                                                    |
| POST   | `/api/v1/repos/:repo/pulls/:id/review`                     | any                            | write (whole repo)                                                              | api_write    | Comment, approve or request changes, with inline comments                                                                                                                     |
| GET    | `/api/v1/repos/:repo/pulls/:id/reviewers`                  | any                            | read (whole repo)                                                               | api_read     | Requested reviewers and their state                                                                                                                                           |
| PUT    | `/api/v1/repos/:repo/pulls/:id/reviewers`                  | any                            | write (whole repo)                                                              | api_write    | Request reviews from people, teams, agents                                                                                                                                    |
| POST   | `/api/v1/repos/:repo/pulls/:id/suggestions/apply`          | any                            | write (whole repo)                                                              | api_write    | Commit suggested changes onto the head                                                                                                                                        |
| GET    | `/api/v1/repos/:repo/pulls/:id/threads`                    | any                            | read (whole repo)                                                               | api_read     | Line review threads with their comments                                                                                                                                       |
| POST   | `/api/v1/repos/:repo/pulls/:id/threads`                    | any                            | write (whole repo)                                                              | api_write    | Comment on lines of the current revision                                                                                                                                      |
| POST   | `/api/v1/repos/:repo/pulls/:id/threads/:thread/replies`    | any                            | write (whole repo)                                                              | api_write    | Reply to a review thread                                                                                                                                                      |
| PUT    | `/api/v1/repos/:repo/pulls/:id/threads/:thread/resolution` | any                            | write (whole repo)                                                              | api_write    | Resolve or unresolve a review thread                                                                                                                                          |
| POST   | `/api/v1/repos/:repo/pulls/:id/update`                     | any                            | write (whole repo)                                                              | api_write    | Edit title/body/state or move the head                                                                                                                                        |
| POST   | `/api/v1/repos/:repo/pulls/:id/update-branch`              | any                            | write (whole repo)                                                              | api_write    | Bring the target into the pull request (merge or rebase)                                                                                                                      |
| GET    | `/api/v1/repos/:repo/refs`                                 | any                            | read                                                                            | api_read     | List refs                                                                                                                                                                     |
| GET    | `/api/v1/repos/:repo/refs/:name`                           | any                            | read                                                                            | api_read     | One ref                                                                                                                                                                       |
| PUT    | `/api/v1/repos/:repo/refs/:name`                           | any                            | write (whole repo) + agent identity for `refs/agents/<id>/`                     | api_write    | Compare-and-swap move a ref                                                                                                                                                   |
| GET    | `/api/v1/repos/:repo/releases`                             | any                            | read (whole repo)                                                               | api_read     | List releases, newest first (drafts only for writers; cursor paged)                                                                                                           |
| POST   | `/api/v1/repos/:repo/releases`                             | any                            | write (whole repo)                                                              | api_write    | Create a release from an existing tag (draft, prerelease, generated notes)                                                                                                    |
| GET    | `/api/v1/repos/:repo/releases/:id`                         | any                            | read (whole repo)                                                               | api_read     | One release with its assets and attestations                                                                                                                                  |
| PATCH  | `/api/v1/repos/:repo/releases/:id`                         | any                            | write (whole repo)                                                              | api_write    | Edit notes or flags; clearing `draft` publishes it                                                                                                                            |
| DELETE | `/api/v1/repos/:repo/releases/:id`                         | any                            | write (whole repo)                                                              | api_write    | Delete a release and its assets (the tag stays)                                                                                                                               |
| POST   | `/api/v1/repos/:repo/releases/:id/assets`                  | any                            | write (whole repo)                                                              | api_write    | Upload an asset (`?name=`, Content-Length, SHA-256 computed; org size cap)                                                                                                    |
| GET    | `/api/v1/repos/:repo/releases/:id/assets/:asset`           | any                            | read (whole repo)                                                               | api_read     | Download an asset, checked against its stored SHA-256 while streaming                                                                                                         |
| DELETE | `/api/v1/repos/:repo/releases/:id/assets/:asset`           | any                            | write (whole repo)                                                              | api_write    | Delete a release asset                                                                                                                                                        |
| GET    | `/api/v1/repos/:repo/releases/:id/attestations`            | any                            | read (whole repo)                                                               | api_read     | Build provenance attestations (DSSE envelopes) for a release                                                                                                                  |
| POST   | `/api/v1/repos/:repo/releases/:id/attestations`            | any                            | write (whole repo)                                                              | api_write    | Sign SLSA provenance for assets from a CI ID token (`audience=yag:attest`)                                                                                                    |
| POST   | `/api/v1/repos/:repo/releases/generate-notes`              | any                            | write (whole repo)                                                              | api_write    | Markdown notes from merged pull requests and commits since the previous release                                                                                               |
| GET    | `/api/v1/repos/:repo/releases/latest`                      | any                            | read (whole repo)                                                               | api_read     | The newest published release that is not a prerelease                                                                                                                         |
| GET    | `/api/v1/repos/:repo/releases/tags/:tag`                   | any                            | read (whole repo)                                                               | api_read     | The release for a tag                                                                                                                                                         |
| GET    | `/api/v1/repos/:repo/rulesets`                             | any                            | admin (whole repo)                                                              | api_read     | Repo rulesets plus the org rulesets that reach it                                                                                                                             |
| POST   | `/api/v1/repos/:repo/rulesets`                             | any                            | admin (whole repo)                                                              | api_write    | Create a branch, tag or push ruleset                                                                                                                                          |
| PUT    | `/api/v1/repos/:repo/rulesets/:id`                         | any                            | admin (whole repo)                                                              | api_write    | Replace a repo ruleset                                                                                                                                                        |
| DELETE | `/api/v1/repos/:repo/rulesets/:id`                         | any                            | admin (whole repo)                                                              | api_write    | Delete a repo ruleset                                                                                                                                                         |
| GET    | `/api/v1/repos/:repo/rulesets/evaluations`                 | any                            | admin (whole repo)                                                              | api_read     | Evaluate-mode log for this repo                                                                                                                                               |
| GET    | `/api/v1/repos/:repo/runners`                              | session                        | admin (whole repo)                                                              | api_read     | Repo self-hosted runners                                                                                                                                                      |
| PATCH  | `/api/v1/repos/:repo/runners/:id`                          | session                        | admin (whole repo)                                                              | api_write    | Disable, enable or mark a repo runner trusted-only                                                                                                                            |
| DELETE | `/api/v1/repos/:repo/runners/:id`                          | session                        | admin (whole repo)                                                              | api_write    | Revoke a repo runner and fail its running job                                                                                                                                 |
| POST   | `/api/v1/repos/:repo/runners/registration-token`           | session                        | admin (whole repo)                                                              | api_write    | One-time repo runner registration token (1 hour, recent MFA)                                                                                                                  |
| GET    | `/api/v1/repos/:repo/secret-scanning/alerts`               | any                            | admin (whole repo)                                                              | api_read     | Secret scanning alerts (location and detector; never the secret) and the last history scan                                                                                    |
| PATCH  | `/api/v1/repos/:repo/secret-scanning/alerts/:id`           | any                            | admin (whole repo)                                                              | api_write    | Resolve (revoked, false positive, test data, won't fix) or reopen an alert                                                                                                    |
| POST   | `/api/v1/repos/:repo/secret-scanning/scans`                | any                            | admin (whole repo)                                                              | api_write    | Queue a history scan for secrets (also started after an import)                                                                                                               |
| GET    | `/api/v1/repos/:repo/secrets`                              | any                            | admin (whole repo)                                                              | api_read     | Secret names (`?environment=`); values are write-only                                                                                                                         |
| PUT    | `/api/v1/repos/:repo/secrets/:name`                        | session                        | admin (whole repo)                                                              | api_write    | Set a secret `{value}` (`?environment=`)                                                                                                                                      |
| DELETE | `/api/v1/repos/:repo/secrets/:name`                        | session                        | admin (whole repo)                                                              | api_write    | Delete a secret (`?environment=`)                                                                                                                                             |
| POST   | `/api/v1/repos/:repo/sessions`                             | any                            | write (whole repo)                                                              | api_write    | Record an agent session and redacted transcript                                                                                                                               |
| GET    | `/api/v1/repos/:repo/sessions/:id`                         | any                            | read (whole repo)                                                               | api_read     | An agent session and its changesets                                                                                                                                           |
| POST   | `/api/v1/repos/:repo/sessions/:id/link`                    | any                            | write (whole repo)                                                              | api_write    | Link more changesets to your session                                                                                                                                          |
| GET    | `/api/v1/repos/:repo/sessions/:id/transcript`              | any                            | write (whole repo)                                                              | api_read     | Redacted session transcript                                                                                                                                                   |
| GET    | `/api/v1/repos/:repo/tags`                                 | any                            | read                                                                            | api_read     | List tags with annotations (keyset paged)                                                                                                                                     |
| POST   | `/api/v1/repos/:repo/tags`                                 | any                            | write (whole repo)                                                              | api_write    | Create a lightweight or annotated tag                                                                                                                                         |
| GET    | `/api/v1/repos/:repo/tree`                                 | any                            | read + path:read                                                                | api_read     | List a directory at a revision                                                                                                                                                |
| GET    | `/api/v1/repos/:repo/variables`                            | any                            | admin (whole repo)                                                              | api_read     | Variables with values (`?environment=`)                                                                                                                                       |
| PUT    | `/api/v1/repos/:repo/variables/:name`                      | session                        | admin (whole repo)                                                              | api_write    | Set a variable `{value}` (`?environment=`)                                                                                                                                    |
| DELETE | `/api/v1/repos/:repo/variables/:name`                      | session                        | admin (whole repo)                                                              | api_write    | Delete a variable (`?environment=`)                                                                                                                                           |
| GET    | `/api/v1/repos/:repo/work`                                 | any                            | read                                                                            | api_read     | Work queue items and dependencies (`?readiness=&risk=&claimed_by=`)                                                                                                           |
| GET    | `/api/v1/repos/:repo/work/:number`                         | any                            | read                                                                            | api_read     | One work item and its readiness history                                                                                                                                       |
| PUT    | `/api/v1/repos/:repo/work/:number`                         | any                            | triage                                                                          | api_write    | Set work fields; `ready` and risk need triage or `queue:approve`                                                                                                              |
| POST   | `/api/v1/repos/:repo/work/:number/heartbeat`               | any                            | write                                                                           | api_write    | Renew the lease you hold                                                                                                                                                      |
| POST   | `/api/v1/repos/:repo/work/:number/release`                 | any                            | write                                                                           | api_write    | End your claim: `ready` (counts an attempt), `in-review`, `blocked` or `done`                                                                                                 |
| POST   | `/api/v1/repos/:repo/work/claim`                           | any                            | write                                                                           | api_write    | Atomically claim the best ready item with a lease (agents need `queue:claim`)                                                                                                 |
| POST   | `/api/v1/repos/:repo/work/import-labels`                   | any                            | triage                                                                          | api_write    | Turn Factory `<prefix>:*` labels into work fields (approvers)                                                                                                                 |
| GET    | `/api/v1/scim/tokens`                                      | session                        | —                                                                               | api_read     | List SCIM tokens (SCIM admins)                                                                                                                                                |
| POST   | `/api/v1/scim/tokens`                                      | session                        | —                                                                               | api_write    | Create a SCIM token (raw value returned once)                                                                                                                                 |
| DELETE | `/api/v1/scim/tokens/:id`                                  | session                        | —                                                                               | api_write    | Revoke a SCIM token                                                                                                                                                           |
| GET    | `/api/v1/search/code`                                      | any                            | —                                                                               | api_read     | Search file contents across readable repos (text or regex; repo, path, lang, rev filters)                                                                                     |
| GET    | `/api/v1/search/paths`                                     | any                            | —                                                                               | api_read     | Find files by path across readable repos (fuzzy file finder)                                                                                                                  |
| GET    | `/api/v1/tokens`                                           | session                        | —                                                                               | api_read     | List your API tokens (metadata only)                                                                                                                                          |
| POST   | `/api/v1/tokens`                                           | session                        | —                                                                               | api_write    | Create an API token (raw value returned once)                                                                                                                                 |
| DELETE | `/api/v1/tokens/:id`                                       | session                        | —                                                                               | api_write    | Revoke one of your API tokens                                                                                                                                                 |
| GET    | `/api/v1/user`                                             | any                            | —                                                                               | api_read     | The person a session or user token belongs to (OAuth sign-in)                                                                                                                 |
| GET    | `/auth/github`                                             | none                           | —                                                                               | auth         | Start GitHub OAuth login (302 to GitHub)                                                                                                                                      |
| GET    | `/auth/github/callback`                                    | none                           | —                                                                               | auth         | OAuth callback: sets `yag_session`, 302 to `/`                                                                                                                                |
| GET    | `/auth/github/install-callback`                            | none                           | —                                                                               | auth         | GitHub App post-install landing: echoes `state`                                                                                                                               |
| POST   | `/auth/logout`                                             | none                           | —                                                                               | auth         | Revoke the session and clear the cookie                                                                                                                                       |
| POST   | `/auth/mfa/passkey`                                        | none                           | —                                                                               | auth         | Step up this session with a passkey                                                                                                                                           |
| POST   | `/auth/mfa/passkey/options`                                | none                           | —                                                                               | auth         | Passkey step-up challenge                                                                                                                                                     |
| POST   | `/auth/mfa/totp`                                           | none                           | —                                                                               | auth         | Step up this session with an authenticator code                                                                                                                               |
| GET    | `/auth/oidc/:provider`                                     | none                           | —                                                                               | auth         | Start OIDC sign-in (302 to the identity provider)                                                                                                                             |
| GET    | `/auth/oidc/:provider/callback`                            | none                           | —                                                                               | auth         | OIDC callback: sign in or link, then 302                                                                                                                                      |
| POST   | `/auth/passkey`                                            | none                           | —                                                                               | auth         | Sign in with a passkey (sets `yag_session`)                                                                                                                                   |
| POST   | `/auth/passkey/options`                                    | none                           | —                                                                               | auth         | Passkey sign-in challenge                                                                                                                                                     |
| GET    | `/auth/status`                                             | none                           | —                                                                               | auth         | Whether GitHub OAuth is configured                                                                                                                                            |
| GET    | `/ci/oidc/.well-known/openid-configuration`                | none                           | —                                                                               | api_read     | CI OIDC discovery document (public)                                                                                                                                           |
| GET    | `/ci/oidc/jwks`                                            | none                           | —                                                                               | api_read     | CI OIDC signing keys, current and previous (public)                                                                                                                           |
| GET    | `/ci/oidc/token`                                           | CI request token               | running job                                                                     | api_read     | ID token for a running job (`?audience=`), GitHub-style GET                                                                                                                   |
| POST   | `/ci/oidc/token`                                           | CI request token               | running job                                                                     | api_write    | ID token for a running job (`?audience=&lifetime=`)                                                                                                                           |
| GET    | `/healthz`                                                 | none                           | —                                                                               | api_read     | Liveness probe: `{ok: true}`                                                                                                                                                  |
| GET    | `/mcp`                                                     | token                          | per tool: the API route it calls                                                | agent_run    | MCP: resume an SSE stream after `Last-Event-ID`                                                                                                                               |
| POST   | `/mcp`                                                     | token                          | per tool: the API route it calls                                                | agent_run    | MCP Streamable HTTP: one JSON-RPC message (docs/mcp.md)                                                                                                                       |
| DELETE | `/mcp`                                                     | token                          | per tool: the API route it calls                                                | agent_run    | MCP: end the session                                                                                                                                                          |
| GET    | `/npm/-/package/:pkg/dist-tags`                            | token (Basic or Bearer)        | read on the linked repo (whole repo)                                            | object_fetch | npm dist-tags of a package                                                                                                                                                    |
| PUT    | `/npm/-/package/:pkg/dist-tags/:tag`                       | token (Basic or Bearer)        | write on the linked repo (whole repo); CI job: own repo                         | object_fetch | Point a dist-tag at a version                                                                                                                                                 |
| DELETE | `/npm/-/package/:pkg/dist-tags/:tag`                       | token (Basic or Bearer)        | write on the linked repo (whole repo); CI job: own repo                         | object_fetch | Remove a dist-tag (not `latest`)                                                                                                                                              |
| GET    | `/npm/-/whoami`                                            | token (Basic or Bearer)        | —                                                                               | object_fetch | npm whoami: the login of the token                                                                                                                                            |
| GET    | `/npm/:pkg`                                                | token (Basic or Bearer)        | read on the linked repo (whole repo)                                            | object_fetch | npm package document (`@scope%2fname`, as npm asks)                                                                                                                           |
| PUT    | `/npm/:pkg`                                                | token (Basic or Bearer)        | write on the linked repo (whole repo); CI job: own repo                         | object_fetch | npm publish: one version and its tarball                                                                                                                                      |
| GET    | `/npm/:scope/:name`                                        | token (Basic or Bearer)        | read on the linked repo (whole repo)                                            | object_fetch | npm package document                                                                                                                                                          |
| GET    | `/npm/:scope/:name/-/:file`                                | token (Basic or Bearer)        | read on the linked repo (whole repo)                                            | object_fetch | npm tarball                                                                                                                                                                   |
| GET    | `/oauth/authorize`                                         | session                        | —                                                                               | api_read     | Consent page: MCP clients pick agent, repos and scopes; OAuth apps get the dashboard                                                                                          |
| POST   | `/oauth/authorize`                                         | session                        | —                                                                               | api_write    | Approve or deny MCP consent; 302 back to the client                                                                                                                           |
| POST   | `/oauth/register`                                          | none                           | —                                                                               | api_write    | RFC 7591 dynamic registration of a public MCP client                                                                                                                          |
| POST   | `/oauth/token`                                             | none                           | —                                                                               | api_write    | Token endpoint: RFC 8693 exchange (`agent:run` API token to agent), app installation tokens (JWT bearer), OAuth app and MCP authorization codes (PKCE) and MCP refresh grants |
| GET    | `/runner/v1/jobs/:id/artifacts`                            | runner credential or job token | own running job                                                                 | api_read     | Artifacts of the job's run, from every job                                                                                                                                    |
| GET    | `/runner/v1/jobs/:id/artifacts/:name`                      | runner credential or job token | own running job                                                                 | api_read     | Download an artifact of the job's run                                                                                                                                         |
| PUT    | `/runner/v1/jobs/:id/artifacts/:name`                      | runner credential or job token | own running job                                                                 | api_write    | Upload a job artifact (100 MiB at most)                                                                                                                                       |
| GET    | `/runner/v1/jobs/:id/caches`                               | runner credential or job token | own running job                                                                 | api_read     | Restore a cache: exact key, then restore-key prefixes, own scope then default branch (204 on a miss)                                                                          |
| POST   | `/runner/v1/jobs/:id/caches`                               | runner credential or job token | own running job                                                                 | api_write    | Reserve a cache key in the job's own scope                                                                                                                                    |
| PUT    | `/runner/v1/jobs/:id/caches/:cache`                        | runner credential or job token | own running job                                                                 | api_write    | Upload a reserved cache entry once (500 MiB at most)                                                                                                                          |
| POST   | `/runner/v1/jobs/:id/complete`                             | runner credential              | own jobs                                                                        | api_write    | Report the job result and release the runner                                                                                                                                  |
| POST   | `/runner/v1/jobs/:id/heartbeat`                            | runner credential              | own jobs                                                                        | api_write    | Extend the job lease; says whether it was cancelled                                                                                                                           |
| POST   | `/runner/v1/jobs/:id/logs`                                 | runner credential              | own jobs                                                                        | api_write    | Append a masked log chunk to a step (`?step=`)                                                                                                                                |
| POST   | `/runner/v1/jobs/:id/steps/:step`                          | runner credential              | own jobs                                                                        | api_write    | Report a step state and exit code                                                                                                                                             |
| POST   | `/runner/v1/jobs/claim`                                    | runner credential              | own jobs                                                                        | api_write    | Long-poll for a job matching the runner labels (`?wait=`)                                                                                                                     |
| POST   | `/runner/v1/register`                                      | registration token             | —                                                                               | api_write    | Register a self-hosted runner with a one-time token (credential returned once)                                                                                                |
| GET    | `/scim/v2/Groups`                                          | SCIM token                     | —                                                                               | api_read     | SCIM: list groups (`displayName eq` filter)                                                                                                                                   |
| POST   | `/scim/v2/Groups`                                          | SCIM token                     | —                                                                               | api_write    | SCIM: create a group as a team in the token's org                                                                                                                             |
| GET    | `/scim/v2/Groups/:id`                                      | SCIM token                     | —                                                                               | api_read     | SCIM: one group and its members                                                                                                                                               |
| PATCH  | `/scim/v2/Groups/:id`                                      | SCIM token                     | —                                                                               | api_write    | SCIM: change group members or name                                                                                                                                            |
| DELETE | `/scim/v2/Groups/:id`                                      | SCIM token                     | —                                                                               | api_write    | SCIM: delete a group and its team                                                                                                                                             |
| GET    | `/scim/v2/Users`                                           | SCIM token                     | —                                                                               | api_read     | SCIM: list users (`userName eq` filter)                                                                                                                                       |
| POST   | `/scim/v2/Users`                                           | SCIM token                     | —                                                                               | api_write    | SCIM: provision a user                                                                                                                                                        |
| GET    | `/scim/v2/Users/:id`                                       | SCIM token                     | —                                                                               | api_read     | SCIM: one user                                                                                                                                                                |
| PATCH  | `/scim/v2/Users/:id`                                       | SCIM token                     | —                                                                               | api_write    | SCIM: activate or deactivate a user                                                                                                                                           |
| DELETE | `/scim/v2/Users/:id`                                       | SCIM token                     | —                                                                               | api_write    | SCIM: deprovision a user                                                                                                                                                      |
| GET    | `/v2/`                                                     | token (Basic or Bearer)        | —                                                                               | object_fetch | OCI registry ping; 401 with the Bearer token challenge when signed out                                                                                                        |
| GET    | `/v2/:name/blobs/:digest`                                  | token (Basic or Bearer)        | read on the linked repo (whole repo)                                            | object_fetch | Fetch (or HEAD) a blob linked to the image                                                                                                                                    |
| POST   | `/v2/:name/blobs/uploads/`                                 | token (Basic or Bearer)        | write on the linked repo (whole repo); CI job: own repo                         | object_fetch | Start a blob upload; monolithic with `digest`, cross-repo with `mount`                                                                                                        |
| GET    | `/v2/:name/blobs/uploads/:uuid`                            | token (Basic or Bearer)        | write on the linked repo (whole repo); CI job: own repo                         | object_fetch | Upload progress (Range)                                                                                                                                                       |
| PUT    | `/v2/:name/blobs/uploads/:uuid`                            | token (Basic or Bearer)        | write on the linked repo (whole repo); CI job: own repo                         | object_fetch | Finish an upload; the digest is checked as R2 stores it                                                                                                                       |
| PATCH  | `/v2/:name/blobs/uploads/:uuid`                            | token (Basic or Bearer)        | write on the linked repo (whole repo); CI job: own repo                         | object_fetch | Append a chunk, streamed to R2                                                                                                                                                |
| DELETE | `/v2/:name/blobs/uploads/:uuid`                            | token (Basic or Bearer)        | write on the linked repo (whole repo); CI job: own repo                         | object_fetch | Cancel an upload                                                                                                                                                              |
| GET    | `/v2/:name/manifests/:reference`                           | token (Basic or Bearer)        | read on the linked repo (whole repo)                                            | object_fetch | Fetch (or HEAD) a manifest by tag or digest                                                                                                                                   |
| PUT    | `/v2/:name/manifests/:reference`                           | token (Basic or Bearer)        | write on the linked repo (whole repo); CI job: own repo                         | object_fetch | Push a manifest or index, tagged or by digest                                                                                                                                 |
| DELETE | `/v2/:name/manifests/:reference`                           | token (Basic or Bearer)        | admin on the linked repo (whole repo)                                           | object_fetch | Delete a tag, or a manifest by digest                                                                                                                                         |
| GET    | `/v2/:name/referrers/:digest`                              | token (Basic or Bearer)        | read on the linked repo (whole repo)                                            | object_fetch | Referrers API: manifests whose subject is the digest                                                                                                                          |
| GET    | `/v2/:name/tags/list`                                      | token (Basic or Bearer)        | read on the linked repo (whole repo)                                            | object_fetch | List tags (`n`, `last` pagination)                                                                                                                                            |
| GET    | `/v2/token`                                                | token (Basic or Bearer)        | —                                                                               | object_fetch | Exchange a forge credential (HTTP Basic) for a short-lived registry token                                                                                                     |
| POST   | `/v2/token`                                                | token (Basic or Bearer)        | —                                                                               | object_fetch | OAuth2 password grant for a registry token (oras-go, helm)                                                                                                                    |
| POST   | `/webhooks/github`                                         | HMAC                           | —                                                                               | exempt       | GitHub App webhook receiver                                                                                                                                                   |

<!-- generated:routes:end -->

## Endpoints by area

Request and response essentials, taken from the zod schemas and handlers in
`worker/src`. Each `?` marks an optional field.

### Repos

- `POST /api/v1/repos` (session) takes
  `{slug: "owner/name", visibility?: "private"|"public", default_branch?: string}`.
  `slug` is 3–128 chars matching `^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$`, `visibility`
  defaults to `private`, and `default_branch` (1–64 chars) defaults to `main`. Returns
  `201 {repo}`, or `409 repo_exists`. The creator is admin.
- `GET /api/v1/repos?limit=&cursor=` lists repos that are public, where the caller is a
  member, or that the caller created. Ordered `created_at DESC, id DESC`. `limit` is
  1–100 (default 50). Returns `{repos, next_cursor}`, where `cursor` is
  `<created_at>:<id>`. A repo-bound token sees only its repo.
- `GET /api/v1/repos/:owner/:name` returns `{repo, can_admin}`. A `repo` is `{id, slug,
visibility, default_branch, created_at, created_by, github_installation_id,
github_repo_id}`.
- `POST /api/v1/repos/:owner/:name/initialize` (admin, plus `write` on `README.md`)
  commits `README.md` (`# owner/name`) as the root changeset and points the default
  branch at it. Returns `201 {changeset}`, or `409 repo_initialized` if any ref already
  exists.

### API tokens

- `POST /api/v1/tokens` (session) takes `{label: string(1–120), scopes?: Scope[],
repo_id?: string|null, expires_at?: int|null}`. `scopes` defaults to all three.
  Returns `201 {id, label, scopes, repo_id, created_at, last_used_at, expires_at,
token}`. `token` is shown only here.
- `GET /api/v1/tokens` (session) returns `{tokens: [metadata…]}` and never includes raw
  values.
- `DELETE /api/v1/tokens/:id` (session) returns `{ok: true}`, or `404 token_not_found`
  for tokens you don't own.

### Read RPCs (no checkout needed)

- `GET …/file?cs=&path=[&format=raw]` returns
  `{path, size, blob_sha256, cs, content_b64}` by default. Files over 8 MiB return `413
file_too_large`; use `format=raw` for those. `format=raw` streams the bytes with a
  guessed `content-type`, `x-content-type-options: nosniff`, and
  `content-disposition: attachment` for types a browser would execute (HTML, SVG, XML,
  JS). The stream is hash-verified and aborts on a mismatch.
- `GET …/tree?cs=[&path=][&recursive=1]` returns `{path, entries}`. Entries are
  `{name, kind: "tree"|"blob", hash, size?, mode?}`. Recursive entries are
  `{path, kind, hash, size?}`, capped at 5000 walked entries (`409 tree_too_large`). A
  non-directory path is `400 not_a_tree`. Entries the caller may not read are left out
  and counted in `omitted_paths_count`.
- `GET …/history?cs=ref:main&limit=50[&path=][&background=1]` returns `{changesets}`
  (first-parent). With `path`, it returns
  `{path, changesets, next, complete}` and checks `history` on the path. When the
  derived index is cold and `background=1`, it returns
  `202 {status: "computing", path, cs}`. `limit` is at most 500.
- `GET …/changed-paths?cs=` returns `{cs, changed_files, omitted_paths_count?}`.

A **changeset** is `{id, repo_id, first_parent, parents, author, message, created_at,
changed_files, root_tree}`. `author` is either `{name, email}` or `{agent}`. When path
rules hide some of its `changed_files` from the caller, the changeset also carries
`omitted_paths_count`.

### Ancestry, diff, blame

- `GET …/merge-base?a=&b=` returns `{merge_base, provisional: false}`.
- `GET …/is-ancestor?a=&b=` returns `{is_ancestor}`.
- `GET …/ancestor-distance?a=&b=` returns `{distance}`. Ancestry follows the
  first-parent spine.
- `GET …/diff?from=&to=[&mode=merge-base|direct][&text=1][&max_files=2000]` returns
  `{from, to, merge_base, files, truncated, texts?}`. `files` are
  `{path, kind: "add"|"del"|"mod", old_hash?, new_hash?, old_size?, new_size?,
size_delta?, side?}`. The default `merge-base` (three-dot) mode tags each file with
  `side: "from"|"to"`. `text=1` adds unified `texts: [{path, unified, side?}]`. If those
  exceed 4 MiB they are dropped, with `texts_truncated: true` and `texts_hint`.
  `max_files` is at most 5000. Files the caller may not read are left out of `files`
  and `texts` and counted in `omitted_paths_count`.
- `GET …/blame?cs=&path=[&background=1][&annotate=1]` returns
  `{path, cs, ranges: [{start, end, cs}], complete}`. `annotate=1` adds `message` and
  `author` per range. A cold index with `background=1`, or one over the inline budget,
  returns `202 {status: "computing", path, cs, ranges, complete: false}`. A response
  computed without caching carries `x-yag-blame: uncached`.

### Changesets and refs (commit flow)

`POST …/changesets` (write) creates a changeset. **It never moves a ref.** Request body:

```jsonc
{
  "first_parent": "ref:main", // changeset id, ref:<name>, or null for a root changeset
  "parents": ["<cs id>"], // optional extra merge parents
  "message": "fix: …", // 1–65536 chars
  "author": { "name": "Ada", "email": "ada@example.com" }, // or { "agent": "…" }
  "changes": [
    { "path": "src/a.ts", "op": "add", "content_b64": "…" }, // inline, ≤ 4 MiB each
    { "path": "big.bin", "op": "mod", "blob_sha256": "<64 hex>" }, // pre-uploaded via PUT …/blob
    { "path": "old.txt", "op": "del" },
  ], // max 5000 entries
  "created_at": 1760000000000, // optional override
}
```

It returns `201 {changeset, deduped: false}`, or `200 {changeset, deduped: true}` when
an identical changeset already exists. Changesets are content-addressed. `add` requires
the path to be absent and `mod`/`del` require it to be present. Validation failures are
`400 invalid_request` with `issues`. Every changed path needs `write`: a path rule
denying it fails the commit with `403 forbidden`, `path` and `denied_by`.

- `PUT …/blob?sha256=<hex>[&encoding=identity|<codec>]` (write) takes raw bytes, at most
  64 MiB. The hash covers the **uncompressed** content and is verified (`400
hash_mismatch`). Returns `201 {sha256, size, deduped}`.
- `GET …/changesets?head=|cursor=&limit=50` (≤ 200) returns `{changesets, next_cursor}`.
  `GET …/changesets/:id` returns `{changeset}`.
- `GET …/refs` returns `{refs: [{name, head, updated_at}]}`. `GET …/refs/:name` returns
  `{name, head, updated_at}`. Ref names may contain `/`.
- `PUT …/refs/:name` (write, whole repo) takes `{from: string|null, to: string, force?: boolean}`.
  This is a compare-and-swap through the per-ref Durable Object. It returns
  `{ok: true, from, to}`. Use `from: null` to create a ref. The error cases:

  | Code                       | Meaning                                                                   |
  | -------------------------- | ------------------------------------------------------------------------- |
  | `409 ref_stale`            | `{expected, actual}`: someone moved the ref first                         |
  | `409 ref_not_fast_forward` | `to` is not a fast-forward of the current head                            |
  | `403 protected_branch`     | the default branch is protected by CI policy; open a pull request instead |
  | `400 unknown_target`       | `to` is not a changeset                                                   |

### Sparse checkout objects

The checkout protocol is want-only. Clients never send what they already have. Every
route here needs whole-repository read (`403 whole_repository_required` otherwise).
Callers restricted by a path rule use `file` and `tree` instead.

- `GET …/checkout-info?cs=` returns `{cs, root_tree, size_estimate: {blobs, bytes}}`.
- `GET …/object/tree/:hash` returns `{hash, entries}`.
- `GET …/object/blob/:hash[?encoding=zstd|identity]` returns raw bytes. The default
  `zstd` returns the stored bytes as they are, with `x-yag-encoding: <codec>`.
  `identity` decompresses and verifies the hash server-side.
- `POST …/fetch-objects` takes
  `{trees?: hash[], blobs?: hash[], blob_encoding?: "zstd"|"identity"}` and returns
  `{trees: [{hash, payload_b64}], blobs: [{hash, size, encoding, data_b64}], missing}`.
  Limits are 200 objects and 32 MiB per call (`413 fetch_too_large`).

### Import and export

- `POST …/import` (write) takes `{source: "github:owner/name",
mode?: "snapshot"|"full_history", ref?}` and returns `202 {job_id, status: "queued"}`.
- `GET …/import/:job_id` returns
  `{job_id, status, mode, commits_total, commits_done, checkpoint, error}`.
  Exports carry every path, so all three need whole-repository access (read for tarball
  and fast-import, write for GitHub).

- `GET …/export/tarball?cs=` streams `application/gzip`, named
  `<owner>-<name>-<cs8>.tar.gz`. The cap is 100k objects or 512 MiB
  (`413 export_too_large`).
- `GET …/export/fast-import?head=[&mode=snapshot|full|ranged][&from=]` streams
  `application/x-git-fast-import-stream`. Over 10k commits returns `413
export_too_large`.
- `POST …/export/github` (write, whole repo) takes `{target_branch?: string = "yag-sync", head?}`
  and returns `202 {job_id, status: "queued"}`.

### Pull requests

Pull requests always target the repo's default branch. All pull and CI responses are
`private, no-store`.

- `GET …/pulls?before=<id>` returns `{pulls, next_cursor}`, 50 per page, newest first.
- `POST …/pulls` takes `{title: 1–200, body?: ≤20000 = "", head_cs: <64 hex>,
draft?: false}`. It returns `201 {pull, ci: {status, message?}}`. If the default
  branch is missing or already at `head_cs` it returns `409 no_changes`.
- `GET …/pulls/:id` returns `{pull, reviews, gate: {mergeable, reasons}}`. A `pull` is
  `{id, repo_id, title, body, author_id, base_ref, base_cs, head_cs, state, revision,
created_at, updated_at, merged_at}`.
- `POST …/pulls/:id/update` takes `{title?, body?, state?: "draft"|"open"|"closed",
head_cs?}` and returns `{pull, ci}`. Moving `head_cs` bumps `revision` and rebases
  `base_cs` onto the current branch head.
- `POST …/pulls/:id/review` takes `{head_cs, revision, decision:
"comment"|"approve"|"request_changes", body: ≤20000}` and returns `{ok: true}`.
  `head_cs` and `revision` must match the current pull (`409 pull_stale`). Authors may
  only `comment` on their own pulls (`403 self_review`).
- `POST …/pulls/:id/merge` takes `{head_cs, revision}` and returns `{pull}`. It fails
  with `409 merge_blocked` (gate reasons in `message`) or `409 pull_stale`.

### CI

- `GET …/ci` returns `{config, version, runs (latest 30), enabled, can_admin, can_write,
monthly_budget_usd, reserved_usd, max_run_usd, registry}`.
- `GET …/ci/detect` (admin) returns `{empty, preset, commands, dockerfile, head_cs}`.
- `PUT …/ci` (admin) takes a policy and returns `{config, max_run_usd}`. Invalid input
  is `400 invalid_ci_config`. The policy shape:

  ```jsonc
  {
    "preset": "node", // node | docker | custom
    "commands": ["npm ci", "npm test"], // 1–8 commands, each ≤ 2000 chars
    "timeout_seconds": 300, // 30–600
    "required_approvals": 1, // 0–5
    "require_checks": true,
    "protect_default": true, // blocks direct ref moves of the default branch
    "dockerfile": "Dockerfile", // relative path
    "image": null, // registry/repo[:port] path, or null
  }
  ```

- `POST …/ci/runs` takes `{head?: rev = "ref:<default>", publish?: false}` and returns
  `202 {run}`. `publish: true` requires admin.
- `GET …/ci/runs/:id/log` returns `text/plain`.
- `POST …/ci/runs/:id/cancel` returns `{ok: true}`, or `503 ci_cancel_failed`.

### Agents

- `POST …/agents/tasks` (write + `agent:run`) takes
  `{kind: "freeform"|"fix_issue"|"post_merge_check"|"superfan", prompt: 1–65536,
base_cs?: rev = "ref:main", github_issue?: positive int}` and returns
  `202 {task_id, status: "queued"}`. `github_issue` is only accepted with
  `kind: "fix_issue"` (otherwise `400 invalid_request`). For a repo connected to GitHub,
  the issue's title and body become the task prompt. On success the work is exported to
  `yag-sync` and the changeset id is commented on the issue.
- `GET …/agents/tasks?status=&limit=50` (≤ 200) returns `{tasks}`.
- `GET /api/v1/agents/tasks/:id` returns `{task, state}`. Visibility follows read access
  to the task's repo. `state.budget` and `state.turn` hold the persisted budget counters,
  so a resumed task keeps spending from the same budget and deadline.
- `GET /api/v1/agents/tasks/:id/transcript?since=<ms>` returns `{entries}`, the JSONL
  transcript entries with `t >= since`.
- `POST /api/v1/agents/tasks/:id/cancel` (write) returns `{ok: true, status}`. Only a
  `queued` or `running` task becomes `cancelled`, including one that has not started
  yet. The loop stops before its next turn or tool call. For a task that has already
  ended, `status` is its unchanged terminal status.
- **Task statuses.** `landed` means the agent called `finish`. `failed` means it called
  `report_failure`, ran out of budget (tool calls, commits, LLM turns or the deadline,
  with `state.error` such as `"budget exhausted (tool)"`), hit the deadline alarm
  (`"timeout"`), or failed twice on infrastructure. `landed`, `cancelled` and a timeout
  are final: later loop results and queue redeliveries never overwrite them.
- **Spawned tasks** (`create_task`, the post-merge check queued by `land`, superfan
  investigations) record the real user as `created_by` and run as that user, so they
  work on private repos the user can access.
- **Post-merge checks.** A successful `land` queues a `post_merge_check` with
  `base_cs` = the pre-land head. The checked head is the landed changeset. The prompt
  lists the changed files, and the budget is 20 tool calls. If the check calls
  `report_failure`, a `freeform` fix task is queued for the same repo and user, with the
  findings in its prompt. That task's prompt starts with `[post-merge-fix]`. A failed
  check on a fix task's own land does not spawn another fix, so fixes stop after one
  level.
- `POST …/agents/superfans` (admin + `agent:run`) takes
  `{component: "commit-path"|"import-pipeline"|"queues"|"refs"|"agents"|"ai",
interval_min: 1–1440}` and returns 201 with the monitor's state. There is one
  monitor per repo and component, and re-registering replaces its interval. When a
  check finds an anomaly, the finding is recorded and a `freeform` investigation task is
  queued in this repo, based on the default branch head and running as the admin who
  registered the monitor.
- `GET …/agents/superfans?limit=50` (admin, ≤ 200) returns
  `{superfans: [{component, interval_min, repo_id, created_by, last_check?}],
findings: [{id, component, ts, finding, task_id}]}`. Findings are the newest first,
  limited to those whose investigation task is in this repo.
- `DELETE …/agents/superfans/:component` (admin) stops the monitor and clears its alarm.
  It returns `{ok: true, component, stopped}`, where `stopped` is `false` if none was
  running.

### Administration

- `GET …/members` returns `{members: [{user_id, role}]}`.
- `PUT …/members` takes `{user_id? | user_login?, role: "admin"|"write"|"read"}`
  (upsert) and returns `{ok, user_id, role}`. An unknown login is `404 user_not_found`.
- `DELETE …/members/:userId` returns `{ok: true}`.
- `GET …/path-rules` returns `{path_rules}`.
- `POST …/path-rules` takes `{path_prefix: 1–512, effect: "grant"|"deny", principal,
perms: ("read"|"write"|"history")[]}` and returns `201 {ok, id, rule}`. `principal` is
  `*`, `role:admin|write|read`, `user:<id>` or `agent:<token id>`. Prefixes are
  normalized to end in `/` and must not contain `..`.
- `DELETE …/path-rules/:id` returns `{ok: true}`.
- `GET /api/v1/admin/metrics?component=&window=<ms, default 3600000>` returns `{rows}`.
  It needs admin on at least one repo.

### GitHub App

- `GET /api/v1/github/install-url` (session) responds 302 to
  `https://github.com/apps/<GITHUB_APP_SLUG>/installations/new`.
- `GET /auth/github/install-callback?state=` returns `{ok: true, state}`. The
  installation itself arrives by webhook.
- `POST …/connect` (session + admin) takes `{installation_id: int, github_repo_id: int}`.
  The installation must exist (`400 unknown_installation`), the repo must be reachable
  (`400 unknown_github_repo`), and the installation must hold admin on it
  (`403 not_admin`). Returns `{ok: true, repo}`.

## MCP endpoint

`POST /api/v1/repos/:repo/agents/mcp` exposes the built-in agent tool registry to
external agents as a JSON-RPC 2.0 subset. It applies the same RBAC as the internal
runtime.

- **Auth:** a bearer token with `agent:run`. Session cookies are refused. Without a
  usable token the response is HTTP `403 forbidden` in the normal error envelope,
  `{required_scope: "agent:run"}`, not a JSON-RPC error.
- **Rate bucket:** `agent_run` (20/min).
- **Request:** `{jsonrpc?: "2.0", method: "initialize"|"tools/list"|"tools/call",
params?, id?: string|number|null}`.

| Method       | Result                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `initialize` | `{protocolVersion: "2025-03-26", capabilities: {tools: {}}, serverInfo: {name: "yuma-agent-git", version: "0.1.0"}}`      |
| `tools/list` | `{tools: [{name, description, inputSchema}]}`, where `inputSchema` is JSON Schema                                         |
| `tools/call` | params `{name, arguments?, base_cs?, head_cs?}`, result `{content: [{type: "text", text: "<JSON tool result>"}], budget}` |

`tools/call` requires repo `read` for the read-only tools (`read_file`, `list_dir`,
`file_history`, `blame`, `diff`, `grep`, `finish`, `report_failure`) and repo `write`
for `commit`, `land` and `create_task`. A `repo:read` token with `agent:run` can
therefore inspect a repo but not change it. When `head_cs` is omitted it defaults to the
head of the repository's default branch, and `base_cs` defaults to `head_cs`. Revision
arguments (`cs` on `read_file`, `list_dir`, `grep` and `blame`, and `from`/`to` on
`diff`) take a changeset id, `ref:<name>`, or a bare ref name, as the HTTP read routes
do. Tool-level permission failures come back inside the tool result. Path rules apply
per file. `diff` needs repo read and drops files the caller cannot read from both
`files` and `texts`, just as `grep` skips them. `commit` needs `write` on every path it
touches, as `POST …/changesets` does. Otherwise it returns
`{error: "forbidden", perm: "write", path, denied_by?}` and commits nothing. `land`
needs write on the whole repo, as ref moves do: if any path rule restricts the caller,
it returns `{landed: false, reason: "whole_repository_required", final: true, denied_by?}`.
`land` moves the default branch: a lost race returns
`{landed: false, reason: "stale", main_head}` (merge `main_head` in and land again); any
other refusal, such as a protected default branch, returns
`{landed: false, reason: "<code>", final: true}` and must not be retried.

JSON-RPC errors are returned with HTTP **200**:

| Code     | Meaning                                                          |
| -------- | ---------------------------------------------------------------- |
| `-32600` | Body does not match the request schema                           |
| `-32601` | `forbidden`: the caller lacks the repo permission the tool needs |
| `-32602` | `unknown repo`, or invalid `tools/call` params                   |
| `-32603` | `empty repository` (no head to operate on)                       |

## Webhook contract

`POST /webhooks/github` receives GitHub App events. It needs no session or token and is
exempt from rate limiting. The HMAC signature is the only gate.

1. The raw body bytes are read once.
2. `X-Hub-Signature-256: sha256=<hex>` is verified as HMAC-SHA256 over the raw body,
   keyed with `GITHUB_WEBHOOK_SECRET`, using WebCrypto, **before** any parsing. On failure
   the event is logged and nothing fires: `401 invalid_signature`.
3. **Dedupe** uses `X-GitHub-Delivery`. A delivery id already seen returns
   `200 {ok: true, deduped: true}`.
4. Only then is the body parsed (`400 invalid_json` if it is not JSON).
5. Events are routed by `X-GitHub-Event`:

   | Event                                       | Handling                                                                                                                                                        |
   | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `ping`                                      | Returns `{ok: true, pong: true}`                                                                                                                                |
   | `installation`, `installation_repositories` | Records the installation and returns `{ok: true}`                                                                                                               |
   | `push`                                      | For a repo connected via `…/connect`, enqueues a `github_push` import job and returns `{ok: true, queued: true}`. Otherwise returns `{ok: true, ignored: true}` |
   | anything else                               | Returns `{ok: true, ignored: "<event>"}`                                                                                                                        |

Responses are fast. Heavy work goes through queues.

## `yag` CLI reference

`yag` (`cli/`) is a thin client for sparse checkouts. It fetches only the objects it
wants, verifies every content address, and keeps an LRU object cache. It calls
`<api>/api/v1/repos/<repo>/…`.

**Configuration**

| Source                       | Purpose                                                         |
| ---------------------------- | --------------------------------------------------------------- |
| `.yag/config.json`           | `{api, repo, token?}`, written by `init` / `clone`              |
| `.yag/state.json`            | Checked-out `cs`, `root_tree`, file entries and sparse prefixes |
| `YAG_TOKEN`                  | Bearer token; overrides `config.token`                          |
| `YAG_CACHE_DIR`              | Object cache (default `~/.yag/objects`)                         |
| `YAG_AUTHOR_NAME` / `_EMAIL` | Commit author (default `yag` / `yag@localhost`)                 |

Because the whole API requires sign-in, every command except `init` and `status` needs a
token. Create one under dashboard **Settings** (`POST /api/v1/tokens`) and pass it via
`--token` on `init` or `clone`, or the `YAG_TOKEN` environment variable. A 401 without a
token prints that hint.

| Command                                                                   | What it does                                                                                                                                                                                                            |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `yag init <dir> --repo <owner/name> --api <url> [--token <t>]`            | Writes `<dir>/.yag/config.json`                                                                                                                                                                                         |
| `yag clone <owner/name> <dir> --api <url> [--rev ref:main] [--token <t>]` | Creates an empty `<dir>`, writes config, does a full checkout                                                                                                                                                           |
| `yag checkout <rev> [--path <prefix...>]`                                 | Sparse checkout via `checkout-info` → `fetch-objects` (batches of 100) → verified writes. `--path` limits it to the given prefixes                                                                                      |
| `yag status`                                                              | Local only: lists `modified`, `deleted` and `untracked` against `.yag/state.json`                                                                                                                                       |
| `yag commit -m <msg> [--ref <name>]`                                      | `POST …/changesets` on top of the checked-out cs. Files over 4 MiB are first sent with `PUT …/blob`. With `--ref` it then CAS-moves the ref (`PUT …/refs/<name>`). A stale ref keeps the commit locally and exits **3** |
| `yag diff [rev=ref:main]`                                                 | `GET …/diff?from=<checked-out cs>&to=<rev>&text=1`, printing unified texts and an `A`/`D`/`M` file list                                                                                                                 |
| `yag log [--path <p>] [--limit 20]`                                       | `GET …/history` from the checked-out cs                                                                                                                                                                                 |
| `yag pr -t <title> [--body <b>] [--draft]`                                | `POST …/pulls` with the checked-out cs as `head_cs`. Prints the dashboard URL `<api>/r/<repo>/pulls/<id>`                                                                                                               |
| `yag ci run [--publish]`                                                  | `POST …/ci/runs` for the checked-out cs. Prints `<run id> <state>`                                                                                                                                                      |
| `yag ci status`                                                           | `GET …/ci`. Prints whether CI is enabled and the recent runs                                                                                                                                                            |

Errors print `yag: <message>` (the server's `error.message`) and exit 1.
