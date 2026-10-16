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

| Caller                                       | Answer                                        |
| -------------------------------------------- | --------------------------------------------- |
| No credentials (public repos included)       | `401` with `WWW-Authenticate: Basic`          |
| Cannot read the repository                   | `404`, the same as a missing repository       |
| Can read but not write, pushing              | `403`                                         |
| A path rule hides any part of the repository | `ERR path_restricted` (the path is not named) |

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
`git-receive` queue is not built yet.

Not supported yet: annotated tag objects (push a lightweight tag), submodules,
a commit that replaces a file with a directory of the same name (or the
reverse), empty commit messages, and commits touching more than 5,000 files.

## Testing

- `npm test -w worker -- test/git-upload-pack.test.ts test/git-receive-pack.test.ts test/fuzz`
- `YAG_GIT_SMOKE=1 npm test -w yag` runs stock `git` against `wrangler dev`
  with a throwaway local store (`cli/test/git-http.test.ts`): clone,
  incremental fetch, `--depth 1`, `--filter=blob:none`, pushes of new and merge
  commits, a refused force push to the default branch, and identical SHAs in a
  fresh clone.
