# Git over HTTPS

Stock `git` can clone, fetch and push any repository (issues #31 and #32). The
code lives in `worker/src/git/`: `http.ts` (routes and auth), `upload-pack.ts`
(clone and fetch), `receive-pack.ts` and `pre-receive.ts` (push),
`pack-writer.ts`, `pack-reader.ts`, `zlib.ts` and `pktline.ts`.

```bash
git clone https://<host>/<owner>/<repo>.git
git clone --filter=blob:none https://<host>/<owner>/<repo>.git   # partial clone
git clone --depth 1 https://<host>/<owner>/<repo>.git            # shallow clone
```

## Authentication

Use an API token (`yag_…`, created in the dashboard or with `POST /api/v1/tokens`).

- HTTP Basic with the token as the password. Any username works, so
  `https://git:<token>@<host>/<owner>/<repo>.git` or a credential helper both
  do.
- `Authorization: Bearer <token>`, for example
  `git -c http.extraHeader="Authorization: Bearer <token>" clone …`.

Basic credentials are accepted only on the Git paths, never on `/api`.

| Caller                                          | Answer                                        |
| ----------------------------------------------- | --------------------------------------------- |
| No credentials (public repos included)          | `401` with `WWW-Authenticate: Basic`          |
| Cannot read the repository                      | `404`, the same as a missing repository       |
| Can read but not write, pushing                 | `403`                                         |
| A path rule hides any part of the repository    | `ERR path_restricted` (the path is not named) |
| Org enforces SSO the token was not minted under | `ERR sso_required` with where to sign in      |

A commit names its whole tree, so a caller with any read restriction cannot use
Git at all. Those callers use the `yag` CLI or the API, which filter by path.

Git traffic has its own rate-limit bucket, `git` (300 requests a minute per
principal).

## Protocol versions

Clone and fetch use Git protocol v2 only (`ls-refs` and `fetch`). Git 2.26 and
later use v2 by default. A v0 or v1 client gets
`remote error: this server speaks Git protocol v2 only`. Run
`git -c protocol.version=2 …` or upgrade Git.

Push uses the v0 receive-pack protocol, as Git does for every push.

## Clone and fetch

- `ls-refs` supports `symrefs`, `peel`, `ref-prefix` and `unborn`. `HEAD`
  points at the default branch. Agent work refs (`refs/agents/…`) are listed
  only when a `ref-prefix` asks for `refs/agents/`.
- `fetch` supports `want`, `have`, `done`, `shallow` and `deepen <n>` (so
  `--depth`, `--unshallow` and fetches into shallow clones work), and the
  filters `blob:none` and `tree:0`. `deepen-since`, `deepen-not` and
  `deepen-relative` are refused with a message. Wanting a blob or tree by ID
  works, which is how a partial clone fetches missing blobs.
- Negotiation: any `have` the repository knows is acknowledged and the server
  sends `ready`. The commit walk stops at the haves, so the pack is everything
  reachable from the wants that is not behind a have. History the client holds
  but did not name may be sent again, which costs bytes, not correctness.
- Packs are built on demand from changesets, R2 trees and blobs and the stored
  Git ID mapping (#30). Objects are undeltified and streamed one at a time
  with zlib from `CompressionStream`, then the SHA-1 trailer, so a pack is
  never held in memory.
- Clone pack cache (#78): a fetch that holds no history (no common `have`, no
  shallow commits) names immutable commits, so a pack of 1,000 objects or
  more is copied to R2 at `git/packs/<repo id>/<key>.pack` as it streams, keyed
  by the wants, `deepen` and filter. The next identical clone, CI checkouts
  included, streams that object back without reading a tree or blob. Only a
  complete pack is kept (up to 2 GiB). An R2 lifecycle rule expires them
  (docs/deploy.md).
- Git IDs are computed when a changeset is created. If a long history is still
  waiting for its IDs, the client gets
  `remote error: Git object IDs for this repository are still being computed`
  and the work is queued.

## Push

A push is checked in full before anything becomes visible:

1. The pack is parsed and verified: the trailing SHA-1, zlib streams, ofs-delta
   and ref-delta entries (thin-pack bases come from the repository), and every
   object's SHA-1.
2. Each update's new commits are diffed against their first parent.
3. Pre-receive checks run. Each rejection names the rule, and `git push`
   prints it:
   - `ruleset "<name>" <rule>`: a branch, tag or push ruleset (#41) refuses
     the update, for example `non_fast_forward`, `update` (pull request only;
     the CI policy's `protect_default` is now this rule in the "CI policy
     (default branch)" ruleset) or `max_file_size`. The ref-lock Durable
     Object applies the same rules again when the ref moves.
   - `protected_branch`: the default branch cannot be deleted or force pushed.
   - `path_rule <id>`: write is denied on a path the push changes, in a new
     commit or in the ref's net change.
   - `agent_ref`: `refs/agents/<id>/` belongs to that agent token.
   - `max_file_size`: a file over 25 MiB.
   - `unsafe_path`, `case_collision`, `submodule`: a `.git` path in any
     spelling, two names in one directory that differ only in case, or a
     submodule.
   - `secret_scanning`: a file the push adds or changes holds a secret (AWS,
     GitHub, Yuma, Cloudflare, Slack and Stripe tokens, private keys, and
     high-entropy values assigned to secret-looking names). The message names
     the detector, the file, the line and the commit. Secrets the file already
     held before the push do not count. A repository admin (never an agent)
     can push past it with `git push -o secret-scanning.bypass=<reason>`,
     where the reason is `false_positive`, `test_data` or `will_fix`, plus an
     optional `-o secret-scanning.comment=<text>`. Each bypass is audited as
     `secret_scanning.bypass` and raises an alert; only the SHA-256 of the
     secret and its location are stored. The commit RPC
     (`secret_scanning_bypass` in the body), the agent `commit` tool and
     applied review suggestions run the same detectors.
4. Changesets are created with `commitChanges`, parents first, keeping author,
   committer, time zones, extra headers and the signature. Each must rebuild to
   the pushed commit SHA, so a clone after a push returns identical SHAs; a
   commit that cannot round-trip is refused.
5. Each ref moves with one compare-and-swap through its ref-lock Durable
   Object. Two pushes racing for one branch cannot both land; the loser gets
   `ref_stale`. With `atomic`, a failed move puts back the refs already moved.
   Every moved ref is recorded in the audit log as `ref.move` with
   `via: "git-push"`.

Pushable refs are `refs/heads/*`, `refs/tags/*` (lightweight tags; existing
tags do not move) and `refs/agents/*`. Deleting refs is supported, except the
default branch.

### Limits

Packs are held in memory while they are checked, so a push is capped at 24 MiB
of pack data and 48 MiB inflated, 100,000 objects. Larger pushes get
`push too large`; push in smaller batches. Spilling large packs to R2 and a
`git-receive` queue is not built yet: the queue consumer has the same 128 MB
memory as the request, so it needs a pack reader that resolves deltas from R2
instead of memory first (#78, docs/performance.md).

Not supported yet: annotated tag objects (push a lightweight tag), submodules,
a commit that replaces a file with a directory of the same name (or the
reverse), empty commit messages, and commits touching more than 5,000 files.
The 5,000 cap (`MAX_CHANGED_FILES`, `core/changesets.ts`) exists because a
changeset row holds its whole file list and a D1 row is at most 2 MB; at about
150 bytes an entry, 5,000 entries stay well inside it. Import a larger first
commit as several commits.

## Git LFS

Large files work with stock `git lfs` (issue #35, `worker/src/git/lfs.ts`).
Git LFS finds the server at `<remote>/info/lfs` on its own and uses the same
credentials as Git.

- `POST …/info/lfs/objects/batch` answers `download` and `upload` with the
  `basic` transfer and `sha256` objects. Download needs read on the whole
  repository, upload needs write; the 401, 404, 403, `path_restricted` and
  `sso_required` answers match Git's, as JSON with a `message` Git LFS
  prints. Agent uploads go through the guardrails as a `push`.
- Each action carries an `Authorization: RemoteAuth …` header: an HMAC
  (keyed by `CACHE_SIGNING_KEY`) over the repository, operation, oid and size,
  valid for 15 minutes. Without `CACHE_SIGNING_KEY` the batch API answers 503.
- Transfers stream through the Worker into R2 at `lfs/<repo id>/<oid>`, the
  layout the GitHub importer (#72) writes. The upload is stored with the oid
  as R2's SHA-256 checksum and a fixed length, so a wrong hash or size stores
  nothing and links nothing. `lfs_objects` links each object to the
  repositories that uploaded or imported it.
- Quotas are checked when an upload is requested: `LFS_REPO_QUOTA_BYTES`
  (10 GiB) per repository and `LFS_ORG_QUOTA_BYTES` (100 GiB) per org. Over
  quota is `507 lfs_quota_exceeded`. `GET /api/v1/repos/:owner/:repo/lfs`
  reports objects, bytes and quotas; repository admins remove an object with
  `DELETE /api/v1/repos/:owner/:repo/lfs/objects/:oid`.
- Locks (`git lfs lock`, `unlock`, `locks`, and `locks/verify` on push): write
  to lock, read to list. Unlocking someone else's lock needs admin and
  `--force`. Locks are advisory: pushes are not refused for them.

Single objects are limited by the Worker request body limit of the account's
plan (100 MB on most plans); presigned R2 URLs that skip the Worker need R2
S3 credentials and are not built.

## Forks

`POST /api/v1/repos/:owner/:repo/forks` (issue #36, `worker/src/api/forks.ts`)
creates `<login>/<name>` (or `slug`) with the upstream's visibility, its
branches and tags, and nothing else. A fork's id starts with its network
root's id (`worker/src/core/network.ts`), and content (changesets, trees,
blobs, Git IDs, derived data, LFS objects) is stored under the root, so
forking costs the same for any size of repository and clones of a fork work
straight away.

Content addresses are shared across a network, as on GitHub: anyone who can
read one repository in a network can read any object of the network by its
id. Listings, clones and pull requests only start from refs the caller can
read.

A pull request from a fork names it: `POST …/pulls` with `head_repo` and a
`head_cs` some branch or tag of that fork points at. Read on the upstream is
enough. CI for such a pull request runs as a fork: no secrets, variables,
OIDC tokens, environments or trusted self-hosted runners, and its job caches
belong to the pull request (`refs/pull/<n>`): it reads the default branch's
but never writes them. When the author cannot write to the upstream, built-in
agent reviewers (#60) wait until a writer requests them with
`PUT …/pulls/:id/reviewers`; other agent reviewers are asked with `fork: true`.
Updating a fork pull request's head still needs write on the upstream.

## Testing

- `npm test -w worker -- test/git-upload-pack.test.ts test/git-receive-pack.test.ts test/fuzz`
- `npm test -w worker -- test/lfs.test.ts test/forks.test.ts`
- `YAG_GIT_SMOKE=1 npm test -w yag` runs stock `git` against `wrangler dev`
  with a throwaway local store (`cli/test/git-http.test.ts`): clone,
  incremental fetch, `--depth 1`, `--filter=blob:none`, pushes of new and merge
  commits, a refused force push to the default branch, and identical SHAs in a
  fresh clone.
