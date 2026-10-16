# Developer quickstart

GitHub supplies sign-in only. Yuma owns repository storage, history, reviews and CI execution on Cloudflare; a GitHub repository or GitHub Actions workflow is not required.

Choose **New repository** in the dashboard. The repository opens on its code page: choose **Create initial README** to create the first commit and default branch, then copy the native clone command. Use **Set up Yuma CI** when you are ready to configure checks. GitHub import is an optional migration tool. Yuma uses its own content-addressed changeset IDs: use the ID from `yag commit`, not a Git commit SHA.

## One-time team setup

An administrator signs in, creates/imports the repository and grants teammates write membership in repository settings. In **CI**, review the detected commands, choose a time limit and required approvals, then save. Choose **Just me (0)** for a solo repository; the author cannot approve their own PR. Leave the image destination blank for checks only. Required checks and default-branch protection are selected by default; adjust the checkboxes if you are still migrating.

If “Runner deployment is pending” appears, the pipeline can be saved but cannot execute until the operator completes [deployment](deploy.md#cloudflare-ci-runners). Required checks will block merges until execution is enabled and a run passes. Avoid enabling required checks in a live migration before the operator has verified the runner.

## Install the CLI

The CLI is currently built from this repository rather than published to npm:

```sh
npm ci
npm run build -w yag
npm link -w yag
yag --help
```

Sign in to the dashboard and create a scoped token using the existing token settings. Load it into the `YAG_TOKEN` environment variable through your secret manager. Do not paste it into a command, repository file or chat. The clone command writes the server/repository configuration, not the environment token.

## Make your first change

```sh
yag clone team/project ./project --api https://your-yuma-host.example
cd project
yag status
# Edit files and run your normal local checks.
yag commit -m "Describe the change"
yag pr --title "Describe the change" --body "What changed and how you checked it"
yag ci status
```

`clone` requires an empty directory and defaults to `ref:main`; use `--rev ref:release/name` when appropriate. `yag commit` uploads the new immutable changeset. Without `--ref`, it does not move the shared branch. `yag pr` opens a PR from the checked-out changeset and prints its browser URL. Use `--draft` to prepare a change without automatically running CI.

On a ready PR, checks are automatically attempted when CI is enabled and configured. If capacity or the monthly budget prevented scheduling, use **Run checks** on that PR, or `yag ci run` from its working copy. `yag ci status` shows recent runs. The web CI page provides completed logs, cancellation and explicit retries. Logs are bounded and retained seven days; do not print secrets.

A teammate reviews the diff and submits approval or requested changes. Merge becomes available only when the current revision has enough approvals and its latest CI run passes under the current pipeline. Pick **Create a merge commit**, **Squash and merge** or **Rebase and merge** (the repo and its rulesets decide which are offered). The server builds the result on the target's current head, so a moved target does not block the merge unless the same lines changed on both sides.

## Update a pull request

Make another local commit, copy its changeset ID, and use **Update the proposed revision** on the PR page. This invalidates old approvals and attempts new checks. Description-only edits do not rerun CI. A restored older head still needs fresh approval.

If another PR moved the target, **Update branch** (merge commit) or **Update with rebase** brings the target into your PR on the server; both start a new revision. When the same lines changed on both sides, the PR page lists each conflicting file with the base, target and proposed lines. Resolve them by committing a changeset whose parents are your PR head and the target head (a `git merge` pushed over Git, or `POST …/changesets` with `parents`), then update the PR's proposed revision to it. Close and create a new PR if you need to replace a closed proposal.

## Publish a Docker image

An operator first configures the registry and authorizes an exact image destination for this repository. The repo admin enters that same destination in CI setup, for example `ghcr.io/team/project`, without a tag. After the PR merges, use **Build & push image** on the CI page. From a working copy at the current default head, an admin may also run:

```sh
yag ci run --publish
```

Publishing reruns the configured checks, builds the configured Dockerfile and pushes an immutable-style `cs-<full-changeset-id>` tag. It does not update `latest` or deploy the image. The build and publish together must fit the time limit; exported images are limited to 256 MiB. Images execute only in the build VM; the credential-bearing publisher loads and pushes them without running them.

For a Docker-only repository, the detected check command builds the Dockerfile locally in the ephemeral runner. This validates the image without publishing. A publish run performs its own final build after the checks, so adjust commands and deadline to account for that work.

## Common stops

| Message                                            | Next step                                                                                                          |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Runner deployment pending                          | Operator completes Cloudflare setup and enables CI                                                                 |
| Capacity or budget exhausted                       | Wait for an active job, or ask the operator to inspect the monthly ledger; automatic retries are intentionally off |
| Latest CI run must pass                            | Run checks on the PR revision; a pipeline edit makes older results insufficient                                    |
| Target branch moved                                | Replay changes on the latest target in a new working directory, then update the PR                                 |
| Whole repository access required                   | CI scripts/logs and PR mutations require full source access; ask the administrator to review path permissions      |
| Registry not configured / destination unauthorized | Operator adds registry secrets and repo-to-image authorization                                                     |
| Source/image/log limit                             | Reduce the payload or output; do not repeatedly retry the same oversized job                                       |
