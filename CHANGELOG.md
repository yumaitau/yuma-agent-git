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
