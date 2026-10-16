# GitHub compatibility

Issue #74. Two ways to use GitHub habits against the forge:

1. A GitHub REST compatible subset under `/api/github/v3` (also served at
   `/api/v3`, the path GitHub Enterprise clients use), so Octokit, scripts and
   simple bots work with a base URL change.
2. `yag` commands shaped like `gh`: `yag issue`, `yag pr`, `yag run`,
   `yag release`, `yag repo`, `yag api` and `yag auth`.

The command inventory and the `gh` to `yag` table are in
[github-api-inventory.md](github-api-inventory.md).

## REST subset

Code: `worker/src/compat/github/`, one mapping module per resource. Every
request is translated into native `/api/v1` calls made as the caller, with the
caller's own credentials. RBAC, path rules, org SSO, agent scopes, guardrails,
rate limits, audit and webhook events therefore apply exactly as they do on the
native routes; the compatibility layer only maps shapes.

### Authentication

Send an API token as `Authorization: token <t>` (GitHub's scheme) or
`Authorization: Bearer <t>`. Anonymous calls get `401`, repositories the
caller cannot read get `404`, and denials keep the native `403` body
(`code`, `denied_by` and friends).

### Errors

Errors keep the native `{ "error": { "code", "message" } }` envelope and add
GitHub's top-level `message`, which Octokit and `gh` print. Bad input is `422`
(`validation_failed`), as on GitHub.

### Shapes

Objects follow GitHub's field names: numeric `id`, `node_id`, `number`,
`html_url`, `url` (pointing back into `/api/github/v3`), `user`, `labels`,
ISO 8601 timestamps. Commit SHAs are the Git SHA-1s that `git clone` sees.
Differences worth knowing:

- Pull request `head.ref` is `pull/<n>/head`: pull requests propose a
  revision, not a branch. `head.changeset` and `base.changeset` carry the
  forge's changeset ids.
- Pull requests always target the default branch; any other `base` is `422`.
- Release and asset ids are the forge's string ids. `upload_url` points at the
  native asset upload, which takes `?name=` and the raw body like GitHub.
- Check runs and commit statuses are read from forge CI (pipeline jobs and
  single-command runs). There is no store for statuses posted by outside
  tools, so `POST /statuses/:sha` and `POST /check-runs` are not offered.
- Code scanning alerts (#67) list the alerts on one ref (the default branch
  unless `ref` is given), numbered by forge id, and need write access like
  the native route. `severity` takes `critical`, `high`, `medium` or `low`.
  There is no single-alert route or dismissal here; `commit_sha` is null.
- `GET /search/issues` searches one repository: `repo:owner/name` is
  required. Supported qualifiers: `is:issue`, `is:pr` (or `type:`),
  `is:open`, `is:closed` (or `state:`), `label:` and `assignee:` (issues).
  Other words must all appear in the title or body.
- Lists use GitHub's `page` and `per_page` (at most 100) and send a `Link`
  header with `rel="next"`, so `octokit.paginate` works.

### Endpoints

| Method             | Path (under `/api/github/v3`)                                                      |
| ------------------ | ---------------------------------------------------------------------------------- |
| GET                | `/`, `/user`, `/user/repos`                                                        |
| GET                | `/repos/{owner}/{repo}`                                                            |
| GET                | `/repos/{owner}/{repo}/contents`, `/contents/{path}` (`?ref=`)                     |
| GET                | `/repos/{owner}/{repo}/git/ref/{heads/x or tags/x}`                                |
| POST               | `/repos/{owner}/{repo}/git/refs`                                                   |
| GET                | `/repos/{owner}/{repo}/commits/{ref}`                                              |
| GET                | `/repos/{owner}/{repo}/commits/{ref}/check-runs`, `/statuses`, `/status`           |
| GET                | `/repos/{owner}/{repo}/code-scanning/alerts` (`?ref=&state=&severity=&tool_name=`) |
| GET, POST          | `/repos/{owner}/{repo}/issues`                                                     |
| GET, PATCH         | `/repos/{owner}/{repo}/issues/{number}`                                            |
| GET, POST          | `/repos/{owner}/{repo}/issues/{number}/comments`                                   |
| POST, PUT          | `/repos/{owner}/{repo}/issues/{number}/labels`                                     |
| GET, POST          | `/repos/{owner}/{repo}/labels`                                                     |
| GET, POST          | `/repos/{owner}/{repo}/pulls`                                                      |
| GET, PATCH         | `/repos/{owner}/{repo}/pulls/{number}`                                             |
| GET, PUT           | `/repos/{owner}/{repo}/pulls/{number}/merge`                                       |
| GET, POST          | `/repos/{owner}/{repo}/pulls/{number}/reviews`                                     |
| GET, POST          | `/repos/{owner}/{repo}/releases`                                                   |
| GET                | `/repos/{owner}/{repo}/releases/latest`, `/releases/tags/{tag}`                    |
| GET, PATCH, DELETE | `/repos/{owner}/{repo}/releases/{id}`                                              |
| GET                | `/search/issues`                                                                   |

Request bodies and query parameters are in `docs/api.md` and
`docs/openapi.json` (operation ids start with `gh`), so the SDK types them too.

### Octokit

```ts
import { Octokit } from '@octokit/rest';

const octokit = new Octokit({
  baseUrl: 'https://forge.example/api/github/v3',
  auth: process.env.YAG_TOKEN,
});
await octokit.rest.issues.listForRepo({ owner: 'team', repo: 'app' });
```

`worker/test/compat-github.test.ts` drives Octokit against a fixture repo:
it lists and creates issues, opens a pull request, posts a review, reads check
runs and statuses, and paginates.

### The `gh` binary

`gh` targets a GitHub Enterprise host with `GH_HOST=forge.example` and
`GH_ENTERPRISE_TOKEN=<token>`, sending REST calls to
`https://forge.example/api/v3/`. That means:

- `gh api repos/{owner}/{repo}/issues` and other REST calls in the table above
  should work.
- `gh issue list`, `gh pr list`, `gh pr view`, `gh pr create` and most other
  `gh` subcommands use GitHub's GraphQL API, which is out of scope here. Use
  the `yag` equivalents instead.

This has not been checked against a real `gh` binary and a deployed forge yet;
treat it as expected behaviour until it has.

## yag commands

The gh-style commands live in `cli/src/commands/`. They find the forge and
repository in this order:

1. `-R owner/name` and `YAG_API` (the forge URL).
2. A `yag` working copy (`.yag/config.json`).
3. The `origin` remote of a plain Git checkout of the forge
   (`https://forge.example/owner/name.git`).

The token is `YAG_TOKEN`, the working copy's token, or the one
`yag auth login` stored for the host.

### Signing in and plain git

```bash
yag auth login --hostname forge.example --with-token < token.txt
yag auth setup-git --hostname forge.example   # git asks yag for the token
git clone https://forge.example/team/app.git
```

`yag auth login` keeps the token in the OS keychain where one is available
(macOS `security`, Linux `secret-tool`), otherwise in `~/.yag/hosts.json`
with mode 0600. `YAG_CREDENTIAL_STORE=file` or `keychain` forces one. On
macOS the token is passed to `security` as an argument, which other local
processes can briefly see; `secret-tool` reads it from standard input.

Browser device login (`yag auth login` with no token) is not available yet:
the forge has no OAuth device authorization endpoint. The command says so and
explains how to create a token.

### Pull requests

`yag pr create` proposes the current branch (`-H` to pick another) against
the default branch; push the branch first. From a `yag` working copy it
proposes the checked-out changeset, as `yag pr -t …` always did.

`yag pr checkout 12` fetches the pull request's head commit by SHA from the
`origin` remote (`--remote` to pick another) and checks it out as branch
`pr-12` (`-b` to rename), fast-forwarding the branch if it exists. In a `yag`
working copy it checks out the head changeset instead.

`yag pr checks` exits 1 when a check failed and 8 while checks are pending,
like `gh pr checks`.
