# Mirroring and per-repo cutover from GitHub

Issues #36 (mirrors) and #73 (cutover). Code: `worker/src/mirrors/` and
`worker/src/api/mirrors.ts`.

A repository moves from GitHub to the forge in four stages. Each stage can be
undone by moving one step back.

| State     | Code is authoritative on | What runs                                           |
| --------- | ------------------------ | --------------------------------------------------- |
| `github`  | GitHub                   | nothing from the cutover (the default)              |
| `mirror`  | GitHub                   | the pull mirror: GitHub into the forge              |
| `dual`    | the forge                | the push mirror: the forge out to GitHub            |
| `cutover` | the forge                | nothing; the GitHub repository is archived (frozen) |

Two-way sync, where both sides accept pushes, is out of scope on purpose.

## Mirrors

A mirror belongs to one repository and is managed by its admins from a
browser session (API and agent tokens cannot read or change mirrors). The
dashboard page is `/r/<owner>/<repo>/mirrors`.

- **Pull mirror**: lists the remote's `refs/heads/*` and `refs/tags/*`
  (Git protocol v2), fetches what the forge lacks and lands it through the
  same receive-pack path as `git push`. SHAs are kept: a commit that would not
  rebuild to its SHA is refused. The landing runs as the mirror's creator, so
  rulesets, path rules and the audit log apply as for a push; add the creator
  (or `role:admin`) to a ruleset's bypass list if the ruleset would otherwise
  refuse mirrored updates.
- **Push mirror**: compares the forge's branches and tags with the remote's
  advertisement (receive-pack, `report-status`) and pushes the difference.
- **Divergence**: a pull mirror leaves a ref alone when the forge moved it
  since the mirror last wrote it and the remote's commit does not descend
  from it. A push mirror leaves a ref alone when the remote's commit is not an
  ancestor of the forge's. Either way the ref shows as `diverged` with a
  reason, the sync is recorded as failed and nothing is overwritten. `force`
  overwrites diverged refs (a push mirror with `force` also deletes remote
  refs the forge lacks).
- **Not mirrored**: agent work refs (`refs/agents/*`), and annotated tags on a
  pull remote (the forge stores lightweight tags; they show as `skipped`). The
  forge never lets a push rewrite or delete its default branch, so an
  upstream force push of the default branch shows as `failed`; force pushes
  of other branches are mirrored.
- **Credentials**: `auth` is `none`, `token` (HTTP Basic, user
  `x-access-token` unless `username` is set) or `github_app` (an installation
  token of the connected GitHub App, github.com only). Tokens are encrypted
  with the #50 envelope keys, never returned (the API shows `has_token`),
  never put in a URL and scrubbed from every error. Remote URLs must be https,
  without credentials, and must not resolve to private addresses; redirects
  are refused.
- **When syncs run**: the `mirror-sync` queue runs one sync per message. The
  cron queues every enabled mirror whose `interval_s` has passed; every
  accepted ref move queues the repository's enabled push mirrors at once; and
  `POST .../mirrors/:id/sync` syncs inline and returns the outcome. A D1 lease
  keeps one sync per mirror at a time.
- **Failures** show on the mirror (`last_error`, `last_result` per ref) and in
  the audit log as `mirror.sync` with `ok: false` and the error. A sync that
  moved refs is audited too; a sync that changed nothing is not.
- **Limits**: a fetched pack is capped at the push limit (24 MiB). Land a large
  history with the importer first, then mirror the increments.

```bash
# create a pull mirror through the GitHub App (session cookie in $COOKIE)
curl -sS -X POST "$FORGE/api/v1/repos/acme/widgets/mirrors" \
  -H "cookie: $COOKIE" -H 'content-type: application/json' \
  -d '{"direction":"pull","remote_url":"https://github.com/acme/widgets.git","auth":"github_app"}'
```

## Moving between states

`GET /api/v1/repos/:repo/migration` returns the state, the linked mirrors and,
for each possible next state, the checks with their current result.
`POST /api/v1/repos/:repo/migration` with `{"to": "<state>"}` makes the move;
a failing check blocks it with `409 transition_blocked`, the message and the
`checks` list. Every move is audited as `repo.migration`. Moves that depend on
a mirror's state sync that mirror first, so "in sync" means now.

| Move                 | Checks                                                                                                                                                                                                                                                | Effect                                                      |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `github` -> `mirror` | a pull mirror is linked (`pull_mirror_id`)                                                                                                                                                                                                            | pull mirror on                                              |
| `mirror` -> `dual`   | the pull mirror synced just now without errors or diverged refs; a push mirror with credentials is linked (`push_mirror_id`); an active ruleset; people other than the creator have access; the newest forge CI run on the default branch head passed | pull mirror off, push mirror on                             |
| `dual` -> `cutover`  | the push mirror synced just now and GitHub has every forge branch and tag at the same SHA; the repo is connected to the GitHub App; `confirm` is the repository's `owner/name`                                                                        | GitHub repository archived through the App; push mirror off |
| `cutover` -> `dual`  | a push mirror is linked; the GitHub App is connected; `confirm`                                                                                                                                                                                       | GitHub repository unarchived; push mirror on                |
| `dual` -> `mirror`   | the push mirror synced just now and GitHub has every forge commit                                                                                                                                                                                     | push mirror off, pull mirror on                             |
| `mirror` -> `github` | none                                                                                                                                                                                                                                                  | pull mirror off                                             |

Archiving changes GitHub where everyone can see it, so both moves that touch
it need the admin to type the repository's name every time.

Create both mirrors paused (`"enabled": false`): once linked, the state turns
each one on and off, and a mirror the cutover uses cannot be resumed out of
its state or deleted until the repo is back in `github`.

## Rollback commands

From a signed-in session (the dashboard's Mirrors page has the same buttons):

```bash
move() { curl -sS -X POST "$FORGE/api/v1/repos/acme/widgets/migration" \
  -H "cookie: $COOKIE" -H 'content-type: application/json' -d "$1"; }

# cutover -> dual: unarchive GitHub, resume the push mirror
move '{"to":"dual","confirm":"acme/widgets"}'
# dual -> mirror: GitHub is primary again (blocked until GitHub has every forge commit)
move '{"to":"mirror"}'
# mirror -> github: stop pulling
move '{"to":"github"}'
```

Rolling back never deletes forge data: issues, pull requests and commits stay
where they are, and the pull mirror only moves refs it owns.

## Not covered yet

- CI parity with GitHub Actions (#49): the `ci` check only asks that forge CI
  passed on the default branch head.
- "Factory points at the forge" cannot be checked by the forge; confirm it
  before moving to `dual`.
- Mirroring issue state or work-item fields back to GitHub labels (#59).
- Updating the GitHub README with a pointer at cutover: commit it on the forge
  during `dual` and the push mirror carries it to GitHub.
