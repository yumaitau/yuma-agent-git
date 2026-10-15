# GitHub capabilities and a Cloudflare implementation

Research date: 15 October 2026. Prices are USD and should be checked again before enabling paid execution. The target workload is Linux lint, tests, builds, and Docker image publishing. This implementation extends Yuma's existing immutable object store rather than introducing a second Git hosting service.

## Recommendation

Use the existing Worker, D1 and R2 for repository browsing and reviews, and ephemeral Cloudflare Containers for execution. Workers coordinate jobs; they cannot themselves run a Linux shell or Docker daemon. The native Durable Object Container API now provides process execution and lifecycle control, so a Sandbox SDK wrapper is unnecessary for this pipeline.

Keep GitHub available for import, authentication and upstream collaboration during migration. Moving CI does not require moving every repository at once. GitHub already supports free self-hosted runner usage; changing the execution backend alone can remove hosted-minute pressure. This implementation instead makes Yuma's native changesets and pull requests independent of Actions orchestration. It does **not** interpret `.github/workflows/*.yml` or register as a GitHub Actions runner.

## Capability comparison

| Area            | What GitHub supplies                                                                                                    | What is available here                                                                                                                    | Remaining work                                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| History         | Git commits, parent DAG, branches/tags, per-file history, blame, comparisons                                            | Existing SHA-256 changesets, parent links, tree/file/diff APIs, history and blame; new paginated history screen                           | Yuma changeset IDs are not Git commit IDs; Git wire compatibility remains a separate bridge            |
| Branches        | Arbitrary branches, protected branches, repository rulesets                                                             | Existing `main` and `release/...` refs; new default-branch protection through the shared ref lock                                         | Arbitrary feature branches, tags and GitHub ruleset parity                                             |
| Pull requests   | Drafts, descriptions, commits, file diffs, comments, reviewers, approvals/change requests, merge controls               | Draft/open/closed/merged PRs, merge-base diff, comments/approvals/change requests, revision-specific reviews, check requirements          | Inline threads, suggested changes, reviewer assignment, CODEOWNERS, notifications and reopening        |
| Merge           | Merge commit, squash, rebase, merge queue, conflict handling                                                            | Fast-forward only, expected head/base checks, approvals and current pipeline enforced before ref movement                                 | Conflict editor, automatic rebase/squash and merge queue                                               |
| Actions         | Workflow triggers, job DAGs, matrices, reusable workflows, marketplace actions, environments, secrets, artifacts/caches | Ordered commands in an isolated Linux VM; automatic checks on ready PR creation/head changes; manual run/retry/cancel; Docker publication | YAML/marketplace compatibility, matrices, schedules, deployment environments, general artifacts/caches |
| Runners         | Hosted Linux/Windows/macOS and self-hosted agents; autoscaling and ephemeral registration                               | One fresh Cloudflare Linux microVM per run; separate fresh publisher phase                                                                | Windows/macOS, GPUs and multi-architecture image builds                                                |
| Developer entry | Clone, local branch, push, PR, status checks                                                                            | `yag clone`, `yag commit`, `yag pr`, `yag ci run/status`; repository Code/History/PR/CI tabs                                              | Hosted CLI distribution, editor integration, automated rebase workflow                                 |
| Onboarding      | Repository templates, Actions starters, integrations                                                                    | Detect root Node/workspace/Docker projects; edit commands, choose reviews/time limit, save/run                                            | Rich language/toolchain detection and organization-wide templates                                      |

GitHub PR file comparisons use a **three-dot (merge-base) diff** to show what the topic branch introduces. Two-dot/direct comparisons show the two endpoint trees. Yuma's PR screen uses the existing merge-base diff API; merge admission additionally requires the recorded base to remain current and to be an ancestor of the proposed head. The history screen follows first parents, rather than drawing the full DAG.

Reviews are bound to a monotonically increasing PR revision. Changing the head or refreshing its base invalidates approvals, including when an earlier head is restored. The author cannot approve or block their own PR. Only reviewers who still have write membership count. Current-head CI must pass under the current pipeline version; changing pipeline configuration invalidates previous results. The default branch's direct-update API rejects moves when protection is enabled, including force moves. Admins can change this policy through the API.

## Execution and isolation

1. An admin saves a small, validated pipeline. A writer starts checks; opening a ready PR or changing its head also attempts to queue checks. Capacity/budget failures leave the PR intact and require a manual retry.
2. A single atomic D1 insertion reserves the full maximum compute estimate, prevents duplicate active runs for a repo/head, and admits at most two queued/running jobs across the deployment.
3. The Queue has batch size one, concurrency one, and no automatic job retries. A run-specific Durable Object claims the job once, stores a deadline and alarm, and starts its container.
4. Verified source objects are streamed into a fresh workspace. Commands run sequentially with shell failure propagation. Repository code receives no Cloudflare or registry credentials.
5. A publish request is admin-only, for the current default head at admission. It reruns the checks before building. Docker-in-Docker uses disabled iptables and `docker build --network=host`, as Cloudflare documents.
6. The image is exported to a bounded temporary R2 multipart object. The build VM is destroyed. A fresh publisher VM loads the image without running it, receives a registry password over stdin, and pushes `image:cs-<full-changeset-id>`. Destination authorization is an operator-owned repo-slug-to-image map. No `latest` tag is moved.
7. The VM is destroyed on success, failure, cancellation or deadline. A durable alarm, an in-process watchdog and a cron recovery sweep cover interruptions; platform failures can still delay cleanup. At-most-once claiming prevents Queue redelivery from rerunning scripts or publishing twice automatically.

Do not put secrets in pipeline commands or repository files: build output is visible to authorized repository readers. PR and CI surfaces require whole-repository path access, because arbitrary scripts and logs cannot safely expose only a path-filtered subset. Full-source CI is not offered to partial readers/writers. Public repositories therefore have public logs when no path policy prevents access. Registry passwords stay out of the build VM and publisher output is discarded.

The runner has internet access for package installation and publication. It is not an egress sandbox or a network spend limiter. Cache reuse is deliberately deferred until cache poisoning, isolation, retention and eviction are defined. The image includes Node 22, npm, Docker, Git, Python 3 and native build tools; projects needing other toolchains must provide them or use a Dockerfile. Linux amd64 is the initial target.

## Limits and cost controls

| Control                  | Initial value / behavior                                                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Compute admission budget | $5 per UTC month, shared by all repositories in this deployment                                                              |
| Outstanding jobs         | 2 total; Queue executes one at a time                                                                                        |
| Container admission      | At most 2 active jobs enforced in D1; no provider `max_instances` option in native mode; build/publish phases are sequential |
| Run deadline             | 30–600 seconds, default 300; includes startup, source transfer, checks, Docker export and publish                            |
| Reservation              | `(timeout_seconds + 30) × $0.000036`; never refunded after failure, cancellation or queue dispatch failure                   |
| Source                   | 32 MiB decoded, 2,000 files / bounded tree visits, depth 40; symlinks unsupported                                            |
| Image export             | 256 MiB; larger images fail instead of accumulating storage                                                                  |
| Logs                     | 512 KiB per run; overflow fails the job; completed logs retained seven days, removed by the minute cron in batches           |
| Queue expiry             | Undelivered jobs expire after 15 minutes; retry is explicit                                                                  |
| Execution switch         | `CI_ENABLED=false` by default                                                                                                |

The reservation is an **admission control, not a hard Cloudflare invoice cap**. It is conservative for the configured instance and normal shutdown, but excludes Workers, Durable Objects, D1, Queue, R2, container image storage, registry charges and network traffic. It is not billed metering. Cleanup delay, provider outages or future pricing changes can cause actual cost to differ. Set Cloudflare billing alerts and review actual usage before increasing concurrency. Retain run metadata to preserve the monthly ledger; do not delete it to reset the budget.

### Published rates and examples

Cloudflare Containers currently include 375 vCPU-minutes, 25 GiB-hours of memory and 200 GB-hours of disk monthly on the paid plan. Beyond those allowances, published rates are $0.000020/vCPU-second, $0.0000025/GiB-second of provisioned memory, and $0.00000007/GB-second of provisioned disk. CPU is active usage; allocated memory/disk are billed while the VM runs.

The chosen `standard-2` instance is 1 vCPU, 6 GiB memory, 12 GB disk:

`1 × 0.000020 + 6 × 0.0000025 + 12 × 0.00000007 = $0.00003584/second`

| Workload                  | Gross container compute before allowances | Admission reservation |
| ------------------------- | ----------------------------------------- | --------------------- |
| One 5-minute run          | $0.010752                                 | $0.01188              |
| 100 × 5-minute runs       | $1.0752                                   | $1.188                |
| 1,000 × 5-minute runs     | $10.752                                   | $11.88                |
| One maximum 10-minute run | $0.021504                                 | $0.02268              |

At a $5 reservation budget, the system admits at most 420 five-minute jobs in a UTC month (or 220 ten-minute jobs), including failures. A Docker publish is part of the same deadline, not an additional five-minute allowance. Actual compute can be lower when CPU is idle, but installation/network waits still consume allocated memory and disk time.

For comparison, GitHub's published Linux 2-core x64 hosted rate is $0.006/minute: 1,000 five-minute jobs would be $30 before included minutes. Linux 1-core is $0.002/minute and ARM 2-core is $0.005/minute. This is **not a performance-equivalent benchmark**: Cloudflare's chosen 1-vCPU instance may take longer than GitHub's 2-core runner, and cache availability can dominate installation time. GitHub standard public-repository hosted runners and self-hosted runner usage are free. Free accounts include 2,000 minutes, Pro/Team 3,000 and Enterprise Cloud 50,000; remaining quota and account aggregation matter more than the gross headline for small teams.

Other costs to model:

- Workers Paid starts at $5/month; if this app already uses that plan, it is not a new per-run fee.
- R2 Standard storage is $0.015/GB-month beyond the included 10 GB; operations are billed separately. R2 internet egress is free, which does not make container egress free.
- Queues includes one million operations monthly on Paid, then $0.40/million. A successful message normally uses write/read/delete operations; retries add work.
- Container egress is regional: published Oceania overage is $0.05/GB beyond 500 GB, North America/Europe $0.025/GB beyond 1 TB. Check account aggregation and destination charging in current docs.
- GHCR/Docker Hub/ECR registry storage, transfer and credentials have their own policies. ECR requires refreshing its short-lived registry authorization; this implementation does not provision AWS token refresh.
- D1 queries, Durable Object active duration/storage, Worker requests and Cloudflare container registry image storage remain separate. Each job keeps its coordinating DO active during execution; include this in pilot measurements.

## Alternatives and rollout

**GitHub with ephemeral self-hosted runners on Cloudflare:** preserves existing workflow syntax, Checks UI and PR rules while moving compute. Requires GitHub App registration tokens, workflow-job scheduling, runner bootstrap/teardown, external log persistence, private-repo/fork isolation and cleanup of offline registrations. GitHub recommends ephemeral runners for autoscaling. Container and action compatibility still needs testing; Windows/macOS jobs cannot move to Cloudflare Linux. This is a valid future compatibility bridge, not implemented by the native CI routes.

**Workers Builds:** appropriate for building/deploying Worker applications, but has its own build-minute model and does not replace repository history, reviews or arbitrary container publishing. Ordinary Workers isolates cannot run Docker. **An always-on self-hosted machine** may be cheaper for sustained workloads but introduces maintenance and shared-host isolation concerns; it is not the requested Cloudflare execution backend.

Roll out one small private Node repository first, then a small Docker image. Measure elapsed time, CPU, memory, egress and storage against the estimate. Verify failure, cancellation, deadline, duplicate delivery and registry isolation in the real Cloudflare account before enabling broader developer access. Keep GitHub's existing checks in place until the new execution path passes that pilot. No GitHub Actions workflows have been automatically disabled or redirected.

The Yuma production configuration now has CI enabled and real resource IDs; the base configuration keeps execution disabled. The [15 October pilot](deployment-smoke-2026-10-15.md) verified builds, failures, deadlines, cancellation and a registry push on Cloudflare. Temporary publishing credentials were removed afterward; permanent credentials/destination mapping must be supplied by an operator. These checks do not establish production recovery, hostile-workload security or actual billed cost. GitHub App sign-in and imports still need configuration and live verification.

## Primary sources

- [GitHub commit comparisons](https://docs.github.com/en/pull-requests/how-tos/commit-changes/comparing-commits)
- [About pull requests](https://docs.github.com/en/pull-requests/get-started/about-pull-requests)
- [Pull request reviews](https://docs.github.com/en/pull-requests/reference/pull-request-reviews)
- [Branches and protection](https://docs.github.com/en/pull-requests/reference/branches)
- [GitHub Actions billing and included usage](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
- [Actions limits](https://docs.github.com/en/actions/reference/limits)
- [Self-hosted runners](https://docs.github.com/en/actions/reference/runners/self-hosted-runners)
- [Reusable workflow configuration](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations)
- [Cloudflare Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/)
- [Cloudflare Containers limits](https://developers.cloudflare.com/containers/platform/limits/)
- [Native Durable Object Container API](https://developers.cloudflare.com/containers/api/durable-object-container/)
- [Cloudflare Sandbox Docker-in-Docker](https://developers.cloudflare.com/sandbox/sdk/guides/docker-in-docker/)
- [Cloudflare Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/)
- [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Cloudflare Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/)
