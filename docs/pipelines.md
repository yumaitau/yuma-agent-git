# Pipelines (spec v2)

Pipelines live in the repository as `.yuma/pipelines/*.yml` (or `.yaml`), so a
change to a pipeline is reviewed like any other change. A repository without
spec files keeps the pipeline saved on the CI settings page.

```yaml
name: ci
on:
  push:
    branches: [main, 'release/*']
    paths: ['src/**', 'package.json']
  pull_request:
    branches: [main]
  manual:
  schedule:
    - cron: '0 3 * * *'
      timezone: Australia/Sydney
concurrency:
  group: ci-${{ ref }}
  cancel_in_progress: true
jobs:
  lint:
    steps:
      - run: npm ci && npm run lint
  test:
    matrix:
      node: [20, 22]
    steps:
      - run: npx -y node@${{ matrix.node }} --version
      - run: npm ci && npm test
  build:
    needs: [lint, test]
    timeout_seconds: 300
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: ci
    steps:
      - run: npm ci && npm run build
```

## Triggers

| Trigger        | When it runs                                                                                                                                                                 |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `push`         | After `git push` or a pull request merge moves a branch or tag. `branches`, `tags` and `paths` filter it; a filter on only branches leaves tags out and the other way round. |
| `pull_request` | When a pull request opens, leaves draft or gets a new revision. `branches` matches the target branch; `paths` matches the pull request's changes.                            |
| `manual`       | `POST /api/v1/repos/:repo/ci/pipelines/runs` with `{ "pipeline": ".yuma/pipelines/ci.yml", "head": "<rev>" }`.                                                               |
| `schedule`     | Five-field cron on the default branch, read in `timezone` (any IANA zone, `UTC` by default). The minute cron starts it at most a minute late.                                |

`on: push` and `on: [push, manual]` are short forms. Globs: `*` and `?` stay in
one path segment, `**` crosses segments.

A pull request runs the spec in its own revision, so pipeline changes run
before they merge. Results belong to a revision: a new revision needs new runs.

Pushes from a member whose path rules restrict any part of the repository do not
start pipelines, because a job reads the whole tree. Agent refs never trigger.

## Jobs

- `steps`: 1 to 8 `run` commands, run in order with `bash -euo pipefail` in a
  fresh Linux runner (the same container runner as settings pipelines).
- `needs`: job names that must pass first. A job whose needs did not pass is
  skipped. Cycles and unknown names are errors.
- `matrix`: one job per combination, named like `test (20)`. At most 8 per job
  and 16 jobs per pipeline. `${{ matrix.<axis> }}` in a step is replaced with the
  value.
- `matrix: { shard: N }`: N copies of the job, named `test (1/N)` to
  `test (N/N)`, each with `YAG_SHARD_INDEX` (1-based) and `YAG_SHARD_TOTAL` set,
  for example `npx vitest run --shard=$YAG_SHARD_INDEX/$YAG_SHARD_TOTAL`. `shard`
  is the only axis that takes a number; it combines with other axes.
- `${{ secrets.NAME }}` and `${{ vars.NAME }}` in a step become `${NAME}`, a
  shell reference to the environment variable the runner sets, so values never
  enter the command text or the log. A referenced secret is requested for the
  job as if listed in `secrets`. No other expressions exist; nothing is
  evaluated.
- `timeout_seconds`: 30 up to 6 hours, 300 by default, within the pool's
  `max_timeout_s`. Built-in Cloudflare jobs stay at 600 seconds at most (a job
  runs inside one queue consumer call); longer jobs need a self-hosted runner.
- `services`: up to 4 containers started with host networking before the steps,
  so a service listens on `localhost`.
- `runs-on`: labels a self-hosted runner must all carry, such as
  `[macos, arm64]`. Without it (or with `cloudflare`) the job runs on the
  built-in container pool. `[cloudflare, standard-4]` picks a Cloudflare
  instance type: `standard-1` (1/2 vCPU, 4 GiB), `standard-2` (the default,
  1 vCPU, 6 GiB), `standard-3` (2 vCPU, 8 GiB) or `standard-4` (4 vCPU,
  12 GiB), if the org's pool allows it. See `docs/runner-protocol.md`.

## Capacity

Each built-in job is one CI run in its pool's admission ledger. An org that a
CI admin (`CI_ADMIN_USER_IDS`) gave limits with
`PUT /api/v1/orgs/:org/ci/limits` has its own pool: `max_concurrent` job slots,
a `monthly_budget_usd`, `max_timeout_s` and the allowed `instance_types`.
Every other repository shares the deployment pool: two slots,
`CI_MONTHLY_BUDGET_USD`, 600 seconds and `standard-2`. Pools never hold each
other back. A job reserves `(timeout_seconds + 30)` seconds at its instance
type's full-CPU rate (36 micro-dollars a second for `standard-2`, 112 for
`standard-4`); reservations are never refunded. Jobs wait when their pool's
slots are full or its budget is spent, and are skipped after waiting an hour.
When a slot frees, the repository with the fewest queued or running jobs goes
first, so one busy repository cannot take every slot.

A job over its pool's limits (instance type or timeout) fails the pipeline at
plan time with a line-1 error. The first admission past 50%, 80% and 100% of a
pool's monthly budget writes a `ci.budget.alert` audit event to the org's
chain, once per month each. The ledger is admission control, not a billing
cap: check real Cloudflare usage and keep account billing alerts.

## Artifacts and caches

Every job gets `YAG_RUNTIME_URL` (`<origin>/runner/v1/jobs/<id>`) and
`YAG_RUNTIME_TOKEN`, valid while it runs (scheduled built-in runs have no
request origin, so they get neither):

```sh
# artifacts: shared by every job of the run, kept 14 days, 100 MiB and 20 per job
curl -fsS -X PUT -H "authorization: Bearer $YAG_RUNTIME_TOKEN" \
  --data-binary @report.xml "$YAG_RUNTIME_URL/artifacts/report.xml"
curl -fsS -H "authorization: Bearer $YAG_RUNTIME_TOKEN" \
  "$YAG_RUNTIME_URL/artifacts/report.xml" -o report.xml
# caches: restore (204 on a miss), else reserve and upload once
curl -fsS -H "authorization: Bearer $YAG_RUNTIME_TOKEN" \
  "$YAG_RUNTIME_URL/caches?key=npm-$HASH&restore_keys=npm-" -o cache.tgz
```

Another job of the run cannot replace an artifact's name. People with read
access list a run's artifacts on the CI page and download them from
`/api/v1/repos/:repo/ci/artifacts/:id`.

A cache entry is immutable and belongs to the scope its job ran for: the
branch or tag, `refs/pull/<n>` for every pull request job (whatever ref it
carries), the merge queue ref, or the revision. A job writes only its own
scope and reads its own, then the default branch's: so a pull request can
never write an entry a `main` job reads. A restore tries the exact key, then
each restore key as a prefix (newest first), in that order of scopes. Entries
unused for 7 days are swept, and each repository stays under its pool's
`cache_quota_bytes` (10 GiB shared) by evicting the least recently used.
Repository admins delete entries from `DELETE /api/v1/repos/:repo/ci/caches/:id`.

## Secrets, environments and cloud identity

Each job opts in to credentials on its own ([details](ci-oidc-aws.md)):

- `secrets: [NAME, ...]`: secrets set as environment variables (environment,
  then repository, then org value). Variables of the same scopes are always set.
- `environment: <name>`: the job waits at that environment's gate before it
  starts. Its branch rules and people-only flag skip the job when they refuse
  the trigger; required reviewers and a wait timer hold it as "waiting" with an
  approval request, and a rejection or expiry (7 days) skips it. Once approved
  it gets the environment's secrets and variables.
- `permissions: { id_token: write }`: a per-job request token for OIDC ID
  tokens. `sub` is `repo:<owner>/<repo>:environment:<env>` for a job with an
  environment, otherwise from the pipeline's trigger (`ref:refs/heads/main`,
  `ref:refs/tags/v1`, `pull_request`), and `job` names the job.
- `permissions: { packages: write }`: a login for the forge's package registry
  in `YAG_REGISTRY`, `YAG_REGISTRY_USERNAME` and `YAG_REGISTRY_PASSWORD`, for
  `helm push`, `docker push` or `npm publish` to the job's own repository
  (docs/registry.md). The two permissions combine.
- `aws: { role_arn, region, session_name? }` (needs `id_token: write`): an AWS
  web identity token file and `AWS_*` variables, so the AWS CLI, Helm and
  kubectl in the runner image assume the role without keys.

A pipeline started by an API or agent token (#57), including a `git push`
(which signs in with a token), records `actor_kind: agent`; an environment with
people only skips its jobs, so start those deploys from the dashboard. Pull requests from authors
without write access get nothing. Scheduled pipelines run as `system` and need
`CI_OIDC_ISSUER` for ID tokens.

Build a Helm chart, push it to ECR, then deploy it to EKS after a production
reviewer approves:

```yaml
name: deploy
on:
  push:
    branches: [main]
  manual:
jobs:
  chart:
    permissions: { id_token: write }
    aws:
      role_arn: arn:aws:iam::123456789012:role/yag-chart-push
      region: ap-southeast-2
    steps:
      - run: aws ecr get-login-password | helm registry login --username AWS --password-stdin ${{ vars.ECR_REGISTRY }}
      - run: helm package charts/app -d dist && helm push dist/app-*.tgz oci://${{ vars.ECR_REGISTRY }}/charts
  deploy:
    needs: chart
    environment: production
    permissions: { id_token: write }
    aws:
      role_arn: arn:aws:iam::123456789012:role/yag-deploy
      region: ap-southeast-2
    steps:
      - run: aws eks update-kubeconfig --name prod
      - run: helm upgrade --install app oci://${{ vars.ECR_REGISTRY }}/charts/app -n myapp --wait --set-string monitoring.apiKey=${{ secrets.MONITORING_API_KEY }}
```

`chart` assumes `yag-chart-push` with `sub = repo:acme/app:ref:refs/heads/main`.
`deploy` waits for a `production` reviewer, then assumes `yag-deploy` with
`sub = repo:acme/app:environment:production`.

## Concurrency

`concurrency.group` names a group in the repository; `${{ ref }}` is replaced
with the branch, tag or `pull/<id>`. With `cancel_in_progress`, a new run cancels
older unfinished runs in the group. Without it, the new run waits for them.

## Checks and merging

Every job is a check named by its key. When pipelines ran on a pull request's
revision, the latest run of each pipeline file must pass before merging (with the
settings `require_checks`, on by default). A configured settings pipeline still
runs on every pull request and must pass too: pipeline files come from the pull
request, so they add checks but never replace the CI policy.

## Errors

A file that is not valid YAML or does not match the schema records a failed run
with errors such as `.yuma/pipelines/ci.yml:4:13 jobs.a.needs.0: Unknown job
"tset"`. They show in the pull request's checks panel, on the CI page and in
`git push` output.

## Not supported yet

Reusable `uses` steps, per-job runner labels, manual inputs, merge group and
path-ignore filters, and retrying a single pipeline job (start the pipeline
again). Branch moves through the API (`PUT /refs`, agent land) do
not start `push` pipelines.

## GitHub Actions workflows

Repositories that still have `.github/workflows` files can check how they
translate to this spec, and opt in to running them until they move to
`.yuma/pipelines`. See [actions-compat.md](actions-compat.md).
