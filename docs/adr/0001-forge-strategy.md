# ADR 0001: Forge strategy

- Status: Accepted, without the planned spikes (see below)
- Date: 2026-10-16
- Issue: #25 (epic #23)

## Context

yuma-agent-git is a server-authoritative, content-addressed store modelled on
Anthropic's Scion: changesets in D1, SHA-256 blobs and canonical JSON trees in
R2, and one Durable Object per ref. Clients use the `yag` CLI, not `git`.
Replacing GitHub for Yuma needs Git wire compatibility as well as the
agent-scale RPC surface, because standard Git clients, IDEs, `gh`, CI runners
and Yuma Factory containers all speak Git.

Issue #25 laid out three paths and asked for a spike on each before choosing:

1. **Greenfield on the current core.** Build Git smart HTTP in the Worker on
   top of a stored changeset to Git object mapping.
2. **Fork Forgejo (or Gitea).** Mature Git hosting beside this Worker, with the
   agent RPC surface as an add-on. Go, SQL and filesystem storage, so it does not
   run on Workers. GPLv3+ from v9.
3. **Hybrid with Cloudflare Artifacts.** Git remotes on Cloudflare (upload-pack
   v1 and v2, receive-pack v1), synced to and from changesets. Documented limits
   of 1 GB per repository and 32 MB per file; usage billing from 14 Oct 2026.

## What was and was not done

The three spikes in #25 were **not run**. There are no measured CPU, memory,
cost or migration numbers for any option, and no files under
`docs/adr/spikes/`. On 2026-10-16 Justin directed the team to build out the
epic #23 features on the current core instead of waiting for the spikes. This
record writes that decision down so it is not mistaken for a measured one.

## Scoring

Qualitative only. Nothing here is measured; each cell is a judgement from the
sources in #25 and the current codebase.

| Criterion                  | Greenfield (current core)              | Forgejo fork                              | Artifacts hybrid                              |
| -------------------------- | -------------------------------------- | ----------------------------------------- | --------------------------------------------- |
| GitHub feature coverage    | Lowest today; everything is built here | Highest today (issues, PRs, CI, migrator) | Git transport only; the rest is built here    |
| Agent RPC fit              | Best: one store, Scion properties kept | Weakest: RPC beside a separate store      | Mixed: two stores kept in sync                |
| Australian residency (#68) | Same as the existing Worker, D1 and R2 | Runs wherever we host it                  | Depends on Artifacts placement (not checked)  |
| IRAP and ISM fit (#69)     | One codebase to assess                 | Large third-party codebase to assess      | Adds a Cloudflare service to assess           |
| Licence                    | Ours                                   | GPLv3+ obligations if modified and sold   | Proprietary service, our code stays ours      |
| Operating cost             | Not modelled                           | Not modelled (VM or containers)           | Not modelled (per-operation and storage fees) |
| Team effort to MVP         | Highest; pack parsing in a Worker      | Lowest for Git hosting, high to integrate | Medium; sync logic is the hard part           |
| Lock-in                    | Cloudflare platform                    | Low                                       | Cloudflare platform plus Artifacts limits     |

## Decision

Keep the Scion-style core and build Git wire support ourselves (greenfield).
Cloudflare Artifacts is the fallback if the greenfield Git protocol work stalls
or proves unsafe or too costly in a Worker. Forgejo is not pursued.

Work already landed on this path: deterministic Git commit, tree and blob ids
for every changeset (#30), and arbitrary branches, tags and agent work refs
(#33).

## Consequences

- #31 and #32 (Git protocol fetch and push) are built in this Worker, on the
  mapping from #30. They must apply directory path rules, because the object
  lookups in `worker/src/git/` do not.
- Pack parsing in a Worker is new attack surface and needs fuzzing and size
  limits before it is exposed.
- Imported history does not yet reproduce source Git SHAs (see #30 and #72), so
  round-trip parity with GitHub is not there yet.
- If the fallback is taken, #31 and #32 become "integrate Artifacts" tickets,
  and #34, #49, #68 and #79 need their cost and residency sections redone.

## Review triggers

Reopen this decision if any of these happen:

- The #31 or #32 work cannot serve a 200 MB repository within Worker CPU and
  memory limits.
- A security review of pack parsing finds issues we cannot contain in a Worker.
- The spikes from #25 are run and their numbers favour another option.
- Residency (#68) or IRAP (#69) rules exclude the current platform.
- Artifacts lifts its per-repository or per-file limits, or adds push over
  protocol v2.
