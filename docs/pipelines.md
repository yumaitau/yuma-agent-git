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
- `${{ secrets.NAME }}` and `${{ vars.NAME }}` in a step become `${NAME}`, a
  shell reference to the environment variable the runner sets, so values never
  enter the command text or the log. A referenced secret is requested for the
  job as if listed in `secrets`. No other expressions exist; nothing is
  evaluated.
- `timeout_seconds`: 30 to 600, 300 by default.
- `services`: up to 4 containers started with host networking before the steps,
  so a service listens on `localhost`.

Each job is one CI run: it reserves its own share of the monthly budget and
takes one of the two runner slots. Jobs wait when the slots are full or the
budget is spent, and are skipped after waiting an hour.

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
