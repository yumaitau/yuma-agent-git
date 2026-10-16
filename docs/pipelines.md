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
  value. No other expressions exist; nothing is evaluated.
- `timeout_seconds`: 30 to 600, 300 by default.
- `services`: up to 4 containers started with host networking before the steps,
  so a service listens on `localhost`.

Each job is one CI run: it reserves its own share of the monthly budget and
takes one of the two runner slots. Jobs wait when the slots are full or the
budget is spent, and are skipped after waiting an hour.

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
path-ignore filters. Branch moves through the API (`PUT /refs`, agent land) do
not start `push` pipelines.
