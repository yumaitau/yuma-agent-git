# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Pull request merges record a merge commit by default instead of fast-forwarding
  (#42); set `default_merge_method` to change that per repo.
- Agent tokens need the new `issues:write` scope to open, edit or comment on
  issues (`contents:write` no longer covers them); new agents get it by
  default. `POST /api/v1/repos/:owner/:repo/agents/mcp` is deprecated in
  favour of `/mcp` and sends `Deprecation` and `Sunset` headers.
- The OpenAPI document now marks `cs` as required on `getFile`, `getTree` and
  `getBlame`, matching what those routes always enforced.
- The whole API and dashboard require sign-in. Anonymous callers get `401`,
  public repositories included; API cache policies are `private`.
- The CLI explains how to supply a token when the server refuses an anonymous
  call, and the dashboard's fast-import snippet sends a bearer token.

### Added

- Wave 3 seams. Bulk imports (#72) queue a history secret scan once a repo's
  Git history is in, and pull mirrors (#73) record upstream secrets as alerts
  instead of refusing the sync; neither blocks. The merge queue (#43) keeps
  out, and ejects, a pull request with open secret alerts on its own commits,
  and honours `require_code_owner_review` (#40). Imported GitHub releases
  become forge releases (#54) with checksummed assets. Pipeline jobs with
  `permissions: { packages: write }` get a registry login (`YAG_REGISTRY*`)
  for `helm push`, `docker push` or `npm publish` without OIDC (#53), and a
  publish from a job an agent started is judged as that agent (#62). MCP gains
  `release_list`, `release_get`, `release_notes`, `release_create` and
  `release_update`. The dashboard can subscribe webhooks to `merge_group`.
- Secret scanning with push protection (#66). Pushes, the commit RPC, the agent
  `commit` tool and applied suggestions refuse files that add AWS, GitHub,
  Yuma, Cloudflare, Slack or Stripe tokens, private keys or high-entropy
  values, naming the file and line. A repository admin can bypass with
  `git push -o secret-scanning.bypass=<false_positive|test_data|will_fix>` (or
  `secret_scanning_bypass` on the commit RPC); each bypass is audited and
  raises an alert. Alerts store a SHA-256 of the secret and its location,
  never the value. `/api/v1/repos/:repo/secret-scanning/alerts` and the
  repository Security page list and resolve them; history scans run after an
  import and on request; `secret_scanning_alert` webhooks route new alerts.
  Agent transcripts are redacted with the same detectors.
- Code search (#45): `GET /api/v1/search/code` searches file contents across
  every readable repo by text or regular expression, with `repo`, `path`,
  `lang` and `rev` filters and match ranges; `GET /api/v1/search/paths` finds
  files by path. Results respect repo access and path rules. A trigram index
  (derived data, migration 0033) is built per changeset, one new blob at a
  time. MCP tools `code_search` and `file_find`, and a dashboard Search page.
  The agent `grep` tool now searches through the index, so it no longer comes
  back empty on large repos.
- CODEOWNERS (#40): a `CODEOWNERS` file in `.yuma/`, `.github/`, the root or
  `docs/` (GitHub syntax, plus `@agent:<name>` agent reviewers) requests owners
  on pull requests when they open, get a new head or are marked ready. The
  `require_code_owner_review` branch rule blocks merges until an owner of each
  changed file approves, reading owners from the target branch.
  `GET …/codeowners` and `GET …/pulls/:id/codeowners` show owners and file
  errors; the pull request page lists them.
- Merge queue (#43). A branch ruleset rule `merge_queue` (`mode` `strict` or
  `optimistic`, `max_batch`) turns the queue on and refuses every other update
  of the branch: merges, ref moves and `git push`. `…/pulls/:id/queue` adds
  (`POST`, with `priority`) and removes (`DELETE`) pull requests;
  `…/merge-queue` and the dashboard queue page show the queue. One Durable
  Object per repo and branch builds merge groups with the server-side merge, runs
  pipelines with the new `merge_group` trigger on them and lands a green group
  with one compare-and-swap move; a failing group is bisected and the failing
  pull request ejected with a comment. Optimistic mode lands first and
  reverts, then reopens, a group whose post-land checks fail. Webhooks get
  `merge_group` events and `enqueued`/`dequeued` pull request actions; MCP
  gets `pr_enqueue`, `pr_dequeue` and `merge_queue_get`.
- Releases (#54): a release names an existing tag, with Markdown notes
  (optionally generated from merged pull requests and commits since the
  previous release), draft and prerelease flags and a `latest` pointer. Drafts
  are hidden from readers without write. Assets live in R2 with a SHA-256
  computed on upload and checked on every download, under a per-org size cap
  (`/api/v1/orgs/:org/release-settings`, default 100 MiB). A CI job's ID token
  (`audience=yag:attest`) turns into a signed SLSA provenance attestation
  (in-toto statement in a DSSE envelope, verifiable against `/ci/oidc/jwks`).
  Releases have API routes, a dashboard page, `yag release` (create, upload,
  publish, download, attest, verify) and the `release` webhook event. Agents
  need `releases:write`; publishing is judged as `release.publish`.
- Package registry (#53): an OCI distribution v1.1 registry at `/v2/` (chunked
  blob uploads streamed to R2, manifests, tags, the referrers API, the Bearer
  token flow at `/v2/token`) for `docker`, `helm` and `cosign`, and an npm
  registry for scoped packages at `/npm/` (publish, install, dist-tags).
  Packages inherit the linked repo's roles; CI jobs push to their own repo's
  packages with their request or ID token; agents need the new
  `packages:write` scope and their publishes go through the guardrails as
  `release.publish`. Per-owner quota (`REGISTRY_QUOTA_BYTES`), `keep_untagged`
  retention with a cron cleanup, audit events and a `package` webhook event.
  See docs/registry.md.
- GitHub bulk import (#72): `POST /api/v1/orgs/:org/imports`, `yag import
github` and the org Import page bring a GitHub org's repos in with the same
  commit SHAs (fetched over Git smart HTTP into the push path, in resumable
  chunks), branches and tags, labels, milestones, issues with sub-issues and
  `yuma:*` work labels, pull requests, comments, reviews and line threads,
  releases with assets, and LFS objects. Each phase checkpoints, GitHub rate
  limits pause the job, failed repos resume from their checkpoint, and a re-run
  adds nothing twice. Accounts match by linked GitHub identity or verified
  email, else become claimable placeholders.
- Pull and push mirrors and the per-repo GitHub cutover (#36, #73). A pull
  mirror fetches a remote's branches and tags over Git smart HTTP and lands
  them through receive-pack with the same SHAs; a push mirror pushes the
  forge's branches and tags back, never rewriting remote history unless force
  is on. Refs both sides moved are reported as diverged and left alone.
  Syncs run from the new `mirror-sync` queue on a schedule, on demand and
  after every ref move. Tokens are stored with the #50 envelope encryption and
  never returned or logged; the GitHub App can be used instead. A repo moves
  `github` -> `mirror` -> `dual` -> `cutover` and back, each move checked and
  audited; `cutover` archives the GitHub repository after a typed approval.
  Routes: `/api/v1/repos/:repo/mirrors[...]` and `/api/v1/repos/:repo/migration`.
  See `docs/migration/cutover.md`.
- Wave 2b seams. Agent guardrails judge work queue claims (`queue.claim`, with
  the item's risk; a held claim goes back to the queue), an agent marking work
  ready (`issue.ready`), update-branch by an agent (`pr.merge`), each
  server-side merge in the `land` tool (`ref.move`) and deploys of
  agent-started self-hosted runner jobs (`deploy`, held jobs stay queued). The
  kill switch also cancels agent-started runner jobs, ends MCP sessions and
  refuses MCP refresh grants. Webhooks add `pull_request_review_thread`,
  `work_item` and `ci_run` `in_progress`; merge events carry the merge commit.
  MCP adds `pr_conflicts`, `pr_update_branch`, `review_thread_*`,
  `issue_labels_set`, `issue_assignees_set` and `queue_*` tools. MCP clients
  and OAuth apps share `/oauth/authorize` and `/oauth/token`, dispatched by
  client id, and `/mcp`, `/oauth/*` and `/.well-known/oauth-*` now run the
  Worker before static assets.

- Agent guardrails (#62). Org policies, written in a typed rules DSL
  (`docs/adr/0003-policy-engine.md`) with a default pack in
  `policies/default.json`, judge agent pushes, commits, ref moves, tags and
  pipeline runs, and every agent tool call. A rule denies or holds the action
  for a person: CI workflows, pipelines, CODEOWNERS and ruleset files,
  dependencies from outside the npm registry, more than 50 files or 1 MiB,
  and releases need approval; force pushes outside `refs/agents/` are
  refused. People approve the exact payload hash in Settings or through
  `POST /api/v1/repos/:repo/approvals/:id`, and the agent's identical retry
  lands. Policies are versioned and audited (`PUT /api/v1/orgs/:org/policy`)
  and testable with `yag policy test`. The kill switch
  (`POST /api/v1/orgs/:org/agents/pause`, or `/api/v1/admin/agents/pause`
  for the instance) revokes agent tokens, cancels agent tasks and refuses
  agent writes from the next request; the org page shows who paused agents.
- Merge, squash and rebase pull requests on the server (#42). A moved target no
  longer blocks a merge: the server three-way merges onto its current head and
  reports `409 merge_conflict` with each conflicting path and its base, target and
  proposed hunks when edits overlap (`GET …/pulls/:id/conflicts` checks ahead).
  `POST …/pulls/:id/update-branch` brings the target into a pull request by merge
  or rebase. Repos choose allowed methods and a default, and a branch ruleset
  `merge_methods` rule narrows them. Merge commits get the SHA-1 `git merge
--no-ff` would record; squashes credit other authors with `Co-authored-by`. The
  agent `land` tool merges a moved main in by itself. The dashboard has a method
  picker, update buttons and a conflict view. Migration `0023_merge_strategies`.
- Line-level review (#39). Threads sit on lines of a pull request revision
  (`/pulls/:id/threads`), follow their code to new revisions and turn
  outdated, still readable, when the lines change. Threads take replies and
  resolve or unresolve. A fenced `suggestion` block is applied as a changeset
  on the head (`/pulls/:id/suggestions/apply`), which needs fresh approvals.
  A review can carry up to 100 inline comments in one call, and reviews can
  be requested from people, teams and agents (`/pulls/:id/reviewers`). The
  branch rule `required_review_thread_resolution` blocks merges until every
  thread is resolved. The dashboard diff takes inline comments.
- Self-hosted runners (#48). Pipeline jobs pick runners with `runs-on`
  labels; jobs without it stay on the built-in Cloudflare pool. Org owners and
  repo admins create one-time registration tokens; each runner gets its own
  revocable credential and pulls jobs over HTTPS (`/runner/v1`: long-poll
  claim, heartbeats, per-step logs, step results, artifacts, cancellation).
  Claims are at most once, revocation takes effect within one poll round,
  ephemeral runners take one job and deregister, and `trusted_only` runners
  never run public repo or fork jobs. Jobs clone over Git smart HTTP with a
  per-run read-only token. Logs are capped per step (512 KiB) and per run
  (4 MiB). `runner/` is a small Node 22 reference runner; the dashboard has a
  Runners page for orgs and repos. See `docs/runner-protocol.md`.
- Native work queue (#59) in place of `yuma:ready` and `yuma:risk:*` labels.
  Issues carry readiness, risk, size, agent kind, priority, a plan flag and
  `waits-on` dependencies under `/api/v1/repos/:repo/work`. A claim is one
  conditional D1 update, so concurrent claims never share an item; it skips
  items with open dependencies or above the claimant's risk allowance (agents
  get a `max_risk`, `low` by default). Leases renew with heartbeats and return
  to `ready` with `attempts + 1` when they lapse. Agent tokens need
  `queue:claim`; only people with triage, or agents with `queue:approve`, can
  mark work ready or change its risk, and a body edit by anyone else sends
  ready work back to `needs-prep`. Factory labels import as fields. Every
  readiness change is audited. `yag work list|claim|heartbeat|release|set`
  and a dashboard Board view come with it.
- Outbound webhooks, apps and OAuth apps (#75). Repo, org and app webhooks
  receive push, ref, pull request, review, issue and CI run events in the
  forge's format or a GitHub-compatible one, signed with
  `X-Yag-Signature-256` (`X-Hub-Signature-256` too for GitHub), retried with
  backoff for 24 hours, with a delivery log and redelivery. URLs must be https
  and never private, loopback, link-local or metadata addresses. Apps exchange
  a signed JWT for one-hour installation tokens limited to their permissions
  and installed repositories; OAuth apps sign people in with the authorization
  code grant and PKCE.
- MCP server at `/mcp` (#56): Streamable HTTP per MCP 2025-11-25 with
  sessions and resumable SSE for tool calls, OAuth 2.1 (protected resource and
  authorisation server metadata, dynamic client registration, PKCE, rotating
  refresh tokens) mapped onto agent identities, and 32 annotated forge tools
  built from the OpenAPI contract. Setup for Claude Code, Codex, Factory and
  Grok is in `docs/mcp.md`.
- CI secrets, variables, environments and OIDC workload identity (#50).
  Org, repo and environment secrets are envelope-encrypted, write-only and
  masked in logs (including base64, URL-encoded and line-split forms).
  Environments add required reviewers, wait timers, branch globs and a
  people-only flag, with approvals in the audit log. Jobs that opt in with
  `permissions.id_token: write` get GitHub-compatible OIDC ID tokens from
  `/ci/oidc` (public discovery and JWKS, RS256, rotating keys), and an `aws`
  block sets up `AWS_WEB_IDENTITY_TOKEN_FILE` for the AWS CLI and SDKs. The
  runner image adds pinned AWS CLI v2, Helm 3 and kubectl.
  `scripts/ci-keys.mjs` generates and rotates the keys without printing them.
  See `docs/ci-oidc-aws.md`.
- YAML pipeline jobs (#47) take the #50 fields per job: `permissions`,
  `aws`, `secrets`, `environment`, and `${{ secrets.NAME }}` and
  `${{ vars.NAME }}` step references (passed as shell variables). A job with
  an environment waits at its gate (approval request, wait timer, branch and
  people-only rules) before it starts, and each job gets its own OIDC `sub`
  and `job` claims. Agent-started pipelines run as `actor_kind: agent`.
  **Retry** on a CI run now reuses its trigger (`POST …/ci/runs/:id/retry`),
  so retried runs keep their ref, approval gate and ID tokens. Org secret
  routes honour org SSO.
- End-to-end suites (golden path, concurrent landing, route authorization matrix,
  migrations), a deterministic commit-graph fuzzer, and a generated API reference
  (`docs/api.md`) checked against the router in CI.
- `yag clone --token`.
- Public API contract (#28): `docs/openapi.json` (OpenAPI 3.1, also at
  `GET /api/v1/openapi.json`) generated from the router and zod schemas, a
  versioning and deprecation policy (`docs/api-versioning.md`), and the generated
  `@yuma/agent-git-sdk` package that the CLI's request types now come from.
- Organisations and teams (#26): org-owned repos, nested teams with repo grants,
  org base roles, and an org settings page in the dashboard.
- Yuma-owned sign-in (#27): OIDC providers, passkeys, authenticator-app MFA with
  step-up, and SCIM 2.0 user provisioning.
- Org SSO (#27): org owners can require sign-in through an OIDC provider; members
  who signed in another way get `sso_required` on org repos over the API and Git.
  SCIM groups sync to teams, and `REQUIRE_MFA_FOR_TOKENS` makes token creation
  need recent MFA. SAML stays out (`docs/adr/0002-saml-sso.md`).
- Hash-chained audit log (#65) with search, CSV/NDJSON export, `yag audit verify`
  and an HMAC-signed SIEM stream. Org, team, tag, MFA and SCIM actions are audited,
  and org owners and admins can read their org's chain.
- Arbitrary branches and tags (#33), including annotated tags and agent work refs
  under `refs/agents/<token-id>/` that only that agent can write.
- Deterministic Git commit, tree and blob ids for every changeset (#30).
- Git over HTTPS (#31, #32): `git clone`, `fetch` (protocol v2, shallow and
  `blob:none` / `tree:0` partial clones) and `git push` with token auth, a `git`
  rate-limit bucket, pre-receive checks (protected default branch, path rules,
  file size, unsafe paths) and one ref compare-and-swap per update. Pushed
  commits keep their SHAs. See `docs/git-http.md`.
- Agent identities (#57): agents owned by a user or org, delegated through an
  RFC 8693 token exchange (`POST /oauth/token`) to tokens that last 15 minutes by
  default and one hour at most, bound to named repos and fine-grained scopes. An
  agent gets the intersection of its grant and the person's role, never moves the
  default branch, owns `refs/agents/<agent-id>/`, and its changesets record the
  agent, the person and the task. Disabling an agent revokes its tokens at once.
- Issues (#38): labels, milestones, assignees (people, teams and agent tokens),
  ordered sub-issues with progress, pins, locks, Markdown templates and issue forms
  from `.yuma/` or `.github/ISSUE_TEMPLATE`, and a timeline. `#N` and
  `owner/name#N` references link issues from issues, pull requests and commit
  messages; `Closes`/`Fixes`/`Resolves` close them once the change lands on the
  default branch. Issues and pull requests share one number sequence per repo. A
  new `triage` repo role labels, assigns and closes issues without code access.
  Markdown is rendered escape-first by one shared module (`worker/shared/markdown.ts`).
  Commits pushed to other branches link (never close) the issues they name.
- Forge strategy decision record (`docs/adr/0001-forge-strategy.md`, #25).
- Rulesets (#41) for branches, tags and pushes at repo and org level: no deletion,
  no force push, pull request only, required approvals, required CI, and push rules
  for file size, paths and extensions. One evaluator serves API ref moves,
  `git push`, pull request merges, agent lands and commits; refusals name the
  ruleset. Evaluate mode logs without blocking, bypass actors (roles, teams, agent
  tokens, users) are audited with their reason, and ruleset changes are audited.
  The CI policy's `protect_default`, `required_approvals` and `require_checks`
  become the "CI policy (default branch)" ruleset, so existing repos behave the same.
  Branch rulesets reach agent refs only through patterns that name `refs/agents/`,
  and an agent identity bypasses only as `agent:<agent id>`, never as its human.
- Dashboard theme in the Yuma IT brand.
- Pipeline spec v2 (#47): YAML pipelines in `.yuma/pipelines/*.yml` with jobs,
  `needs`, matrices, services, concurrency groups and push (from `git push`),
  pull request, manual and scheduled triggers. Invalid files report line-numbered
  errors and the CI page shows each run's job graph. Repositories without spec
  files keep the settings pipeline. See `docs/pipelines.md`.

### Fixed

- Directory path rules are enforced everywhere: object, tarball and fast-import
  reads need whole-repository read; diffs, listings and history drop denied paths;
  commits check write per path; ref moves and imports need whole-repository write.
  Signed cache tokens are bound to the user who minted them.
- Agent tasks: cancel and timeout stick, budget exhaustion fails the task, resumed
  runs keep their budget, spawned tasks run as the requesting user, post-merge checks
  review the landed diff and queue one fix task on failure, and agent tools honour
  path rules. Superfans are registered per repository by admins and can be listed
  and stopped.
- GitHub export finishes changes over 100 files; full-history import no longer drops
  files from commits over 300 files or over 1 MiB.
- Agent `land` moves the repository's default branch instead of `main`, and stops on
  final refusals such as a protected branch instead of retrying until its budget runs
  out. MCP calls default to the default branch's head.
- Tar reading was quadratic in entry size, and snapshot import buffered files over the
  25 MiB limit before skipping them; both now stream in linear time and constant memory.
- Queue provisioning accepts Cloudflare's "already taken" response, so
  `npm run deploy` can be re-run.

## [0.1.0] - 2026-10-15

First pilot release, deployed to the Yuma workers.dev instance.

### Added

- Content-addressed storage: changesets in D1, compressed blobs and canonical
  trees in R2, refs moved by Durable Object compare-and-swap.
- Server-side version control RPCs: commit, file/tree/history/changed-paths at
  any revision, three-dot diff, O(log n) ancestry and merge-base, blame and path
  history through a generic derived-data framework.
- Sparse checkout protocol and the `yag` thin client with an LRU object cache.
- GitHub OAuth sessions, scoped API tokens, repository roles and directory-level
  path rules.
- GitHub bridge: App installation, HMAC-verified webhooks, snapshot and
  full-history import, tarball and fast-import export, contents-sync export.
- Agent runtime on the Agents SDK with Workers AI, an RPC tool registry with
  budgets, an MCP endpoint, post-merge checks and anomaly-detecting superfans.
- Web dashboard: repository browser, changeset, diff and blame views, agent
  tasks, pull requests and CI pages, settings.
- Native repositories with pull-request reviews, protected merges and bounded
  Cloudflare Containers CI.
- Hardening: sharded Durable Object rate limiting, Cache API tier with signed
  cache tokens, structured logs, phase timings and cron-aggregated metrics.

### Fixed

- Scoped bearer tokens could gain session privileges.
- CLI commits did not advance local checkout state.
- The production dashboard bundle referenced a missing React global.
