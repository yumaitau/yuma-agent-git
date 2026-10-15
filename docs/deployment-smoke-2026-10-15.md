# Yuma deployment and live smoke tests — 15 October 2026

Service: <https://yuma-agent-git-prod.yuma-it.workers.dev>

This is an early pilot, not a production-ready replacement for Git or GitHub.
Local tests did not establish deployment compatibility or end-to-end correctness.
The first real deployment and CLI smoke tests uncovered defects that were fixed
before proceeding.

## Resources

- Yuma IT account: `3eed46cc48f123cdff00d116df5e5070`.
- Worker: `yuma-agent-git-prod`.
- D1: `yag-db`, `3fb9a764-2131-46b5-827f-8d7626d26016`; migrations 0001–0009 applied.
- R2: `yag-objects`; `ci/images/` has one-day expiration and incomplete-upload cleanup.
- Queues: `ci-runs`, `derived-data`, `agent-jobs`, `git-import`.
- Native container application: `yuma-agent-git-cirunnerdo-prod`.
- A generated cache signing key is held in a Worker secret.
- Production compute admission budget: $5 per UTC month; this is not an invoice cap.

## Confirmed on the deployed service

- Health endpoint and dashboard assets.
- Read-only token write denial, repository-bound token isolation, and prevention
  of bearer-token escalation through session-only token management.
- Repository creation, commits, ref creation, exact file retrieval, and compressed
  tar export with matching file contents.
- The built CLI: clone, edit, commit, draft PR, and CI status.
- Draft merge denial, self-approval denial, direct protected ref denial,
  independent review, successful merge, and paginated commit history.
- CI-disabled requests fail closed before pilot enablement.

- Real Node lint/build and Docker image build, streamed logs, duplicate active-run
  rejection, and merge blocked until the exact proposed revision passed checks.
- Intentional command failure, 30-second deadline termination, and cancellation.
- Docker export to temporary R2 storage, destruction of the build VM, and a fresh
  publisher VM pushing the image to Yuma's Cloudflare registry.

### Run evidence

The final lifecycle pass ran after temporary registry bindings were removed,
against stable deployed code. All outcomes below matched expectations.

| Check                            | Run ID                                 | Outcome   |
| -------------------------------- | -------------------------------------- | --------- |
| Lint/build/Docker and merge gate | `4d62c1cd-ff33-4d78-9f05-f1f0be5c528a` | passed    |
| Intentional exit 7               | `d226aef7-f99c-47fb-9aaa-94d1d80d3531` | failed    |
| Deadline                         | `e18bc72e-4a92-4aaf-85f7-fb26fff88793` | timed_out |
| Cancellation                     | `5f1ebb7d-0d26-40d7-9332-7f3b81358fc4` | cancelled |
| Separate registry publication    | `535c001e-d537-423f-bdb4-790848c239ce` | passed    |

The registry image listing independently confirmed this exact artifact:

```text
registry.cloudflare.com/3eed46cc48f123cdff00d116df5e5070/yag-smoke-publisher:cs-4121c7ba470388d7415728a9936b36f02245e3d5e11bff13447a486b3401e555
```

Final provider inspection showed 12 container instance records, all `inactive`.
D1 contained zero smoke sessions and zero smoke API tokens. Worker secret names
were checked: only `CACHE_SIGNING_KEY` remained. The four temporary registry
bindings were removed, so permanent image publishing is not configured.
Health still returned `{"ok":true}` after cleanup.

Across all pilot attempts, including two startup failures and repeat checks, the
ledger held 12 runs: 4 passed, 4 failed, 2 timed out and 2 cancelled. Total reserved
compute was $0.054, not measured billed spend. Private generated repositories,
run records and the small published image remain as evidence. Job logs expire
after seven days; local JSON reports are not a permanent hosted artifact.

## Review and local validation

The final source, tests, configuration, scripts and documentation were reviewed.
Worker tests passed (227), CLI tests including the real Git smoke passed (11),
and Worker/CLI typechecks, repository lint, dashboard/CLI builds, the dashboard
bundle-size check, runner shell syntax and `git diff --check` passed. These checks
supplement the deployed tests; they do not establish the unverified properties below.

## Defects found during deployment

1. Scoped bearer tokens could be treated as browser sessions and gain broader
   privileges. Session identity is now separate, shared repository authorization
   enforces token limits, and repository listing respects a token's repository.
2. The initial ref-lock migration requested a new key-value Durable Object
   namespace, which Yuma's account rejects. Fresh deployments now use SQLite.
3. CLI commits did not advance local checkout state. Subsequent PRs referenced the
   old revision. Commits now save their uploaded snapshot, retain concurrent local
   edits as modified, and compare shared refs against the checked-out parent.
4. Docker's startup attempted to change read-only IP-forwarding settings in the
   Cloudflare VM. Runner startup now disables bridge/forwarding configuration and
   emits bounded startup diagnostics. Inner Docker commands use host networking.

## Reproducing the smoke test

Build the CLI first, then run through the Yuma credential wrapper:

```sh
npm run build -w yag
cf-vault python3 scripts/smoke-live.py \
  --url https://yuma-agent-git-prod.yuma-it.workers.dev \
  --database-id 3fb9a764-2131-46b5-827f-8d7626d26016 \
  --ci --report /tmp/yag-live-smoke.json
```

The harness seeds distinct fake smoke identities and one-hour session hashes
through the D1 administration API. Repository operations then use the deployed
HTTP API and real CLI. It revokes test sessions and API tokens on exit and attempts
to cancel unfinished jobs. Private `smoke/` repositories and CI accounting rows
remain as evidence; they contain only generated fixtures. The report contains no
credentials. Do not run the harness with `python -O`, which disables assertions.

Omit `--ci` only when testing a deployment with execution disabled. An optional
`--publish-image` and unique `--slug` exercise an image destination already
authorized by the operator; the harness does not install registry credentials.

## Still unverified

GitHub browser sign-in, App installation, and real repository imports need a
GitHub App configured for this service. Browser automation was unavailable in the
deployment session, so the seeded smoke identities do not constitute an OAuth test.

This pilot does not establish large-repository performance, production recovery,
full Git wire compatibility, automatic conflict resolution, or security under
arbitrary hostile workloads. Those require further work before replacing a team's
existing source-control system.
