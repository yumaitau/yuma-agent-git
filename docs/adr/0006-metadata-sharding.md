# ADR 0006: Metadata shards by org, with a directory database

- Status: Proposed
- Date: 2026-10-17
- Issue: #78 (epic #77, roadmap #23)

## Context

Every metadata table lives in one D1 database (`DB` in
`worker/wrangler.jsonc`). Content does not: blobs and trees are content
addressed in R2 and stay global (issue #78 constraint). The limits that make
one database a ceiling, from the
[Cloudflare D1 limits page](https://developers.cloudflare.com/d1/platform/limits/)
(read 17 October 2026):

| Limit                         | Workers Paid                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------- |
| Size of one database          | 10 GB, and "cannot be further increased"                                                    |
| Databases per account         | 50,000 (more on request)                                                                    |
| Storage per account           | 1 TB (more on request)                                                                      |
| Throughput                    | one query at a time ("inherently single-threaded"); 1 ms queries cap it near 1,000 a second |
| Queries per Worker invocation | 1,000                                                                                       |
| Bound parameters per query    | 100                                                                                         |
| Row, string or BLOB size      | 2 MB                                                                                        |
| Simultaneous D1 connections   | 6 per invocation                                                                            |
| Bindings per Worker script    | about 5,000                                                                                 |

Two things follow. Size: the busiest tables grow with commits and agent
activity (`changesets`, `git_commits`, `git_trees`, `derived`, `usage_events`,
`audit_events`, code search postings), and 10 GB is a hard stop. Writes: one
database serialises every org's writes, so a commit-heavy org slows every
other org. D1 bindings are static: each database is a binding declared in
`wrangler.jsonc`, so adding one means a deploy.

For comparison, the
[Durable Objects limits page](https://developers.cloudflare.com/durable-objects/platform/limits/)
gives SQLite-backed objects 10 GB each, unlimited objects per namespace and a
soft limit of 1,000 requests a second per object, also single-threaded.

## Options

**One D1 database per group of orgs (org shard key), plus a directory.** The
existing `DB` becomes the directory: users, sessions, tokens, orgs, repos and
the shard map. An org's tables live on the shard the map names. Many orgs share
a shard; a large org can have its own. Bindings are `DB_SHARD_<n>`, added by a
deploy, so shards are few (tens, not thousands).

**One D1 database per repo group (repo shard key).** Spreads a single huge org,
but most queries that are not about one repo are about one org (pull request
lists across an org, usage, audit, rulesets, teams, CI capacity), and they
would all fan out.

**A SQLite-backed Durable Object per org.** No binding per shard, so shards are
created on demand, and 10 GB per org. But every query becomes an RPC to the
object, D1 tooling (migrations, Time Travel restore, `wrangler d1 execute`)
does not apply, and the code issues SQL through `env.DB` in hundreds of places.

**External Postgres through Hyperdrive.** Removes the 10 GB ceiling and the
single writer, but adds a service outside Cloudflare to run, back up and keep
in the region, which the forge has avoided so far (ADR 0001).

## Scoring

| Criterion                              | D1 per org group  | D1 per repo group | DO SQLite per org | Postgres + Hyperdrive |
| -------------------------------------- | ----------------- | ----------------- | ----------------- | --------------------- |
| Org queries stay on one database       | yes               | no (fan out)      | yes               | yes                   |
| Ceiling per tenant                     | 10 GB per org     | 10 GB per group   | 10 GB per org     | the server's          |
| One org's writes slow others           | on a shared shard | on a shared shard | no                | shared server         |
| Code change to adopt                   | per table, small  | per table, larger | rewrite of access | driver and SQL        |
| Add a shard without a deploy           | no                | no                | yes               | yes                   |
| Existing tooling (migrations, restore) | yes               | yes               | no                | different             |
| New infrastructure                     | none              | none              | none              | Postgres              |

The only figures measured are local (docs/performance.md); none come from
deployed D1.

## Decision

Shard metadata by **org**, on D1, with the existing `DB` as the **directory**.

- **Directory.** `DB` keeps users, sessions, API and agent tokens, OAuth,
  passkeys, SCIM, orgs and their members and teams, repos, and
  `shard_directory` (migration 0046): `org_id`, `shard` (`DB` or
  `DB_SHARD_<n>`), and the state of a move. An org with no row is on `DB`.
  Personal (user-owned) repos stay on `DB`.
- **Routing.** `worker/src/db/router.ts` resolves the database for an org
  (`shardForOrg`), refusing writes with `503 shard_moving` while the org is
  frozen for the last step of a move. A name that is not bound fails closed;
  the shard map is never trusted to pick an arbitrary binding.
- **First routed slice.** Usage accounting (`usage_events` and its
  trigger-kept `usage_daily`, #61): writes go to the org's shard in one batch
  per database, repo and org reports read that shard, and agent-wide reports
  and budgets fan out over every shard with a per-shard org filter, so rows a
  move has copied but not yet cleaned up are never counted twice. It is append
  only and has no foreign keys, which made it the right first slice.
- **Cross-shard queries.**
  - _Global user data_ (accounts, sessions, tokens, passkeys, SCIM, user
    signing keys) stays in the directory: it is read on every request and
    belongs to no org.
  - _Notifications_ (#44) are per person, so their inbox stays in the
    directory; the fan-out consumer reads the event from the org's shard and
    writes the inbox rows to the directory.
  - _Search_ (#45, ADR 0004): `search_blobs` and `search_trigrams` are keyed
    by content address, like R2, and stay global in the directory;
    `search_repos` and `search_files` move with their org. A search across
    orgs runs the file query on each shard the caller has repos on and merges
    the results, as the usage reports do (`across()` in `api/usage.ts`).
  - _Audit_ (#65): the hash chain is per org (`appendAudit` with `orgId`), so
    each chain moves with its org; instance-level events (no org) stay in the
    directory. Admin search and export fan out over shards and merge by time.
  - _Everything that names only a repo_ resolves the repo's org from the
    directory first (one indexed read, cacheable for the request).
- **Online migration.** Moves are per org and run from the cron
  (`advanceShardMoves`): an operator sets `target` and `state = 'copying'`;
  pages of rows copy while the org keeps working; once caught up the org is
  `frozen` (writes get `503 shard_moving` for the seconds the rest takes),
  `shard` flips, and `settling` copies anything a write in flight at the
  freeze left behind. Fixed ids make every copy idempotent. The old rows stay
  until an operator deletes them, so a move can be reversed by moving back.
  Going from one database to shards is the same move for each org in turn; no
  big-bang cut-over is needed.

## Consequences

- **Not routed yet** (they still use `env.DB` and stay on the directory):
  changesets, refs, Git ID mapping, derived data, pull requests and reviews,
  issues, CI runs, pipelines and caches, webhooks, releases, registry, LFS,
  code search file lists, audit, provenance. Order of work, by size and write
  rate: `audit_events`; `ci_runs` and pipelines; `derived` and the Git ID
  tables; `changesets`; pull requests, reviews and issues; then the rest.
  Each needs its queries to name the org, its copy step in
  `advanceShardMoves`, and its fan-out readers.
- **Foreign keys.** Shards run the same migrations, so a routed table that
  references `repos(id)` or `users(id)` fails its foreign key on a shard where
  those rows do not exist. Before such a table moves, a migration drops the
  reference (the directory enforces it in code instead), or the shard keeps a
  copy of the referenced row. `usage_events` has none.
- **Transactions** (`tx()`, `DB.batch()`) are per database. A write that spans
  the directory and a shard (creating a repo and its first rows) becomes two
  steps, ordered so a failure leaves nothing visible, as the ref lock already
  does for ref moves.
- **Migrations** apply to every shard; the deploy script must run
  `wrangler d1 migrations apply` once per database.
- **Shards need a deploy** to add a binding, and D1 counts toward the 1 TB
  account storage. An operator creates the database; nothing in this change
  creates one or adds a production binding.
- **Backups** (#70) page `DB` only today, so rows on a shard are not backed
  up. Backups must page every shard before any production shard is added.
- The content-addressed object store stays global.

## Review triggers

- More than about 50 shards needed, or shards added often enough that the
  deploy step hurts: revisit SQLite-backed Durable Objects per org.
- A single org's routed data near 8 GB: split that org by repo group.
- Measured p95 on deployed D1 for routed reads above twice the directory's.
- Cloudflare raising the 10 GB per-database limit or adding dynamic D1
  bindings.
