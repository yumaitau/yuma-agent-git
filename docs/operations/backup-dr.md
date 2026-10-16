# Backup, disaster recovery and export

Issue #70. The forge holds the only copy of some repositories, so it needs a
copy that survives losing the Cloudflare account, a restore that has been
practised, and an export any repository owner can take away.

Code: `worker/src/backup/backup.ts` (backup, retention, restore),
`worker/src/api/backups.ts` (admin API), `worker/src/git/bundle.ts` and
`worker/src/api/export.ts` (repository export). Tests:
`worker/test/backup.test.ts`.

## Objectives

| What                           | RPO target | How it is met                                                                                      |
| ------------------------------ | ---------- | -------------------------------------------------------------------------------------------------- |
| D1 metadata, same account      | minutes    | D1 Time Travel (point in time, 30 days on paid plans)                                              |
| D1 metadata, account lost      | 15 minutes | Scheduled backup every `BACKUP_INTERVAL_MINUTES` (15) plus the time one takes to finish            |
| R2 objects (blobs, trees, LFS) | 0          | Content-addressed and immutable in R2; each backup lists every key so a restore can prove it whole |
| R2 objects, account lost       | not met    | Needs a copy in another account (see Gaps)                                                         |
| Durable Object state           | n/a        | Ref locks, rate limits and queues hold no state a restore needs; refs live in D1                   |

RTO target: 4 hours from the decision to restore to a working forge. The
measured part is the restore itself: `worker/test/backup.test.ts` records
`started_at` and `finished_at` on the restore row; a real drill must record
the same two fields from the target environment (`SELECT * FROM backups
WHERE kind = 'restore'`).

## What a backup holds

A backup is `backups/<id>/` in the `BACKUPS` bucket:

- `d1/<table>/<part>.ndjson`: every row of every table, 500 rows per part,
  tables ordered parents before children (foreign keys). `d1_migrations` and
  `backups` stay out.
- `r2/<part>.ndjson`: the key, size, etag and upload time of every object in
  `OBJECTS` (`repos/…/blobs`, `repos/…/trees`, `lfs/…`, `registry/…`, CI logs).
- `manifest.json`: the backup id, start and finish times, the migration
  names the rows belong to, per-table row and part counts and R2 totals.

Every part is encrypted with AES-256-GCM under `BACKUP_ENCRYPTION_KEY`, with
the part's own key as associated data, so a part cannot be swapped for
another. The key is a Worker secret: it is never written to D1 or R2, so the
backed-up system cannot decrypt its own backups. Keep a copy in the
operators' password manager; without it a backup is unreadable.

The D1 copy is read a few pages per cron tick, so it is not one point in
time: rows written while it runs may be missing or newer. A restore inserts
what it can and counts the rows a foreign key refuses (for example a review
whose pull request was created after the `pull_requests` table was copied).

## Configuration

| Setting                   | Kind   | Default | Meaning                                                   |
| ------------------------- | ------ | ------- | --------------------------------------------------------- |
| `BACKUPS`                 | R2     | unset   | The backup bucket; unset turns backups off                |
| `BACKUP_ENCRYPTION_KEY`   | secret | unset   | Base64 of 32 random bytes; unset turns backups off        |
| `BACKUP_INTERVAL_MINUTES` | var    | 15      | Minutes between backup starts                             |
| `BACKUP_RETENTION_DAYS`   | var    | 30      | Days a finished backup is kept; the newest is always kept |
| `BACKUP_ADMIN_USER_IDS`   | var    | unset   | User ids that may list and start backups                  |
| `RESTORE_BACKUP_ID`       | var    | unset   | Only in a restore target: the backup to restore           |

`wrangler.jsonc` binds `BACKUPS` to a local `yag-backups` bucket for
development and tests only. Production has no binding yet: the bucket should
live in a separate Cloudflare account (or S3-compatible Australian storage,
see #68), and creating it needs Justin's approval. Until then no production
backups are taken.

Generate a key with `openssl rand -base64 32` and set it with
`wrangler secret put BACKUP_ENCRYPTION_KEY --env prod`.

## Operating

- `GET /api/v1/admin/backups` lists recent backups and restores (status,
  rows, objects, bytes, error). `POST /api/v1/admin/backups` starts one now
  (`backup.create` in the audit log). Both need a session whose user id is in
  `BACKUP_ADMIN_USER_IDS`.
- A failed backup keeps its error on the row; the next interval starts a new
  one.

## Restore runbook

Restore into a fresh environment, never over a live one: the restore refuses
to start while the target database holds any repo or user.

1. Create the target: a new D1 database, a new R2 bucket for objects and a
   Worker deployment pointing at both (a copy of the `prod` env block with new
   names).
2. Copy the objects. Today they are only in the source account's
   `yag-objects` bucket; copy them with an S3-compatible tool (for example
   `rclone sync`) or Cloudflare's R2 data migration into the target bucket.
3. Apply exactly the migrations the backup was taken with (the manifest's
   `migrations` list; a mismatch fails the restore with `schema mismatch`):
   `wrangler d1 migrations apply <target-db> --remote`.
4. Bind the backup bucket as `BACKUPS` (read access is enough), set the same
   `BACKUP_ENCRYPTION_KEY` and set `RESTORE_BACKUP_ID` to the backup's id.
   Set the same Worker secrets the source had (`SECRETS_KEK`,
   `TOTP_ENCRYPTION_KEY`, `CI_OIDC_SIGNING_KEYS`, `CACHE_SIGNING_KEY`, the
   GitHub App and OAuth credentials): restored rows hold data encrypted or
   signed under them. Deploy.
5. The cron restores 20 parts a minute, then checks every object in the
   manifest against the new `OBJECTS` bucket. Watch
   `SELECT id, status, row_count, object_count, error, started_at, finished_at
FROM backups WHERE kind = 'restore'`. `done` with no `error` is a clean
   restore; otherwise `error` says how many rows were skipped and how many
   objects are missing.
6. Remove `RESTORE_BACKUP_ID`, deploy again, and run the live smoke harness
   (`scripts/smoke-live.py`) against the new environment. Sessions and API
   tokens come back with the rows, so existing credentials work.
7. Record both timings and the result in the drill log.

The restore is tested in miniflare by `worker/test/backup.test.ts`: it backs
up a repository with history, refs, an issue, a pull request, sessions and
audit events across many ticks, wipes the database, restores it with
`RESTORE_BACKUP_ID`, and checks every row and the API answer match.

## Repository export

Anyone who can read a whole repository can take it away:

- `GET /api/v1/repos/:owner/:repo/export/bundle`: a Git bundle of every
  branch and tag (agent work refs stay out). `git clone repo.bundle` gives the
  same commit SHAs as the forge.
- `GET /api/v1/repos/:owner/:repo/export/metadata`: JSON
  (`yag-repo-export/1`) with the repository, refs with their Git SHAs, issues
  and comments, labels, milestones, pull requests, reviews, review threads and
  comments, releases, LFS objects and locks, and a user id to login map.

Both are audited as `repo.export`. LFS object contents are not inside the
bundle; fetch them with `git lfs fetch --all` against the forge.

## Gaps

- No copy of R2 objects outside the account yet: needs the separate account
  or provider (#68). The manifest in each backup is what such a copy will be
  checked against.
- Org-wide export (every repository at once) and an importer for the
  metadata JSON are not built; the GitHub importer (#72) reads GitHub's API
  shapes, not this format.
- No restore drill has been run against a real environment; the
  `scripts/restore-drill.sh` the issue describes does not exist yet.
