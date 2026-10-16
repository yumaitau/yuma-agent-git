# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- The whole API and dashboard require sign-in. Anonymous callers get `401`,
  public repositories included; API cache policies are `private`.
- The CLI explains how to supply a token when the server refuses an anonymous
  call, and the dashboard's fast-import snippet sends a bearer token.

### Added

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
  step-up, and SCIM 2.0 user provisioning. SAML and SCIM groups are not built yet.
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
- Forge strategy decision record (`docs/adr/0001-forge-strategy.md`, #25).
- Rulesets (#41) for branches, tags and pushes at repo and org level: no deletion,
  no force push, pull request only, required approvals, required CI, and push rules
  for file size, paths and extensions. One evaluator serves API ref moves,
  `git push`, pull request merges, agent lands and commits; refusals name the
  ruleset. Evaluate mode logs without blocking, bypass actors (roles, teams, agent
  tokens, users) are audited with their reason, and ruleset changes are audited.
  The CI policy's `protect_default`, `required_approvals` and `require_checks`
  become the "CI policy (default branch)" ruleset, so existing repos behave the same.
- Dashboard theme in the Yuma IT brand.

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
