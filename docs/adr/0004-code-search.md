# ADR 0004: Code search uses a trigram index in D1

- Status: Accepted
- Date: 2026-10-16
- Issue: #45 (epic #37, roadmap #23)

## Context

Issue #45 asks for code search across every repo a caller can read, by text,
regular expression, path and language, at the default branch and at any
changeset, with results that respect path rules, for people (dashboard) and
agents (MCP). The issue names this record `0003-code-search.md`; 0003 was
taken by the policy engine record when this landed, so it is 0004.

Facts the choice rests on:

- Blobs are content addressed (SHA-256 of the content, `core/blobs.ts`), so a
  blob needs indexing once, however many repos or revisions hold it.
- Every changeset records the files it changed relative to its first parent
  (`changed_files` with blob hashes), and a tree diff between two revisions
  recurses only into subtrees whose hashes differ (`core/diff.ts`). Index
  updates can therefore cost the change, not the repo.
- The derived-data framework (`core/derived.ts`) already gives cache-aside
  computation, a queue consumer with retries, deferral past a CPU or byte
  budget and terminal sentinels. Git IDs (#30) use it the same way.
- The agent `grep` tool scanned the first 500 entries of the `changed_paths`
  derived data. On a large repo that list is collapsed to directories or an
  oversize sentinel, so grep found nothing.
- The acceptance bar is a literal search across 50 fixture repos under 1 s at
  p95, with the index storage countable per org (#79).

## Options

**Trigram index in D1, built as derived data.** One postings table
`(gram, blob_hash)`, one row per indexed blob, and each repo's default-branch
file list. A query intersects the trigrams it needs, then reads and matches
only the candidate files, so results are exact. No new service; all reads go
through the same D1 and R2 bindings and the same RBAC.

**Trigram shards in R2 built by a queue consumer.** Cheaper storage per byte
and no D1 row limits, but every query then fetches and merges shard objects,
compaction has to rewrite shards, and per-org accounting means walking
objects. Worth it only past the size where D1 becomes the bottleneck.

**Zoekt in a Container.** A mature engine with ranking and symbol search.
Costs a long-running container per region, a second copy of every repo in
Zoekt's shard format, an indexing pipeline from R2 to the container and a way
to apply our path rules inside its results. It also adds a service that can
be down while the forge is up.

**Cloudflare Vectorize alongside a lexical index.** Useful for "find code
like this" questions, but it does not answer exact text or regex queries,
which is what the issue and the agent tools need. It can be added later on
top of whichever lexical index we pick.

## Scoring

| Criterion                                       | D1 trigrams          | R2 shards            | Zoekt container      | Vectorize          |
| ----------------------------------------------- | -------------------- | -------------------- | -------------------- | ------------------ |
| Exact text and regex                            | yes (verified reads) | yes (verified reads) | yes                  | no                 |
| New infrastructure                              | none                 | none                 | container + pipeline | index + embeddings |
| Incremental per changeset                       | yes, per new blob    | shard rewrites       | per repo reindex     | per new blob       |
| Path rules before content is read               | yes                  | yes                  | needs a filter layer | yes                |
| 50 repos, literal, p95 (miniflare)              | 38 ms (below)        | not measured         | not measured         | not applicable     |
| Per-org storage accounting                      | SQL over `grams`     | object listing       | container metrics    | per index          |
| Cost at very large scale (100k+ files per repo) | D1 row growth        | good                 | good                 | good               |

The figure is from `test/search.test.ts`: 50 repos, 20 searches after the
first builds the file lists, p95 38 ms and minimum 21 ms under
`@cloudflare/vitest-pool-workers` on Apple silicon. It has not been measured
against deployed D1, where each query adds network latency (a search issues
a fixed number of queries plus one R2 read per candidate file, 8 in flight).

## Decision

A trigram index in D1, built as the `code_search` derived kind
(`core/derived/codeSearch.ts`), queried by `core/search.ts`:

- **Incremental.** Key `<csId>` indexes the blobs a changeset added or
  changed that no earlier run indexed; a one-file changeset reads and indexes
  one blob. Changes of up to 8 files and 256 KiB index in the commit path;
  larger ones go to the existing `derived-data` queue (the issue suggested a
  separate `search-index` queue; reusing the framework's queue keeps one
  mechanism, its retries and its deferral, with no new queue to provision).
  A run reads at most 32 MiB, then defers and continues.
- **Backfill.** Key `full:<csId>` indexes every unindexed blob in a tree. The
  default-branch file list asks for it when it holds unindexed blobs, which
  covers history imported before the index existed.
- **Default-branch file lists** (`search_files`) follow each branch head by
  tree diff on the next search, under a compare-and-swap on the list's
  changeset so racing updates cannot interleave. Over 2000 changed files, or
  with no list yet, the list is rebuilt from the tree.
- **Compaction.** When a blob leaves every file list its postings are deleted.
  Searches at older revisions still find it by reading the blob.
- **Any revision.** `rev` searches the default-branch list with the tree diff
  to that revision laid over it (or the revision's whole tree when the diff is
  large). Files that are not indexed yet are read directly, within the read
  budget; when the budget runs out first the answer says `partial`.
- **Regex.** Required literals are read from the pattern conservatively (top
  level only, none under alternation); their trigrams narrow the candidates
  and every candidate is matched with the real regex. Limits: 200 characters,
  nested quantifiers refused, the first 1000 characters of a line, files up to
  1 MiB, 2000 files or 32 MiB read per search.
- **Access.** Each repo is decided with `can()` (`pathDecider`), and each file
  with its path rules before its content is read.
- **Case.** Trigrams are folded to ASCII lower case, matching how a JavaScript
  `i` regex without the `u` flag folds case. Non-ASCII trigrams narrow only
  case-sensitive searches.

## Consequences

- Search needs no new binding, container or queue, and works in
  `wrangler dev --local` and the test pool.
- D1 holds one row per distinct trigram per indexed blob (a few thousand for a
  typical source file). `search_blobs.grams` records each blob's rows, so
  index storage per org is a sum over the blobs its repos' file lists hold.
  Blobs are shared across orgs when their content is identical; #79 decides
  how shared rows are charged.
- The first search after a big branch move pays for the tree diff; a repo
  with more than 100,000 files is listed as skipped instead of searched.
- Ranking is by repo and path, not relevance.

## Review triggers

- D1 storage or query time for the postings table becomes a cost or latency
  problem in production traces (then move postings to R2 shards per repo).
- People or agents need symbol search or go-to-definition (out of scope for
  #45), which would favour Zoekt or a symbol index.
- Semantic search is asked for, which would add Vectorize next to this index.
