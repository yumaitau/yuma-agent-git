# GitHub API and gh inventory

Issue #74. What Yuma people, agents and code use from GitHub, and the forge
equivalent. See [github.md](github.md) for how the compatibility layer works.

## How this list was made

- `gh` commands: the ones Yuma's people and agents use to file, triage and
  land work (this ticket pack was filed with `gh issue create`; agent
  workflows read tickets with `gh issue view`), checked against the
  [GitHub CLI manual](https://cli.github.com/manual/).
- This repository: `grep` for `gh <command>` and for GitHub REST paths in
  `worker/src`, `scripts/` and `.github/`. The only GitHub REST calls are
  outbound, from the importer and mirroring (#72, #73) and GitHub sign-in;
  they are listed below for completeness and need no forge equivalent.
- Personal agent skills (`~/.agent-skills`): no `gh` or GitHub REST use found.
- Factory is not in this repository and was not available to grep. Its calls
  should be added here when someone with access checks it.

## gh commands and their yag equivalents

| `gh` command                                                          | `yag` equivalent                                      | Notes                                                         |
| --------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------- |
| `gh issue list [-s] [-l] [-a] [-L]`                                   | `yag issue list`                                      | same flags; `--json` prints GitHub-shaped JSON                |
| `gh issue create -t -b [-l] [-a]`                                     | `yag issue create`                                    | same flags                                                    |
| `gh issue view N [-c]`                                                | `yag issue view N [-c]`                               |                                                               |
| `gh issue close N [-r] [-c]`                                          | `yag issue close N`                                   | `-r "not planned"`                                            |
| `gh issue reopen N`                                                   | `yag issue reopen N`                                  |                                                               |
| `gh issue comment N -b`                                               | `yag issue comment N -b`                              |                                                               |
| `gh issue edit`                                                       | `yag api -X PATCH repos/{owner}/{repo}/issues/N -f …` | no dedicated command yet                                      |
| `gh pr create -t -b [-H] [-B] [-d]`                                   | `yag pr create` (also `yag pr -t …`)                  | base must be the default branch; push the branch first        |
| `gh pr list [-s] [-B] [-L]`                                           | `yag pr list`                                         |                                                               |
| `gh pr view N`                                                        | `yag pr view N`                                       |                                                               |
| `gh pr checkout N [-b]`                                               | `yag pr checkout N`                                   | plain Git remotes and `yag` working copies                    |
| `gh pr merge N [-m/-s/-r] [--subject] [--body] [--match-head-commit]` | `yag pr merge N`                                      | same flags                                                    |
| `gh pr review N [-a/-r/-c] [-b]`                                      | `yag pr review N`                                     |                                                               |
| `gh pr checks N`                                                      | `yag pr checks N`                                     | exit 1 on failure, 8 while pending                            |
| `gh run list [-L]`                                                    | `yag run list`                                        | pipeline runs and single-command CI runs                      |
| `gh run view ID [--log]`                                              | `yag run view ID [--log]`                             | a pipeline run id or a job run id                             |
| `gh run view --log`                                                   | `yag run log ID`                                      |                                                               |
| `gh run rerun ID`                                                     | `yag run rerun ID`                                    | reruns a run's failed jobs, or one job                        |
| `gh release create/list/view/upload/download/delete`                  | `yag release …`                                       | existing commands (#54); `create` needs the tag to exist      |
| `gh repo view`                                                        | `yag repo view`                                       |                                                               |
| `gh repo clone owner/name`                                            | `yag repo clone owner/name`                           | plain `git clone`; needs `YAG_API`                            |
| `gh repo create`                                                      | none                                                  | the forge creates repositories from a browser session only    |
| `gh repo fork`                                                        | none                                                  | the forge has no forks                                        |
| `gh api PATH [-X] [-f] [-F] [--input] [-i]`                           | `yag api PATH`                                        | bare paths map onto `/api/github/v3`; `/api/v1/…` goes native |
| `gh auth login --with-token`                                          | `yag auth login --with-token`                         | OS keychain where available                                   |
| `gh auth login` (browser device flow)                                 | none yet                                              | no device authorization endpoint on the forge                 |
| `gh auth status` / `logout` / `token`                                 | `yag auth status` / `logout` / `token`                |                                                               |
| `gh auth setup-git`, `gh auth git-credential`                         | `yag auth setup-git`, `yag auth git-credential`       |                                                               |
| `gh label list/create`                                                | `yag api repos/{owner}/{repo}/labels`                 | REST subset                                                   |
| `gh search issues`                                                    | `yag api 'search/issues?q=repo:owner/name …'`         | one repository per search                                     |

## GitHub REST endpoints in the compatibility subset

Chosen for Octokit, `gh api` and simple bots: repositories, contents, Git refs,
commits, issues, comments, labels, pull requests, reviews, check runs and
statuses, releases and issue search. The full list is in
[github.md](github.md#endpoints).

## Outbound GitHub calls in this repository (no forge equivalent needed)

| Caller                                                           | GitHub REST call                                                                                                                   |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| GitHub sign-in (`worker/src/auth`)                               | `GET /user`, `GET /user/emails`                                                                                                    |
| GitHub App installs and import (`worker/src/bridge`)             | `POST /app/installations/{id}/access_tokens`                                                                                       |
| Import and mirroring (`worker/src/bridge`, `worker/src/mirrors`) | `GET /repos/{o}/{r}`, `/commits`, `/commits/{sha}`, `/compare/{a}...{b}`, `/contents/{path}`, `/git/blobs/{sha}`, `/tarball/{ref}` |
