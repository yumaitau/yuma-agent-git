# GitHub Actions compatibility

Issue #49. The forge reads `.github/workflows/*.yml` (and `.yaml`), translates
each file into a [pipeline spec v2](pipelines.md) and reports what changes on
the way. This is a translation path, not an Actions runner: it is not fully
compatible, and the gaps are listed below. Nothing is ever fetched from
github.com; actions the translator knows become shell steps or job settings,
and any other `uses:` makes the workflow unsupported.

## The report

Each workflow gets one status:

| Status        | Meaning                                                                             |
| ------------- | ----------------------------------------------------------------------------------- |
| `supported`   | Runs as written, with the same behaviour.                                           |
| `translated`  | Runs, but something behaves differently. Each difference is listed with its line.   |
| `unsupported` | Cannot run until it is edited. Each reason is listed with its line and what to use. |

Ways to read it:

- `yag actions check` in a checkout sends the local `.github/workflows` files to
  `POST /api/v1/ci/actions/check` (nothing is stored). `yag ci analyse` is the
  same command.
- `yag actions check --repo owner/name [--head <rev>]` and
  `GET /api/v1/repos/:repo/ci/actions?head=<rev>` report a repository's own
  files (default branch when `head` is left out). Readers of the whole
  repository can see it.
- MCP tool `ci_actions_report`.

Each command exits 1 when any workflow is unsupported. The report also carries
the translated pipeline YAML, which can be committed to `.yuma/pipelines/` as a
starting point.

## Running translated workflows

Off by default. A repository admin turns it on with
`PUT /api/v1/repos/:repo/ci/actions` and `{ "enabled": true }` (audited as
`ci.actions.update`; agents are never repository admins, so they cannot). While
it is on and the revision has no `.yuma/pipelines` files, CI loads the
translated workflows in their place: push, pull request, merge group,
schedule and manual (`workflow_dispatch`, started with
`POST /api/v1/repos/:repo/ci/pipelines/runs` and the workflow path) triggers
all work as for pipelines. An unsupported workflow records a failed run with its
reasons, as a broken pipeline file does. Once `.yuma/pipelines` files exist,
they run instead and the workflows stop.

The default agent policy already holds agent changes to `.github/workflows/**`
for a human approval (rule `ci-workflows`). An org policy that drops that rule
should cover the path another way: `pipeline.edit` matches only
`.yuma/pipelines/**`.

Jobs of translated workflows get these variables from forge data:
`GITHUB_ACTIONS`, `GITHUB_WORKFLOW`, `GITHUB_SHA` (empty until the Git commit id
is known), `GITHUB_REF`, `GITHUB_REF_NAME`, `GITHUB_REF_TYPE`,
`GITHUB_REPOSITORY`, `GITHUB_REPOSITORY_OWNER`, `GITHUB_EVENT_NAME`,
`GITHUB_ACTOR`, `GITHUB_RUN_ID`, `GITHUB_JOB`, `GITHUB_SERVER_URL`, and
`GITHUB_WORKSPACE` where a step uses it. They hold no secrets, so untrusted runs
get them too. Jobs of `.yuma` pipelines get none.

## What translates

| Workflow                                                                       | Pipeline                                                                                                            |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `on: push` (`branches`, `tags`, `paths`), `pull_request` (`branches`, `paths`) | Same triggers. `types` are ignored (translated).                                                                    |
| `on: workflow_dispatch`, `schedule`, `merge_group`                             | `manual` (inputs are not passed), `schedule` in UTC, `merge_group`.                                                 |
| `jobs.<id>.needs`, `strategy.matrix` (lists of values)                         | `needs`, `matrix` (8 jobs at most per matrix, 16 per pipeline).                                                     |
| `env` at workflow, job and step level                                          | `export` lines at the top of each step.                                                                             |
| `if:` on jobs and steps                                                        | A shell test at the top of each step. See [conditions](#conditions).                                                |
| `runs-on: ubuntu-latest` or `ubuntu-NN.04`                                     | The built-in Linux pool (translated: Debian bookworm with Node.js 22, python3, Docker, git, aws, helm and kubectl). |
| `runs-on: [self-hosted, ...]`                                                  | The same labels, lower case, for self-hosted runners (#48).                                                         |
| `services` with `image` and `env`                                              | `services` on the job network: connect to `localhost` on the container port. `options` (health checks) are ignored. |
| `permissions: id-token: write`, `packages: write`                              | The same job permissions (#50, #53). Other scopes do nothing: jobs get no forge token.                              |
| `environment`                                                                  | `environment` with its protection rules (#50). The URL is not shown.                                                |
| `${{ secrets.X }}`, `${{ vars.X }}`, `${{ matrix.x }}`                         | Pipeline expressions: secrets and variables reach the script as `${X}`.                                             |
| `${{ env.X }}`, `${{ github.<key> }}` for the variables above                  | `${X}` and `${GITHUB_*}` shell references.                                                                          |
| `timeout-minutes`                                                              | `timeout_seconds`, at most 10 minutes. Jobs without one stop after 10 minutes, not GitHub's 6 hours.                |
| `defaults.run.working-directory`, `working-directory`, `shell: bash` or `sh`   | `cd` and bash options as GitHub sets them (`sh` runs with bash).                                                    |
| `continue-on-error: true` on a step                                            | The step stops at its first failure and the job goes on.                                                            |
| `concurrency` with `github.workflow`, `github.ref` or `github.ref_name`        | Workflow `concurrency`. Other groups are dropped (translated).                                                      |
| More than 8 steps in a job                                                     | Neighbouring steps run together, each in its own subshell, up to 2000 characters per pipeline step (translated).    |

### Actions

| Action                                            | Becomes                                                                                                                                                                                 |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `actions/checkout`                                | Nothing: the runner checks out the revision. `fetch-depth`, `submodules`, `lfs` are ignored; `repository`, `ref` and `path` are unsupported.                                            |
| `actions/setup-node`                              | Nothing: the runner's Node.js (22 on the built-in pool). Another version or `cache` is translated; `registry-url` is unsupported.                                                       |
| `actions/setup-python`                            | Nothing: the runner's `python3` (3.11 on the built-in pool, without pip).                                                                                                               |
| `pnpm/action-setup`                               | `npm install -g pnpm@<version>` or `corepack enable pnpm`, then `pnpm install` with `run_install: true`.                                                                                |
| `actions/cache` (and `/restore`, `/save`)         | The job's cache (#51): restore where the step is, save after the job's steps pass. `key` and `restore-keys` may use `hashFiles()` and `runner.os`; `path` must be plain paths or globs. |
| `actions/upload-artifact`                         | A run artifact (#51) holding one `.tar.gz` of `path` (one directory or file is its root), kept 14 days. `if-no-files-found` is honoured.                                                |
| `actions/download-artifact`                       | One named artifact of the same run (#51), unpacked into `path`. `pattern`, `merge-multiple` and `run-id` are unsupported.                                                               |
| `github/codeql-action/upload-sarif`               | The forge's code scanning upload (#67) for one `sarif_file`, with `category`. Needs `security-events: write`.                                                                           |
| `aws-actions/configure-aws-credentials`           | The job's `aws` block (#50): a forge-issued OIDC web identity token for the whole job. Needs `id-token: write` and a literal role and region (or `env`).                                |
| `docker/login-action`                             | `docker login --password-stdin`; for Amazon ECR without a password, `aws ecr get-login-password` with the job's role.                                                                   |
| `docker/setup-buildx-action`, `setup-qemu-action` | Nothing: images build with plain `docker build`.                                                                                                                                        |
| `docker/build-push-action`                        | `docker build` with `file`, `tags`, `build-args`, `labels`, `target`, then `docker push` per tag when `push: true`. Only `linux/amd64`.                                                 |
| `azure/setup-helm`                                | Nothing: the runner's helm (v3.22.0 on the built-in pool).                                                                                                                              |

### Conditions

`==`, `!=`, `!`, `&&`, `||`, brackets, string, number and boolean literals,
contexts with an equivalent, and `success()`, `startsWith()`, `endsWith()` and
`contains()` on strings. Comparisons are case-sensitive here (GitHub ignores
case). A failed step ends the job, so `always()` is true while earlier steps
pass and `failure()` and `cancelled()` steps never run (both translated). A job
`if:` that is false skips the job's steps, and jobs that need it still run.

## Gaps

Unsupported, with the reason in the report:

- Any action not listed above, including `aquasecurity/trivy-action`,
  other `github/codeql-action/*` actions, `dtolnay/rust-toolchain` and local, composite and
  Docker actions. Replace them with `run` steps. There is no vetted action
  mirror yet, so third-party action code never runs (and never sees secrets).
- Reusable workflows (`jobs.<id>.uses`, `workflow_call`), `pull_request_target`
  (runs untrusted code with secrets) and other events (the workflow does not
  run for them).
- GitHub-hosted macOS, Windows and arm64 runners: register a self-hosted runner
  and use its labels. GitHub adds `self-hosted`, the OS and the architecture to
  every self-hosted runner; register forge runners with those labels too if
  workflows ask for them.
- `container:`, `matrix.include` and `matrix.exclude`, matrix values from
  expressions, job `continue-on-error`, `paths-ignore`, `branches-ignore` and
  negated patterns, shells other than bash and sh.
- Expressions without an equivalent: `github.event.*`, `github.head_ref`,
  `github.token`, `inputs.*`, `steps.*`, `needs.*.outputs`, `fromJSON()`, and
  `hashFiles()` outside cache keys. Writes to `$GITHUB_ENV` and `$GITHUB_PATH` do not reach later
  steps; `$GITHUB_OUTPUT` and `$GITHUB_STEP_SUMMARY` writes are discarded.
- Static AWS keys in `configure-aws-credentials`, role chaining, and more than
  one AWS role per job.

Other differences to know about:

- `${{ secrets.GITHUB_TOKEN }}` is not issued: store a forge token as the
  repository secret `GITHUB_TOKEN` (the report flags each use).
- Expressions become shell variables, so inside single quotes they no longer
  expand as GitHub's text substitution would.
- The `github` context is limited to the variables above.
- Artifacts and caches use the forge's job routes (`YAG_RUNTIME_URL`), not
  GitHub's artifact v4 and cache protocols. Scheduled built-in runs have no
  `YAG_RUNTIME_URL`: their artifact steps fail and their caches are skipped.
