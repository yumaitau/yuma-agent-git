# yuma-agent-git

**Agent-scale source control + agent orchestration, built entirely on Cloudflare.**

Inspired by Anthropic's [Redesigning source control at Anthropic](https://www.anthropic.com/engineering/redesigning-source-control) (Scion), yuma-agent-git rethinks git for a world where most clients are **always-online agents**, not offline humans.

## Why

Git is decentralized: every clone is a complete repository. That design is excellent for offline humans, but it strains when agents check out code millions of times a day. Scion's answer: a server-authoritative, content-addressed system where **commits, diffs, merges, blame and history are server-side RPCs**, checkouts are optional and sparse, and nothing is ever fully materialized anywhere.

yuma-agent-git brings that model to a platform anyone can run on Cloudflare's edge — and pairs it with an **agent orchestration layer** so AI agents can consume and produce code entirely through the API, with zero checkouts.

## Core principles (from Scion)

1. **Clients are always online** — the server is authoritative; clients fetch what they need.
2. **Client-server asymmetry** — the server commits, merges, rebases, diffs, blames. Clients hold a bounded cache.
3. **One comprehensive RPC surface powers many applications** — CI, bisect, revert pipelines and agents all use the same API; many never check out code.
4. **Everything horizontally scalable** — content-addressed data means any Worker can serve any request; no packfiles, no repo maintenance.
5. **Commits are cheap, incremental, lock-free** — a changeset records only what changed vs. its first parent; cost scales with change size, not repo size. Refs are discouraged global state; moving one is a compare-and-swap.
6. **Working copies are optional and sparse by design** — checkout protocol is tree/blob recursive fetch; clients pay only for what they read.

## Architecture

| Scion concept                                  | yuma-agent-git on Cloudflare                                      |
| ---------------------------------------------- | ----------------------------------------------------------------- |
| Changesets (WAL)                               | D1 rows: changed-file list + content-addressed pointers           |
| Blob/tree storage                              | R2, SHA-256 content-addressed, zstd-compressed blobs              |
| Refs + CAS                                     | Durable Object per ref (compare-and-swap)                         |
| scion-server RPCs                              | Worker + Hono HTTP/JSON API                                       |
| Derived data (blame, path history, skip lists) | Generic recursive framework, eager or deferred via Queues         |
| scion-daemon / cache tiers                     | Client-side bounded object cache (thin `yag` CLI)                 |
| git bridge                                     | Import: clone → changesets via Queues. Export: fast-import stream |
| Agents                                         | Agents SDK / Durable Objects + Workers AI, writing through RPCs   |

See [docs/architecture.md](docs/architecture.md) for the full design and [docs/api.md](docs/api.md) for the RPC surface.

## Stack

- **Workers + Hono** — API, dashboard, webhooks
- **D1** — changesets, refs, derived data, auth, RBAC
- **R2** — blobs and trees
- **Durable Objects** — ref CAS locks, agent sessions
- **Queues** — git ingestion, deferred derived data, agent jobs
- **Workers AI** — LLM calls for built-in agents
- **GitHub OAuth + GitHub App** — auth and the git bridge

## Status

Repository history, pull-request reviews, protected merges and native Cloudflare
CI are implemented. CI execution stays disabled until an operator configures the
Cloudflare resources. Start with the [developer quickstart](docs/developer-onboarding.md),
[GitHub comparison and cost research](docs/github-cloudflare-research.md), and
[runner deployment guide](docs/deploy.md#cloudflare-ci-runners).

Under construction — tracked via [GitHub issues](https://github.com/yumaitau/yuma-agent-git/issues) organized into milestones:

- **M1: Foundations** — scaffold, D1 schema, R2 object store
- **M2: Core VCS** — commit/read/diff/ancestry/blame RPCs, refs, derived data, sparse checkout
- **M3: Auth + GitHub bridge** — OAuth, GitHub App, RBAC, git import/export
- **M4: Agents** — agent runtime, task API, Workers AI loop
- **M5: Dashboard + hardening** — web UI, observability, e2e tests, deploy

## License

MIT
