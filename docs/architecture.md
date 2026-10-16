# yuma-agent-git — Architecture

Full design, derived from Anthropic's Scion (see [Redesigning source control at Anthropic](https://www.anthropic.com/engineering/redesigning-source-control)) and mapped onto Cloudflare primitives.

## 1. Data model

### 1.1 Blobs (R2)

A blob is file content, compressed with zstd, stored under a content address:

```
R2 key: blobs/{sha256hex[0:2]}/{sha256hex}
```

- Address = SHA-256 of the **uncompressed** content (so clients can verify after decompress).
- Immutable. Writing an existing hash is a no-op (dedup for free).
- No packfiles, ever. No delta compression server-side (R2 reads are cheap; CPU is what we protect).

### 1.2 Trees (R2)

A tree maps names to child objects for one directory level:

```json
// R2 key: trees/{sha256hex[0:2]}/{sha256hex}
{
  "entries": [
    { "name": "src", "kind": "tree", "hash": "ab12…" },
    {
      "name": "README.md",
      "kind": "blob",
      "hash": "9f01…",
      "size": 2043,
      "mode": "100644"
    }
  ]
}
```

- Tree hash = SHA-256 of its canonical JSON (entries sorted by name).
- A commit does **not** require writing a root tree, but trees are written for every directory a change touches (needed for checkout and tree-walk queries).

### 1.3 Changesets (D1)

The unit of work — an entry in a write-ahead log. Like a git commit, but instead of a tree pointer it stores **the list of files changed relative to its first parent**, with content-addressed pointers:

```sql
CREATE TABLE changesets (
  id            TEXT PRIMARY KEY,      -- sha256 of canonical changeset JSON
  repo_id       TEXT NOT NULL,
  first_parent  TEXT,                  -- changeset id; NULL = root
  parents       TEXT NOT NULL,         -- JSON array of parent ids (>=1 for merges)
  author        TEXT NOT NULL,         -- JSON {name, email} or agent id
  message       TEXT NOT NULL,
  created_at    INTEGER NOT NULL,      -- epoch ms
  changed_files TEXT NOT NULL          -- JSON array: [{path, op: add|mod|del, hash?, size?}]
);
CREATE INDEX idx_changesets_repo_parent ON changesets(repo_id, first_parent);
CREATE INDEX idx_changesets_repo_created ON changesets(repo_id, created_at);
```

- Changeset id = SHA-256 of canonical JSON (id, minus the id field). Content-addressed → immutable → cacheable anywhere.
- Creating a changeset = 1 R2 batch write (new blobs/trees) + 1 D1 insert. **No locks, no refs touched, no coordination.** Cost scales with the change, not the repo.
- Available everywhere instantly (D1 replication + R2 global).

### 1.4 Refs (Durable Objects)

Refs are discouraged global state (Scion principle 5). We support exactly: `main` per repo, plus optional release refs. Everything else is a changeset id, not a ref.

- One Durable Object instance per `(repo_id, ref_name)`.
- `moveRef(from, to)` is a **compare-and-swap** inside the DO: read current head from D1, verify it equals `from`, write `to`, all in a storage transaction.
- Fast-forward detection (is `from` an ancestor of `to`?) uses the ancestry RPC.

```sql
CREATE TABLE refs (
  repo_id TEXT NOT NULL,
  name    TEXT NOT NULL,
  head    TEXT NOT NULL,              -- changeset id
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, name)
);
```

### 1.5 Derived data (generic recursive framework)

A changeset records only what changed, so blame/path-history/ancestry need extra structures. Following Scion: **one generic mechanism**, each type defined recursively — value for a changeset is computed from values for its parents.

```sql
CREATE TABLE derived_data (
  repo_id  TEXT NOT NULL,
  kind     TEXT NOT NULL,             -- 'blame' | 'path_history' | 'skip_list' | 'changed_paths'
  cs_id    TEXT NOT NULL,
  payload  TEXT NOT NULL,             -- kind-specific JSON
  PRIMARY KEY (repo_id, kind, cs_id)
);
```

Types shipped in v1:

| Kind            | Value                                                         | Computed |
| --------------- | ------------------------------------------------------------- | -------- |
| `changed_paths` | Set of paths touched by cs + all ancestors (prefix-collapsed) | eager    |
| `skip_list`     | Ancestry skip pointers (heights 2^k) for O(log n) merge-base  | eager    |
| `path_history`  | Per-touched-path list of ancestor cs ids                      | deferred |
| `blame`         | Per-file line-range → cs id mapping for files touched         | deferred |
| `git_ids`       | Git commit SHA-1/SHA-256; fills `git_commits/trees/blobs`     | both     |

- **Deferred** = computed on first read (cache-aside), or enqueued to a Queue for background computation.
- **Eager** = computed in the commit RPC's transaction when cheap.
- `git_ids` (issue #30) is eager for small changes whose parents already have IDs and queued otherwise; one invocation never hashes more than 64 MiB. `worker/src/git/` holds the exact object encoders and the indexed lookups (sha1 ⇄ cs id, tree/blob IDs, raw object bytes) that fetch and push build on.
- Clients never see internals — payloads are private to the server, so we can optimize freely.

## 2. RPC surface (Worker + Hono)

All read RPCs are cacheable (content-addressed). All JSON over HTTPS. Auth: session cookie (human) or bearer token (agent/CI).

```
# Changesets
POST   /api/v1/repos/:repo/changesets            # commit: create changeset server-side
GET    /api/v1/repos/:repo/changesets/:id        # fetch one
GET    /api/v1/repos/:repo/changesets?head=…&n=… # walk first-parent history

# Refs
GET    /api/v1/repos/:repo/refs
PUT    /api/v1/repos/:repo/refs/:name            # CAS move {from, to}

# Queries (no checkout needed)
GET    /api/v1/repos/:repo/file?cs=…&path=…      # file content at revision
GET    /api/v1/repos/:repo/tree?cs=…&path=…      # one directory level
GET    /api/v1/repos/:repo/diff?from=…&to=…      # server-computed diff
GET    /api/v1/repos/:repo/merge-base?a=…&b=…    # ancestry query
GET    /api/v1/repos/:repo/blame?cs=…&path=…     # line-range → changeset
GET    /api/v1/repos/:repo/history?path=…        # path history
GET    /api/v1/repos/:repo/changed-paths?cs=…    # everything a cs subtree touched

# Sparse checkout protocol (client pulls what it wants)
POST   /api/v1/repos/:repo/fetch-objects         # {hashes:[…]} → batch trees+blobs
GET    /api/v1/repos/:repo/object/:kind/:hash    # single tree|blob

# Git bridge
POST   /api/v1/repos/:repo/import                # enqueue GitHub clone → changesets
GET    /api/v1/repos/:repo/export/fast-import?head=…  # git fast-import stream
```

### 2.1 Commit RPC (write path)

```
POST /api/v1/repos/:repo/changesets
{
  "first_parent": "<cs id>",          // or "ref:main"
  "parents": ["<cs id>"],             // merges: >1
  "message": "…",
  "author": {…},
  "changes": [
    {"path": "src/app.ts", "op": "mod", "content_b64": "…"},   // inline small
    {"path": "big.bin",    "op": "add", "blob_sha256": "…"}    // pre-uploaded blob
  ]
}
```

Server: dedupe/upload blobs to R2 → rebuild trees along touched paths → compute changeset id → insert D1 row → compute eager derived data → return id. **No ref moved.** Caller separately PUTs the ref with CAS if they want to publish to `main` (that's a merge/land operation, see §2.3).

### 2.2 Diff RPC

Both sides' changed-file lists + trees are server-side, so diff = tree walk between two revisions: merge-base the two cs ids, walk only subtrees whose tree hashes differ, stream file-level diffs (unified diff computed in-Worker with a Myers implementation, or just per-file blob pairs for the CLI to render).

### 2.3 Landing changes (no merge queue lock)

Per the article: a global merge-queue lock doesn't scale. Land = rebase-or-merge onto current `main` + CAS ref move + **post-merge, pre-deploy checks** run by agents. Conflict? The landing agent fixes it faster than a human could spot it. `POST /api/v1/repos/:repo/land` implements: verify base is main head → create merge changeset (or fast-forward) → CAS move → enqueue post-land checks.

### 2.4 Sparse checkout protocol

Mirrors Scion's negotiation: the client does **not** tell the server what it has. It starts from the root tree hash of a changeset and recursively requests missing trees, then blobs. Because every object is content-addressed and immutable, any cache tier can answer; the protocol is resumable and needs no packfile.

Client = `yag` CLI (thin): bounded local object cache in `~/.yag/objects`, working copy layout, filesystem watch. Sparse by construction — it just never asks for trees it doesn't want.

## 3. Auth + GitHub bridge

- **GitHub OAuth** (login) → session token in HttpOnly cookie; sessions in D1.
- **GitHub App** (repo bridge) → installation per org/repo; app JWT + installation tokens minted server-side.
- **Webhooks** → GitHub App events (push, PR, installation) land on `POST /webhooks/github`, HMAC-verified against raw body before parsing.
- **RBAC**: repo-level roles (admin/write/read) **plus directory-level permissions** (Scion's monorepo security): `path_rules` table grants/denies per path prefix; enforced in commit RPC, file RPC, and blame/history.
- **Import**: enqueue job → Worker clones via GitHub tarball API (no git binary needed on Workers: fetch tarball, walk files, emit changesets) → progress in D1 → repo becomes queryable. Full-history import (commit-by-commit) runs as a Queue consumer with checkpointing.
- **Export**: server renders changesets → git objects → `git fast-import` stream (or tarball at revision). Lets any git client bootstrap from a yag repo.

## 4. Agent orchestration

The platform's reason to exist: agents that **never check out code**.

- **Agent runtime**: Agents SDK (`Agent` class over Durable Objects). One DO per agent session; state = task, transcript, working revision.
- **Jobs**: `POST /api/v1/agents/tasks` → Queue `agent-jobs` → DO wakes, runs loop:
  1. read files via RPC (`/file`, `/tree`, `/history`, `/blame`)
  2. think with **Workers AI** (`@cf/meta/llama-3.3-70b-instruct-fp8-fast` default; configurable)
  3. write via commit RPC (changesets, not pushes)
  4. land via `/land` (CAS + post-merge checks)
- **Tools** given to the agent are exactly the RPC surface — the same comprehensiveness Scion notes ("a comprehensive source control service can power many novel applications"): `read_file`, `list_dir`, `file_history`, `blame`, `diff`, `grep` (server-side over changed_paths + blobs), `commit`, `land`.
- **Superfans** (per the article's ops practice): long-lived monitoring agents per component (commit path, import pipeline, queues) reading telemetry and flagging anomalies.

## 5. Scaling notes

- Workers scale horizontally by construction; all data content-addressed → any isolate can serve any read.
- D1 is the only stateful tier; changeset inserts are append-only and cheap; refs are DO-serialized (by design, they're rare).
- R2 = zero-egress blob store; trees/blobs fetched recursively by clients, batched via `fetch-objects`.
- No packfiles ⇒ no repo maintenance, no mirrors, no seeds.
- Cache layers (Cache API on Workers for hot trees/blobs) can be inserted transparently later because objects are immutable.

## 6. Repo layout

```
src/
  index.ts              # Worker entry, Hono app mount
  api/                  # RPC route handlers
  core/                 # changesets, trees, blobs, refs, derived data
  db/                   # D1 schema + migrations + query helpers
  auth/                 # OAuth, sessions, GitHub App, RBAC
  bridge/               # git import/export
  agents/               # Agents SDK runtime, tools, Workers AI loop
  dashboard/            # React (assets binding) — repo browser, diff, blame, tasks
worker/                 # wrangler config, bindings
cli/                      # yag thin client (sparse checkout, object cache)
test/                   # hermetic simulations, unit + e2e
docs/                   # architecture, api reference, deploy guide
```

## 7. Testing philosophy (from the article)

- **Hermetic simulations** of every non-trivial interaction: miniflare-backed D1/R2/DO/Queue fakes in vitest; no network.
- Deterministic fuzzing of the commit graph (random DAGs → verify ancestry/merge-base/blame invariants).
- Contract tests: every RPC has a schema-validated request/response fixture.
- CI: `vitest` + `wrangler deploy --dry-run` on every PR.
