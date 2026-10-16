import { z } from 'zod';
import type { Env } from '../env';
import { C, T } from '../db/schema';
import { parseImportJobRow, q1, run } from '../db/client';
import { startSecretScan } from '../security/secrets/history';
import { getChangeset } from '../core/changesets';
import { commitChanges } from '../core/commit';
import { putBlob } from '../core/blobs';
import { ConflictError, NotFoundError, RequestValidationError } from '../core/errors';
import { ulid } from '../core/ids';
import { moveRefViaDO } from '../core/refs';
import { githubApi } from './github';
import { treeFiles } from './fastimport';
import { gunzipIfNeeded, parseTar } from './tar';

/**
 * Git import (issue #15, architecture §3) — the on-ramp. No git binary on
 * Workers: everything is HTTP + streaming tar.
 *
 *  - **snapshot** (default): the ref's tarball becomes one root changeset
 *  - **full_history**: commit-by-commit via the GitHub commits API, with a
 *    checkpoint after every commit so retries resume instead of restarting.
 *    A commit touching > MAX_FILES_PER_COMMIT files falls back to a snapshot
 *    of the tree at that commit (tarball diffed against the parent) and the
 *    job records a warning; files that cannot be fetched are warnings too
 *  - **incremental sync**: push webhooks (#13) list what arrived after the
 *    checkpointed `github_sha` and land it the same way (rebase-and-retry CAS)
 *
 * All writes go through `commitChanges` — one write path with RPC commits.
 * v1 divergence (documented): GitHub merge commits import single-parent (the
 * WAL records changes relative to the first parent anyway).
 */

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_FILES_PER_COMMIT = 1_000;
/** Cap on warnings kept in the job checkpoint (the rest are only counted). */
const MAX_WARNINGS = 200;

const IMPORT_AUTHOR = { name: 'yag-import', email: 'import@yuma-agent-git' };

export type ImportMessage =
  | { type: 'import_job'; job_id: string }
  | {
      type: 'github_push';
      repo_id: string;
      github_repo_id: number;
      ref: string;
      after: string;
    };

export const importRequestSchema = z.object({
  source: z.string().regex(/^github:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/),
  mode: z.enum(['snapshot', 'full_history']).default('snapshot'),
  ref: z.string().min(1).default('main'),
});

export interface ImportJobRow {
  id: string;
  repo_id: string;
  source: string;
  mode: 'snapshot' | 'full_history';
  status: string;
  checkpoint: Record<string, unknown> | null;
  commits_total: number;
  commits_done: number;
  error: string | null;
}

function parseJob(row: unknown): ImportJobRow {
  const parsed = parseImportJobRow(row);
  return {
    ...parsed,
    checkpoint: parsed.checkpoint
      ? (JSON.parse(parsed.checkpoint) as Record<string, unknown>)
      : null,
    commits_total: parsed.commits_total ?? 0,
    commits_done: parsed.commits_done ?? 0,
    error: parsed.error ?? null,
  };
}

function sourceParts(source: string): { owner: string; name: string } {
  const [owner, name] = source.slice('github:'.length).split('/') as [string, string];
  return { owner, name };
}

// ---------------------------------------------------------------------------
// Job lifecycle
// ---------------------------------------------------------------------------

export async function startImport(
  env: Env,
  repoId: string,
  body: unknown,
): Promise<{ job_id: string }> {
  const parsed = importRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new RequestValidationError('invalid import request', {
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    });
  }
  const { source, mode, ref } = parsed.data;

  // the repo must be connected through the GitHub App (#13)
  const installationId = await requireInstallation(env, repoId);
  void installationId;

  const jobId = ulid();
  const now = Date.now();
  await run(
    env,
    `INSERT INTO ${T.importJobs}
       (${C.importJobs.id}, ${C.importJobs.repoId}, ${C.importJobs.source}, ${C.importJobs.mode},
        ${C.importJobs.status}, ${C.importJobs.checkpoint}, ${C.importJobs.commitsTotal},
        ${C.importJobs.commitsDone}, ${C.importJobs.createdAt}, ${C.importJobs.updatedAt})
     VALUES (?, ?, ?, ?, 'queued', ?, 0, 0, ?, ?)`,
    [jobId, repoId, source, mode, JSON.stringify({ ref }), now, now],
  );
  await env.IMPORT_QUEUE.send({
    type: 'import_job',
    job_id: jobId,
  } satisfies ImportMessage);
  return { job_id: jobId };
}

export async function getImportJob(
  env: Env,
  repoId: string,
  jobId: string,
): Promise<ImportJobRow> {
  const row = await q1(
    env,
    `SELECT * FROM ${T.importJobs} WHERE ${C.importJobs.id} = ? AND ${C.importJobs.repoId} = ?`,
    [jobId, repoId],
  );
  if (!row) throw new NotFoundError('job_not_found', `no import job ${jobId}`);
  return parseJob(row);
}

async function updateJob(
  env: Env,
  jobId: string,
  patch: {
    status?: string;
    checkpoint?: Record<string, unknown>;
    commitsTotal?: number;
    commitsDone?: number;
    error?: string | null;
  },
): Promise<void> {
  await run(
    env,
    `UPDATE ${T.importJobs}
        SET status = COALESCE(?, status),
            checkpoint = COALESCE(?, checkpoint),
            commits_total = COALESCE(?, commits_total),
            commits_done = COALESCE(?, commits_done),
            error = COALESCE(?, error),
            updated_at = ?
      WHERE ${C.importJobs.id} = ?`,
    [
      patch.status ?? null,
      patch.checkpoint ? JSON.stringify(patch.checkpoint) : null,
      patch.commitsTotal ?? null,
      patch.commitsDone ?? null,
      patch.error ?? null,
      Date.now(),
      jobId,
    ],
  );
}

export async function markJobFailed(
  env: Env,
  jobId: string,
  error: unknown,
): Promise<void> {
  await updateJob(env, jobId, {
    status: 'failed',
    error: error instanceof Error ? error.message : String(error),
  });
}

// ---------------------------------------------------------------------------
// Consumer entry
// ---------------------------------------------------------------------------

export async function runImportMessage(env: Env, message: ImportMessage): Promise<void> {
  if (message.type === 'import_job') {
    const row = await q1(
      env,
      `SELECT * FROM ${T.importJobs} WHERE ${C.importJobs.id} = ?`,
      [message.job_id],
    );
    if (!row) throw new NotFoundError('job_not_found', `no import job ${message.job_id}`);
    const job = parseJob(row);
    await updateJob(env, job.id, { status: 'running' });
    if (job.mode === 'snapshot') {
      await snapshotImport(env, job);
    } else {
      await fullHistoryImport(env, job);
    }
    await updateJob(env, job.id, { status: 'done' });
    // imported history is scanned for secrets in the background (#66)
    await startSecretScan(env, job.repo_id, { kind: 'system', id: 'import' });
    return;
  }
  await incrementalSyncFromPush(env, message);
}

// ---------------------------------------------------------------------------
// Snapshot mode
// ---------------------------------------------------------------------------

async function snapshotImport(env: Env, job: ImportJobRow): Promise<void> {
  const { owner, name } = sourceParts(job.source);
  const installationId = await requireInstallation(env, job.repo_id);
  const ref = String(job.checkpoint?.ref ?? 'main');

  // resolve the exact sha first — the changeset message names it
  const commitRes = await githubApi(
    env,
    installationId,
    `/repos/${owner}/${name}/commits/${ref}`,
  );
  const head = (await commitRes.json()) as { sha: string };

  const tarRes = await githubApi(
    env,
    installationId,
    `/repos/${owner}/${name}/tarball/${ref}`,
  );
  if (!tarRes.ok || !tarRes.body) {
    throw new Error(`tarball fetch failed: ${tarRes.status}`);
  }

  const changes: { path: string; op: 'add'; blob_sha256: string }[] = [];
  const warnings: { path: string; skipped: string }[] = [];
  const tar = parseTar(await gunzipIfNeeded(tarRes.body, true), {
    maxBodyBytes: MAX_FILE_BYTES,
  });
  for await (const entry of tar) {
    // symlinks import as blobs whose content is the target (mode 120000 in git)
    if (entry.type !== 'file' && entry.type !== 'symlink') continue; // dirs are implicit
    if (entry.skipped) {
      warnings.push({ path: entry.name, skipped: 'too_large' });
      continue;
    }
    // tarballs wrap content in a top-level `{owner}-{name}-{sha}/` folder
    const path = entry.name.replace(/^[^/]+\//, '');
    const put = await putBlob(env, job.repo_id, entry.body);
    changes.push({ path, op: 'add', blob_sha256: put.hash });
  }
  if (changes.length === 0) throw new Error('tarball contained no files');

  const result = await commitChanges(env, job.repo_id, {
    first_parent: null,
    message: `Import snapshot of ${job.source}@${head.sha}`,
    author: IMPORT_AUTHOR,
    changes,
  });

  // CAS-create main
  await moveRefViaDO(env, job.repo_id, 'main', {
    from: null,
    to: result.changeset.id,
  });
  await updateJob(env, job.id, {
    commitsTotal: 1,
    commitsDone: 1,
    checkpoint: {
      ref,
      github_sha: head.sha,
      root_cs: result.changeset.id,
      warnings,
    },
  });
}

// ---------------------------------------------------------------------------
// Full-history mode (checkpointed + resumable)
// ---------------------------------------------------------------------------

interface GithubCommit {
  sha: string;
  commit: {
    message: string;
    author: { name: string; email: string; date: string };
  };
  parents?: { sha: string }[];
  files?: {
    filename: string;
    status: string;
    previous_filename?: string;
    sha?: string;
  }[];
}

async function fullHistoryImport(env: Env, job: ImportJobRow): Promise<void> {
  const { owner, name } = sourceParts(job.source);
  const installationId = await requireInstallation(env, job.repo_id);
  const checkpoint = job.checkpoint ?? {};
  const ref = String(checkpoint.ref ?? 'main');

  // 1. list commits newest → oldest, then work oldest → newest
  const commits: GithubCommit[] = [];
  for (let page = 1; page <= 50; page++) {
    const res = await githubApi(
      env,
      installationId,
      `/repos/${owner}/${name}/commits?sha=${ref}&per_page=100&page=${page}`,
    );
    const batch = (await res.json()) as GithubCommit[];
    if (!Array.isArray(batch) || batch.length === 0) break;
    commits.push(...batch);
    if (batch.length < 100) break;
  }
  const ordered = commits.reverse();
  await updateJob(env, job.id, { commitsTotal: ordered.length });

  // 2. resume from the checkpoint cursor — idempotent (content-addressed ids)
  let cursor = typeof checkpoint.cursor === 'number' ? checkpoint.cursor : 0;
  let parentCs = typeof checkpoint.last_cs === 'string' ? checkpoint.last_cs : null;
  const warnings = new WarningLog(checkpoint);

  while (cursor < ordered.length) {
    const entry = ordered[cursor] as GithubCommit;
    const { changes, warnings: commitWarnings } = await changesForCommit(env, {
      installationId,
      owner,
      name,
      repoId: job.repo_id,
      parentCs,
      entry,
    });
    warnings.add(commitWarnings);
    const created = await commitChanges(env, job.repo_id, {
      first_parent: parentCs,
      message: entry.commit.message,
      author: {
        name: entry.commit.author.name,
        email: entry.commit.author.email,
      },
      changes,
      created_at: Date.parse(entry.commit.author.date) || undefined,
    });
    parentCs = created.changeset.id;
    cursor++;
    await updateJob(env, job.id, {
      commitsDone: cursor,
      checkpoint: {
        ...checkpoint,
        ref,
        cursor,
        last_cs: parentCs,
        github_sha: entry.sha,
        ...warnings.fields(),
        ...(entry.parents && entry.parents.length > 1
          ? { merge_imported_single_parent: true }
          : {}),
      },
    });
    if (cursor % 50 === 0) {
      const verify = await getChangeset(env, job.repo_id, parentCs);
      if (!verify) throw new Error(`checkpoint sanity failed at cursor ${cursor}`);
    }
  }

  // 3. land
  if (parentCs !== null) {
    await landOnce(env, job.repo_id, parentCs);
  }
}

type ImportChange =
  | { path: string; op: 'del' }
  | { path: string; op: 'add' | 'mod'; content_b64: string }
  | { path: string; op: 'add' | 'mod'; blob_sha256: string };

export type ImportWarning = Record<string, string | number>;

/** Job-checkpoint warnings: kept up to MAX_WARNINGS, the rest counted. */
class WarningLog {
  private list: ImportWarning[];
  private dropped: number;
  constructor(checkpoint: Record<string, unknown>) {
    this.list = Array.isArray(checkpoint.warnings)
      ? (checkpoint.warnings as ImportWarning[])
      : [];
    this.dropped =
      typeof checkpoint.warnings_dropped === 'number' ? checkpoint.warnings_dropped : 0;
  }
  add(items: ImportWarning[]): void {
    for (const item of items) {
      if (this.list.length < MAX_WARNINGS) this.list.push(item);
      else this.dropped++;
    }
  }
  fields(): Record<string, unknown> {
    if (this.list.length === 0) return {};
    return {
      warnings: this.list,
      ...(this.dropped > 0 ? { warnings_dropped: this.dropped } : {}),
    };
  }
}

async function changesForCommit(
  env: Env,
  opts: {
    installationId: number;
    owner: string;
    name: string;
    repoId: string;
    parentCs: string | null;
    entry: GithubCommit;
  },
): Promise<{ changes: ImportChange[]; warnings: ImportWarning[] }> {
  const { installationId, owner, name, entry } = opts;
  // the commit API pages its file list (300 per page, `Link: rel="next"`)
  const files: NonNullable<GithubCommit['files']> = [];
  let next: string | null = `/repos/${owner}/${name}/commits/${entry.sha}`;
  while (next !== null && files.length <= MAX_FILES_PER_COMMIT) {
    const detailRes = await githubApi(env, installationId, next);
    if (!detailRes.ok) throw new Error(`commit fetch failed: ${detailRes.status}`);
    const detail = (await detailRes.json()) as GithubCommit;
    files.push(...(detail.files ?? []));
    next = nextPage(detailRes.headers.get('link'));
  }
  if (files.length > MAX_FILES_PER_COMMIT) {
    // too big to replay file-by-file: import the tree at this commit instead
    const snapshot = await snapshotChangesAt(env, opts);
    return {
      changes: snapshot.changes,
      warnings: [
        {
          commit: entry.sha,
          warning: 'snapshot_fallback',
          reason: `commit touches more than ${MAX_FILES_PER_COMMIT} files`,
        },
        ...snapshot.warnings,
      ],
    };
  }

  const changes: ImportChange[] = [];
  const warnings: ImportWarning[] = [];
  for (const file of files) {
    if (file.status === 'removed') {
      changes.push({ path: file.filename, op: 'del' });
      continue;
    }
    if (file.status === 'renamed' && file.previous_filename) {
      changes.push({ path: file.previous_filename, op: 'del' });
    }
    const fetched = await fileContentAt(env, opts, file);
    if ('skipped' in fetched) {
      warnings.push({ commit: entry.sha, path: file.filename, ...fetched });
      continue;
    }
    changes.push({
      path: file.filename,
      op: file.status === 'added' || file.status === 'renamed' ? 'add' : 'mod',
      content_b64: fetched.content_b64,
    });
  }
  return { changes, warnings };
}

/**
 * File content at a commit. The contents API inlines base64 only up to 1 MiB
 * (`encoding: "none"` above that), so larger files come from the git blobs
 * API by the file's blob sha (base64 up to 100 MiB).
 */
async function fileContentAt(
  env: Env,
  opts: { installationId: number; owner: string; name: string; entry: GithubCommit },
  file: { filename: string; sha?: string },
): Promise<{ content_b64: string } | { skipped: string; status?: number }> {
  const { installationId, owner, name, entry } = opts;
  const contentRes = await githubApi(
    env,
    installationId,
    `/repos/${owner}/${name}/contents/${file.filename}?ref=${entry.sha}`,
  );
  if (contentRes.ok) {
    const content = (await contentRes.json()) as {
      content?: string;
      encoding?: string;
      size?: number;
      sha?: string;
    };
    if (content.encoding === 'base64' && typeof content.content === 'string') {
      return { content_b64: content.content.replace(/\n/g, '') };
    }
    if ((content.size ?? 0) > MAX_FILE_BYTES) return { skipped: 'too_large' };
    file = { ...file, sha: file.sha ?? content.sha };
  }
  if (!file.sha) {
    return { skipped: 'fetch_failed', status: contentRes.status };
  }
  const blobRes = await githubApi(
    env,
    installationId,
    `/repos/${owner}/${name}/git/blobs/${file.sha}`,
  );
  if (!blobRes.ok) return { skipped: 'fetch_failed', status: blobRes.status };
  const blob = (await blobRes.json()) as {
    content?: string;
    encoding?: string;
    size?: number;
  };
  if ((blob.size ?? 0) > MAX_FILE_BYTES) return { skipped: 'too_large' };
  if (blob.encoding !== 'base64' || typeof blob.content !== 'string') {
    return { skipped: 'unsupported_encoding' };
  }
  return { content_b64: blob.content.replace(/\n/g, '') };
}

/** `Link` header → the rel="next" API path, or null on the last page. */
function nextPage(link: string | null): string | null {
  const match = link
    ? /<https:\/\/api\.github\.com([^>]+)>;\s*rel="next"/.exec(link)
    : null;
  return match ? (match[1] as string) : null;
}

/**
 * Snapshot-at-commit fallback: the commit's tarball, diffed against the
 * parent changeset's tree, as content-addressed changes. Oversized tar
 * entries are skipped (kept at their parent version) with a warning.
 */
async function snapshotChangesAt(
  env: Env,
  opts: {
    installationId: number;
    owner: string;
    name: string;
    repoId: string;
    parentCs: string | null;
    entry: GithubCommit;
  },
): Promise<{ changes: ImportChange[]; warnings: ImportWarning[] }> {
  const { installationId, owner, name, repoId, parentCs, entry } = opts;
  const tarRes = await githubApi(
    env,
    installationId,
    `/repos/${owner}/${name}/tarball/${entry.sha}`,
  );
  if (!tarRes.ok || !tarRes.body) {
    throw new Error(`tarball fetch failed: ${tarRes.status}`);
  }
  const parentTree = parentCs
    ? (await getChangeset(env, repoId, parentCs))?.root_tree
    : null;
  const before = new Map(
    (parentTree ? await treeFiles(env, repoId, parentTree) : []).map((f) => [
      f.path,
      f.hash,
    ]),
  );

  const upserts: ImportChange[] = [];
  const warnings: ImportWarning[] = [];
  const seen = new Set<string>();
  const tar = parseTar(await gunzipIfNeeded(tarRes.body, true), {
    maxBodyBytes: MAX_FILE_BYTES,
  });
  for await (const item of tar) {
    if (item.type !== 'file' && item.type !== 'symlink') continue; // dirs are implicit
    const path = item.name.replace(/^[^/]+\//, '');
    seen.add(path);
    if (item.skipped) {
      warnings.push({ commit: entry.sha, path, skipped: 'too_large' });
      continue;
    }
    const put = await putBlob(env, repoId, item.body);
    const prev = before.get(path);
    if (prev === put.hash) continue;
    upserts.push({ path, op: prev === undefined ? 'add' : 'mod', blob_sha256: put.hash });
  }
  // deletions first, so a file → directory swap can land in one changeset
  const deletes: ImportChange[] = [...before.keys()]
    .filter((path) => !seen.has(path))
    .map((path) => ({ path, op: 'del' as const }));
  return { changes: [...deletes, ...upserts], warnings };
}

/** Single CAS land (from whatever main currently is). */
export async function landOnce(env: Env, repoId: string, csId: string): Promise<void> {
  const current = await q1(
    env,
    `SELECT ${C.refs.head} FROM ${T.refs} WHERE ${C.refs.repoId} = ? AND ${C.refs.name} = 'main'`,
    [repoId],
  );
  const head = current ? ((current as { head: string }).head as string) : null;
  await moveRefViaDO(env, repoId, 'main', { from: head, to: csId });
}

// ---------------------------------------------------------------------------
// Incremental sync (push webhooks) — rebase-and-retry CAS
// ---------------------------------------------------------------------------

async function incrementalSyncFromPush(
  env: Env,
  message: Extract<ImportMessage, { type: 'github_push' }>,
): Promise<void> {
  const repoRow = await q1(env, `SELECT * FROM ${T.repos} WHERE ${C.repos.id} = ?`, [
    message.repo_id,
  ]);
  const installationId = (repoRow as { github_installation_id?: number | null })
    .github_installation_id;
  const slug = (repoRow as { slug: string }).slug;
  if (!installationId) return;
  const [owner, name] = slug.split('/') as [string, string];

  const jobRow = await q1(
    env,
    `SELECT * FROM ${T.importJobs} WHERE ${C.importJobs.repoId} = ? ORDER BY ${C.importJobs.updatedAt} DESC`,
    [message.repo_id],
  );
  const checkpoint = jobRow ? (parseJob(jobRow).checkpoint ?? {}) : {};
  const base = String(checkpoint.github_sha ?? message.after);

  const compareRes = await githubApi(
    env,
    installationId,
    `/repos/${owner}/${name}/compare/${base}...${message.after}`,
  );
  if (!compareRes.ok) return;
  const compare = (await compareRes.json()) as { commits?: GithubCommit[] };
  const incoming = compare.commits ?? [];
  if (incoming.length === 0) return;

  // rebase-and-retry (≤ 3): re-emit every incoming commit onto whatever main
  // is NOW, then CAS — a stale CAS means someone else landed first
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await q1(
      env,
      `SELECT ${C.refs.head} FROM ${T.refs} WHERE ${C.refs.repoId} = ? AND ${C.refs.name} = 'main'`,
      [message.repo_id],
    );
    const head = current ? ((current as { head: string }).head as string) : null;
    let parentCs = head;
    const warnings = new WarningLog(checkpoint);
    for (const entry of incoming) {
      const { changes, warnings: commitWarnings } = await changesForCommit(env, {
        installationId,
        owner,
        name,
        repoId: message.repo_id,
        parentCs,
        entry,
      });
      warnings.add(commitWarnings);
      const created = await commitChanges(env, message.repo_id, {
        first_parent: parentCs,
        message: entry.commit.message,
        author: {
          name: entry.commit.author.name,
          email: entry.commit.author.email,
        },
        changes,
        created_at: Date.parse(entry.commit.author.date) || undefined,
      });
      parentCs = created.changeset.id;
    }
    if (parentCs === null) return;
    try {
      await moveRefViaDO(env, message.repo_id, 'main', {
        from: head,
        to: parentCs,
      });
      if (jobRow) {
        await updateJob(env, parseJob(jobRow).id, {
          status: 'done',
          checkpoint: { ...checkpoint, ...warnings.fields(), github_sha: message.after },
        });
      }
      return;
    } catch (err) {
      if (!(err instanceof ConflictError) || attempt === 2) throw err;
      // stale — loop re-emits with the new head as first_parent
    }
  }
}

// ---------------------------------------------------------------------------

async function requireInstallation(env: Env, repoId: string): Promise<number> {
  const row = await q1(env, `SELECT * FROM ${T.repos} WHERE ${C.repos.id} = ?`, [repoId]);
  const installationId = (row as { github_installation_id?: number | null })
    .github_installation_id;
  if (!installationId) {
    throw new RequestValidationError('repo is not connected', {}, 'not_connected');
  }
  return installationId;
}
