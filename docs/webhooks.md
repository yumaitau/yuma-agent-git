# Webhooks, apps and OAuth apps

Issue #75. How integrations receive forge events and call the API.

## Webhooks

A webhook belongs to a repository (`POST /api/v1/repos/{owner}/{repo}/hooks`,
repo admins), an org (`POST /api/v1/orgs/{org}/hooks`, org owners, every org
repository) or an app (sent for every repository the app is installed on).
Managing hooks needs a browser session and, once a second factor is enrolled,
a recent MFA step-up. API, agent and app tokens cannot read or change them.

```json
{
  "url": "https://ci.example.com/hooks/yag",
  "events": ["push", "pull_request"],
  "format": "github",
  "secret": "at least 16 characters"
}
```

Omit `secret` to have one generated; it is returned once. Secrets are
encrypted with the CI secrets keys (#50, `SECRETS_KEK`) and never returned.

### Events

| Event                        | Actions                                                                                                                   | Sent when                                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `push`                       | none                                                                                                                      | a branch or tag moves: `git push`, the refs API, merges                                                                           |
| `ref`                        | `created`, `deleted`                                                                                                      | a branch, tag or agent ref is created or deleted                                                                                  |
| `pull_request`               | `opened`, `edited`, `synchronize`, `closed`, `reopened`, `ready_for_review`, `converted_to_draft`, `enqueued`, `dequeued` | pull request changes; a merge is `closed`                                                                                         |
| `pull_request_review`        | `submitted`                                                                                                               | a review is submitted                                                                                                             |
| `pull_request_review_thread` | `created`, `replied`, `resolved`, `unresolved`                                                                            | a line review thread (#39) is started, answered or resolved                                                                       |
| `issues`                     | `opened`, `edited`, `closed`, `reopened`, `deleted`                                                                       | issue changes                                                                                                                     |
| `ci_run`                     | `requested`, `in_progress`, `completed`                                                                                   | a CI run is queued, a self-hosted runner takes it (#48), or it finishes                                                           |
| `work_item`                  | `claimed`, `released`                                                                                                     | a work queue item (#59) is claimed or released                                                                                    |
| `package`                    | `published`, `tagged`, `deleted`                                                                                          | an image manifest or npm version is pushed, a dist-tag moves, or a tag or manifest is deleted (docs/registry.md)                  |
| `release`                    | `created`, `published`, `edited`, `deleted`                                                                               | a release (#54) is created, published (draft cleared), edited or deleted                                                          |
| `secret_scanning_alert`      | `created`                                                                                                                 | secret scanning (#66) raises an alert: a push past protection, a history scan, an import or a pull mirror                         |
| `dependency_alert`           | `created`, `fixed`, `reopened`, `dismissed`                                                                               | a dependency alert (#67) opens, its package is fixed on the default branch, it matches again, or a person dismisses or reopens it |
| `code_scanning_alert`        | `created`, `fixed`, `reopened`, `dismissed`                                                                               | a SARIF upload (#67) finds a new result, no longer finds it, finds it again, or a person dismisses or reopens it                  |
| `merge_group`                | `checks_requested`, `destroyed`                                                                                           | the merge queue (#43) builds a group to test, then lands, fails, reverts or drops it                                              |

A push payload lists at most 20 commits (`size` has the full count). Pushes
through the refs API and merges list only the new head.

### Formats

- `yag` (default): the forge's own shape, with changeset ids next to Git SHAs.
- `github`: GitHub's documented payloads for `push`, `pull_request`,
  `pull_request_review`, `issues` and `create`/`delete` (from `ref`), with
  `X-GitHub-Event`, `X-GitHub-Delivery` and `X-Hub-Signature-256`, so existing
  GitHub webhook consumers can read them. GitHub's numeric ids are derived
  from forge ids and are stable per object. `ci_run`, `pull_request_review_thread`,
  `work_item`, `secret_scanning_alert`, `dependency_alert`, `code_scanning_alert`,
  `merge_group`, `release` and `package` have no GitHub shape.

### Verifying a delivery

Every delivery is a `POST` with `content-type: application/json` and:

- `X-Yag-Event`, `X-Yag-Delivery` (unique per delivery), `X-Yag-Hook-Id`
- `X-Yag-Signature-256: sha256=<hex HMAC-SHA256 of the raw body with the secret>`

Compute the HMAC over the raw bytes before parsing and compare in constant
time. Use `X-Yag-Delivery` to drop duplicates: delivery is at least once.

### Retries and the delivery log

A delivery succeeds on any 2xx answer within 10 seconds. Anything else is
retried after 30 seconds, doubling up to 4 hours apart, for 24 hours; then it
is `failed`. Redirects are not followed. `GET /api/v1/hooks/{id}/deliveries`
lists the last 50 deliveries (status, attempts, response code, error) and
`POST /api/v1/hooks/{id}/deliveries/{delivery}/redeliver` sends the same body
again as a new delivery. The dashboard shows both under a repository's
**Webhooks** page. Deliveries are kept for 30 days.

### SSRF protection

URLs must use https (`WEBHOOKS_ALLOW_HTTP=true` allows http for local
testing). URLs with credentials, single-label or local names (`localhost`,
`*.local`, `*.internal`, `*.home.arpa`) and private, loopback, link-local
(including `169.254.169.254`), CGNAT, multicast, documentation and IPv6
unique-local addresses are refused when the hook is saved. Before each
attempt the host is resolved over DNS-over-HTTPS (`cloudflare-dns.com`) and
the delivery fails without retry if any address is blocked.

## Apps

An app is created by a user or for an org (`POST /api/v1/apps`) with
permissions from the agent scopes (#57): `contents:read`, `contents:write`,
`pulls:write`, `ci:run`, `releases:write`. The response holds the app's RSA
private key in PEM, once; only the public key is stored. Optionally the app
gets its own webhook (`webhook` in the same body).

A repository admin installs the app on named repositories with
`POST /api/v1/apps/{id}/installations`. The app then signs a JWT with its
private key (`alg` RS256, `iss` the app id, `iat`, `exp` at most 10 minutes
later) and exchanges it for an installation token:

```sh
curl -X POST https://forge.example.com/oauth/token \
  -d grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer \
  -d assertion="$APP_JWT" -d installation_id="$INSTALLATION_ID" \
  -d scope="contents:read"   # optional subset of the app's permissions
```

The `yagis_` token lasts one hour. It acts for the installer like an agent
token: it reaches only the installed repositories, only with the app's
permissions, never beyond the installer's own access (path rules and org SSO
included), and never moves the default branch or merges. Removing the
installation (`DELETE /api/v1/installations/{id}`) or deprovisioning the
installer stops its tokens on the next request.

## OAuth apps

OAuth apps let other tools sign people in to the forge API with the
authorization code grant and PKCE (S256 is required). Register one with
`POST /api/v1/oauth-apps` (name and exact redirect URIs, https or http on
localhost); the client secret is returned once.

1. Send the browser to
   `https://forge.example.com/oauth/authorize?client_id=…&redirect_uri=…&scope=repo:read&state=…&code_challenge=…&code_challenge_method=S256`.
   The person signs in if needed and approves.
2. The browser returns to `redirect_uri` with `code` and `state` (or
   `error=access_denied`). Codes last 10 minutes and work once.
3. Exchange the code at `POST /oauth/token` with `grant_type=authorization_code`,
   `code`, `redirect_uri`, `code_verifier` and the client credentials (HTTP
   Basic or `client_id`/`client_secret` in the body).

Scopes are `repo:read` and `repo:write`; with no scope the token only signs
the person in. `GET /api/v1/user` returns who the token belongs to. Tokens
last 8 hours, have no refresh token, appear in the person's API tokens (where
they can revoke them) and follow org SSO like any API token. Deleting the
OAuth app revokes every token it holds.
