# Performance

How the forge is load tested, the budgets CI enforces, and every number
measured so far (issue #78). Each figure says where it was measured. **Every
measured number below is local**: one Apple M4 Mac mini (16 GB), Node
v22.23.1, Git 2.50.1, wrangler 4.151.0, `wrangler dev --local` (workerd, local
SQLite for D1 and local files for R2). Local numbers show relative cost and
catch regressions. They say nothing about latency from Sydney, deployed D1 or
R2, or the network.

## Load harness

`scripts/load/run.mjs` drives the forge from outside, with stock `git` and
`fetch`:

| Scenario      | One operation                                                        |
| ------------- | -------------------------------------------------------------------- |
| `clone`       | `git clone` of a small repo (51 files)                               |
| `fetch`       | commit and push a branch from one clone, `git fetch` it in another   |
| `push`        | commit one file and `git push` a new branch                          |
| `commit`      | `POST …/changesets` then `PUT …/refs/:name` (the commit RPC)         |
| `pr`          | a changeset, then `POST …/pulls`                                     |
| `merge`       | `POST …/pulls/:id/merge` (one at a time: merges move one branch)     |
| `clone-large` | push `--files` files of `--size-mb` in total, then time clones       |
| `two-org`     | write latency for org A while org B, on another shard, takes a burst |

```bash
# local: starts its own throwaway wrangler dev with a local-only second shard
DOCKER_HOST=unix:///nonexistent.sock node scripts/load/run.mjs --scenario all \
  --iterations 20 --concurrency 4 --files 20000 --size-mb 40 --out local.json

# a deployed instance; the repos must exist and the token must write to them
YAG_LOAD_URL=https://git.example.com YAG_LOAD_TOKEN=yag_… \
  YAG_LOAD_REPO=acme/app YAG_LOAD_BIG_REPO=acme/big YAG_LOAD_OTHER_REPO=beta/app \
  node scripts/load/run.mjs --scenario clone-large --target staging --size-mb 300
```

The local target generates its own wrangler config in a temporary directory:
the top-level config with absolute paths, a second D1 binding `DB_SHARD_1`
(local only, never a production database id), raised rate limits, and seeded
orgs `acme` (on `DB`) and `beta` (on `DB_SHARD_1`). It never starts the `prod`
environment, so no container image is built. A remote target should exempt the
load token from rate limits or the harness measures `429`s.

`clone-large` writes random binary files in commits of at most 5,000 files and
16 MiB, because a commit stores at most 5,000 changes and a push carries at
most 24 MiB of pack (docs/git-http.md). It then times a cold clone, a second
identical clone (served from the R2 pack cache) and a `--depth 1` clone.

`two-org` reports the latency of a usage write (`POST /api/v1/usage`, the
routed slice in ADR 0006) for `acme` alone, while `beta` (another shard) takes
a burst of writes, and, as a control, while another `acme` repo (the same
database) takes the same burst.

## Measured, local only

Run on 17 October 2026, 20 iterations, 4 at once (merges one at a time).
Times are client-side, from the start of the command to its exit.

| Scenario | p50 ms | p95 ms | max ms | operations/s |
| -------- | -----: | -----: | -----: | -----------: |
| clone    |    277 |    315 |    359 |         14.1 |
| fetch    |   1019 |   1138 |   1179 |          3.8 |
| push     |    758 |   1333 |   1368 |          4.6 |
| commit   |    457 |    698 |    762 |          8.1 |
| pr       |    640 |    978 |   1025 |          5.4 |
| merge    |    241 |    489 |    512 |          3.7 |

`fetch` includes the commit and push that make something to fetch.

**Large repo**, 20,000 files of 2,097 bytes (random), 4 commits, a 41.5 MiB
pack on the client:

| Step                                        | ms      |
| ------------------------------------------- | ------- |
| 4 pushes of 5,000 files                     | 155,881 |
| cold clone                                  | 11,860  |
| second clone (pack cache hit)               | 1,801   |
| `--depth 1` clone (its own cache key, cold) | 8,883   |

**Two orgs**, 50 writes each phase, 8 writers bursting:

| Phase                            | p50 ms | p95 ms | max ms | burst writes |
| -------------------------------- | -----: | -----: | -----: | -----------: |
| `acme` alone                     |    6.0 |    8.0 |   10.8 |            0 |
| `beta` bursting (other shard)    |   20.0 |   40.7 |  106.6 |          303 |
| another `acme` repo (same shard) |   31.5 |   55.0 |   59.9 |          404 |

Each repo's usage report counted only its own events (150 and 303). Locally
both databases are SQLite files inside one workerd process on one machine, and
the Worker itself is single threaded, so a burst on any org slows the others;
the gap between the two burst phases is suggestive at best from one run. The
acceptance check, "a write burst on one does not raise latency on the other",
needs deployed D1, where each database is its own Durable Object.

**CI checkout of 20,000 files** (`worker/test/ci-checkout.test.ts`,
miniflare): the built-in runner fetches over Git with the run's job token, and
the simulated VM fetches all 20,000 blobs, 21 trees and the commit through the
real upload-pack route. The whole test, including writing the four commits,
took 140 s (vitest's test time, one passing run). That is test time on one
machine, not a checkout latency.

## Endpoint budgets (CI)

`worker/test/perf-budgets.test.ts` runs with `npm test -w worker` (and alone
with `npm run bench:endpoints -w worker`). Each endpoint is called 8 times on a
small repo in miniflare. Statement and R2 counts are exact on any machine; the
wall-clock budget is loose so only a large regression trips it on a slow CI
runner. Statements run inside Durable Objects are not counted.

| Endpoint                  | D1 budget | measured | R2 budget | measured | p95 budget ms | measured p95 ms |
| ------------------------- | --------: | -------: | --------: | -------: | ------------: | --------------: |
| `GET` repo                |         6 |        5 |         0 |        0 |           250 |               7 |
| `GET …/tree`              |        11 |        9 |         2 |        1 |           250 |               4 |
| `GET …/file`              |         9 |        7 |         4 |        3 |           250 |               4 |
| `GET …/history`           |        11 |        9 |         0 |        0 |           250 |               3 |
| `POST …/changesets`       |        64 |       56 |        16 |       13 |           500 |              20 |
| `GET …/usage`             |        11 |        9 |         0 |        0 |           250 |               4 |
| Git `ls-refs`             |         9 |        7 |         0 |        0 |           250 |               4 |
| Git `fetch` (small clone) |        12 |       10 |         7 |        5 |           500 |               6 |

The commit RPC issues 56 D1 statements for a one-file change, against D1's
1,000 queries per invocation; it is the first place to look when commit
latency on deployed D1 matters. Raise a budget only in a reviewed change that
says why.

## Targets not measured

None of these has been run. They need a deployed staging instance and a client
in Sydney, which this change did not have.

| Target                                                                                | Status                                                                       |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| A 300 MB repo clones over Git in under 2 minutes from Sydney                          | not measured                                                                 |
| Two orgs on different deployed shards: a burst on one leaves the other's latency flat | not measured                                                                 |
| Clone, fetch, push, commit RPC, PR create and merge at 10x Yuma's daily volume        | not measured; the daily volume figure is not recorded in this repo           |
| Online move of a copy of pilot data from one database to shards                       | not measured; the move is tested in miniflare (`worker/test/shards.test.ts`) |
| CI checkout of 20,000 files on a real runner VM                                       | not measured; tested with a simulated VM                                     |

Run `node scripts/load/run.mjs --target staging …` from Sydney against
staging, record the JSON here with the date, host and client location, and
keep these local figures beside them, labelled.

## Large repositories: what is and is not built

- **Clone pack cache**: built (docs/git-http.md).
- **CI source over Git**: built; the 32 MiB, 2,000-file limit applies only to
  the tar fallback (schedules and commits without Git IDs yet).
- **5,000 changes per commit**: kept and documented. A changeset row holds its
  whole file list and a D1 row is at most 2 MB. Lifting it means storing large
  file lists in R2 and changing the readers of `changed_files`.
- **Push over 24 MiB spilled to R2**: not built. Packs are parsed in memory,
  and a queue consumer has the same 128 MB as a request, so spilling only
  helps once the pack reader resolves deltas from R2 rather than memory.
