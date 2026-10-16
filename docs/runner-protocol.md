# Runner protocol and self-hosted runners

Issue #48. Pipeline jobs run on a pool of runners picked by labels. The
built-in Cloudflare container pool stays the default for Linux x64, and Yuma's
own Linux, arm64 and macOS machines can register as long-lived or ephemeral
runners that pull jobs over HTTPS. A runner only makes outbound requests, so it
works behind NAT.

## Routing with `runs-on`

```yaml
jobs:
  test:
    runs-on: [linux, x64] # every label must be on the runner
    steps:
      - run: npm ci && npm test
  ios:
    runs-on: [macos, arm64, xcode-16]
    steps:
      - run: swift build && swift test
  lint:
    steps: # no runs-on: the built-in Cloudflare pool
      - run: npm run lint
```

- No `runs-on`, or a `runs-on` that names `cloudflare`, runs on the built-in
  pool. That pool only carries `cloudflare`, `linux` and `x64`.
- Any other `runs-on` waits for a self-hosted runner in the repo's org (or
  registered on the repo) whose labels include all of the job's labels. Labels
  are lower case: letters, digits, `.`, `_` and `-`, 10 at most.
- A self-hosted job does not use the Cloudflare budget or the two built-in
  slots. A job no runner takes within an hour fails with
  `No runner with matching labels took this job within an hour`.

## Decision: our own JSON protocol, not `actions-proto`

Gitea's `act_runner` speaks Connect RPC (`actions-proto`): `Register`,
`FetchTask`, `UpdateTask`, `UpdateLog`. We copied its shape (one-time token,
long-poll fetch, log and state updates) but not its wire format, because:

- `FetchTask` hands the runner a GitHub Actions workflow and `github` context
  for `nektos/act` to execute. Our jobs are spec v2 steps, not Actions
  workflows, so an `act_runner` could not run them without the Actions
  compatibility path (#49).
- Connect with protobuf would add a code generator and a binary codec to the
  Worker for no gain to our own runner.

If #49 adopts `act`, a thin Connect adapter can map `FetchTask` to
`jobs/claim`, `UpdateLog` to `logs` and `UpdateTask` to `steps` and
`complete`. Nothing in this protocol blocks that.

## Registration

1. An org owner or admin (`POST /api/v1/orgs/:org/runners/registration-token`)
   or a repo admin (`POST /api/v1/repos/:repo/runners/registration-token`)
   creates a one-time token, `yagreg_…`, valid for an hour. It needs a browser
   session and a recent MFA step-up when the person has a factor enrolled.
   `{ "trusted_only": true }` makes the runner trusted-only.
2. The runner trades it for its own credential:

   ```http
   POST /runner/v1/register
   { "token": "yagreg_…", "name": "mac-mini-1", "labels": ["macos", "arm64"],
     "ephemeral": true, "capabilities": { "os": "darwin", "arch": "arm64", "version": "0.1.0" } }
   → 201 { "runner": { "id": "…", "name": "…", "labels": […] }, "credential": "yagrun_…" }
   ```

   The token is deleted on first use. The credential is shown once and kept
   only as a SHA-256 hash. Every credential belongs to one runner; there is no
   shared org secret.

Every later call sends `Authorization: Bearer yagrun_…`.

## Jobs

| Call                                      | Purpose                                                              |
| ----------------------------------------- | -------------------------------------------------------------------- |
| `POST /runner/v1/jobs/claim?wait=30`      | Long-poll up to `wait` seconds (30 at most). `200 {job}` or `204`.   |
| `POST /runner/v1/jobs/:id/heartbeat`      | Extends the 90 second lease. `{cancel}` says whether to stop.        |
| `POST /runner/v1/jobs/:id/logs?step=N`    | Appends a `text/plain` chunk (64 KiB at most) to step N. `{cancel}`. |
| `POST /runner/v1/jobs/:id/steps/N`        | `{state: running\|passed\|failed\|skipped, exit_code?}`.             |
| `PUT /runner/v1/jobs/:id/artifacts/:name` | Uploads one artifact (100 MiB at most, 20 per job), stored in R2.    |
| `POST /runner/v1/jobs/:id/complete`       | `{result: passed\|failed}`. Returns the run's final `{state}`.       |

A claimed job carries:

```json
{
  "id": "run id",
  "repo": "yuma/app",
  "job": "ios",
  "head_cs": "changeset id",
  "commit": "git sha-1",
  "clone": { "url": "https://forge/yuma/app.git", "token": "yagclone_…" },
  "steps": ["swift build", "swift test"],
  "services": [],
  "deadline": 1760000000000,
  "env": { "NPM_TOKEN": "…", "YAG_ID_TOKEN_REQUEST_URL": "…" },
  "files": [{ "path": "/run/yag/aws-web-identity-token", "content": "…" }],
  "mask": ["…every value the log must never show…"],
  "summary": "Job access: secrets NPM_TOKEN."
}
```

- **Claiming is at most once.** The claim is one conditional `UPDATE` of a
  queued run. If the response is lost, the run is never handed to another
  runner: its lease runs out and the cron sweep fails it with
  `The runner stopped responding`. A runner holds one job at a time.
- **Fair share.** Among matching jobs, repos with the fewest running
  self-hosted jobs go first, then the oldest job.
- **Clone.** `clone.token` is Git smart HTTP (#31) Basic auth for that one repo,
  read only, until the run ends. It works for scheduled runs too, which have no
  person behind them. Fetch with `git fetch --depth=1 <url> <commit>`.
- **Secrets.** `env`, `files` and `mask` come from the same code as the built-in
  runner (#50): only what the job asked for, nothing for untrusted triggers.
  The runner masks `mask` values (and their base64, URL-encoded and line-split
  forms) before a log byte leaves the machine.
- **Logs.** Each step keeps 512 KiB and a run 4 MiB; past that, one
  `[Log limit reached: further output is dropped.]` line is written and the
  rest is dropped. Readers see the log while the job runs. Send one chunk at a
  time so chunks stay in order.
- **Deadline.** `timeout_seconds` from the claim. A job still running at its
  deadline ends as `timed_out`.
- **Cancellation.** Cancelling the run or its pipeline marks it `cancelled` at
  once, revokes its clone and OIDC request tokens, and the runner learns of it
  from its next heartbeat or log call (`cancel: true`).
- The runner's own error text is never stored: a failed job's error is
  `A step failed. See the build log.`

## Runner states and revocation

- **Ephemeral** runners take exactly one job. The forge deletes the runner when
  that job ends (passed, failed, cancelled or lost), so its credential stops
  working and the agent exits.
- **Revoke**: `DELETE …/runners/:id`. The credential stops working on the next
  request, including in the middle of a long-poll (each 3 second poll round
  checks it), so a revoked runner gets no job within seconds and well inside a
  minute. A job it was running fails with `The runner was removed`.
- **Disable**: `PATCH …/runners/:id {"disabled": true}`. The runner may finish
  its current job but gets `403 runner_disabled` when it asks for another.
- **Trusted only**: `PATCH …/runners/:id {"trusted_only": true}` or at token
  creation. Jobs from public repositories, from fork pull requests, or whose
  trigger is unknown never go to it.

Registration, updates and removal are in the audit log
(`runner.registration_token.create`, `runner.register`, `runner.update`,
`runner.delete`).

## The built-in Cloudflare pool

The container runner (`CiRunnerDO`, `worker/src/ci/runner.ts`) is the runner
`cloudflare`. It claims a run with the same conditional `UPDATE`
(`runner_id = 'cloudflare'`) and only claims runs without self-hosted labels.
It is driven by the `ci-runs` queue instead of HTTPS because the container must
never hold a Worker credential. Its limits (two runs at a time, the monthly
budget, 512 KiB per run log) are unchanged; per-org concurrency is #52.

## Reference runner (`runner/`)

A small Node 22 agent with no runtime dependencies. It runs each step with
`bash -euo pipefail` directly on the host, in a fresh temporary directory that
is deleted after the job, with only `PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`,
`LC_ALL`, `TMPDIR` and `SHELL` from its own environment plus the job's `env`.
The clone token goes to Git through `GIT_CONFIG_*` variables, never on a
command line. Job files (the AWS web identity token) are written mode 0600
inside the job directory and their variables point there.

```sh
npm ci
# one-time token from the Runners page (org settings or a repo's CI page)
YAG_RUNNER_TOKEN=yagreg_… npm start -w yag-runner -- register \
  --url https://git.example.com --name build-1 --labels linux,x64
npm start -w yag-runner -- run          # long-lived
npm start -w yag-runner -- run --once   # one job, then exit
```

The config (URL and credential) is written to
`~/.config/yag-runner/runner.json`, mode 0600 (`--config` changes it).

It does not start `services` (jobs with services fail with a clear message)
and does not isolate steps from the host. For isolation, run it with
`--ephemeral` inside a throwaway VM or container per job.

### Linux

Run as an unprivileged user under systemd with `Restart=always`. For
untrusted code use one ephemeral runner per Docker or Podman container and
register a new one for each job.

### macOS and arm64 (Mac mini for iOS builds)

Not tested here: this repository's CI has no macOS or arm64 hosts. The agent
only needs Node 22, Git and bash, all present on macOS with the Xcode command
line tools, so the expected set-up is:

1. Install Xcode and Node 22 on the Mac mini.
2. For isolation, create a Tart macOS VM image with the same tools. For each
   job, clone a fresh VM, register an ephemeral runner inside it with labels
   such as `macos,arm64,xcode-16`, run `run --once`, then delete the VM. A
   small launchd job on the host can loop this.
3. Without VMs, run a long-lived runner as a dedicated macOS user under
   launchd (`KeepAlive`), and mark it `trusted_only` so public and fork jobs
   never reach it.

Linux arm64 machines register the same way with `--labels linux,arm64`.

## Not done yet

- Docker, Podman and Tart executors inside the agent (today: the host, or one
  ephemeral runner per VM or container).
- `services` on self-hosted runners.
- Listing and downloading artifacts (#51).
- Per-org concurrency for the built-in pool and longer timeouts (#52).
- Several jobs at once on one runner.
