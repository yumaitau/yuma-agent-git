import { z } from 'zod';
import type { Env } from '../env';
import { C, T } from '../db/schema';
import { q1, run } from '../db/client';
import { getChangeset } from '../core/changesets';
import { getBlob } from '../core/blobs';
import { diffRevisions, type FileDiff } from '../core/diff';
import { treeFiles } from './fastimport';
import { RequestValidationError } from '../core/errors';
import { ulid } from '../core/ids';
import { githubApi } from './github';

/**
 * GitHub contents-sync bridge (issue #16) — the "agents land work back to
 * GitHub" path (#19). Unlike git, GitHub has no fast-import endpoint, so the
 * sync is per-file through the Contents API:
 *
 *   - diff the requested head (default: the repo's default-branch head) vs
 *     the last-synced changeset (tracked in `export_jobs`)
 *   - PUT/DELETE each changed file on the target branch (≤100 per run;
 *     larger diffs continue as queued batches, resuming from an
 *     `ExportCursor` carried by the continuation message)
 *   - honor `X-RateLimit-Remaining` and requeue with a delay when tight
 *   - record `{head_cs, github_sha}` (the last GitHub commit written) so the
 *     next sync is incremental
 */

export const MAX_FILES_PER_SYNC = 100;
const RATE_LIMIT_FLOOR = 50;

export type GitImportMessage =
  | { type: 'import_job'; job_id: string }
  | {
      type: 'github_push';
      repo_id: string;
      github_repo_id: number;
      ref: string;
      after: string;
    }
  | { type: 'export_job'; job_id: string; cursor?: ExportCursor };

/** Continuation state for a multi-batch export, carried by the queued message. */
export interface ExportCursor {
  base: string | null; // changeset last synced (null = full tree)
  head: string; // changeset this job syncs
  offset: number; // files already pushed
  github_sha: string | null; // latest GitHub commit sha written so far
}

const exportRequestSchema = z.object({
  target_branch: z.string().min(1).default('yag-sync'),
  head: z.string().optional(),
});

export async function startExportToGithub(
  env: Env,
  repoId: string,
  body: unknown,
): Promise<{ job_id: string }> {
  const parsed = exportRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new RequestValidationError('invalid export request', {
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    });
  }
  const repoRow = await q1(env, `SELECT * FROM ${T.repos} WHERE ${C.repos.id} = ?`, [
    repoId,
  ]);
  const installationId = (repoRow as { github_installation_id?: number | null })
    .github_installation_id;
  if (!installationId) {
    throw new RequestValidationError('repo is not connected', {}, 'not_connected');
  }

  const jobId = ulid();
  const now = Date.now();
  await run(
    env,
    `INSERT INTO ${T.exportJobs}
       (${C.exportJobs.id}, ${C.exportJobs.repoId}, ${C.exportJobs.direction}, ${C.exportJobs.target},
        ${C.exportJobs.headCs}, ${C.exportJobs.githubSha}, ${C.exportJobs.status},
        ${C.exportJobs.createdAt}, ${C.exportJobs.updatedAt})
     VALUES (?, ?, 'to_github', ?, ?, NULL, 'queued', ?, ?)`,
    [jobId, repoId, parsed.data.target_branch, parsed.data.head ?? null, now, now],
  );
  await env.IMPORT_QUEUE.send({
    type: 'export_job',
    job_id: jobId,
  } satisfies GitImportMessage);
  return { job_id: jobId };
}

export async function runExportJob(
  env: Env,
  jobId: string,
  cursor?: ExportCursor,
): Promise<void> {
  const row = await q1(
    env,
    `SELECT * FROM ${T.exportJobs} WHERE ${C.exportJobs.id} = ?`,
    [jobId],
  );
  if (!row) return;
  const job = row as {
    id: string;
    repo_id: string;
    target: string;
    head_cs: string | null;
    status: string;
  };
  // at-least-once delivery: a finished job must not re-push
  if (job.status === 'done' || job.status === 'failed') return;
  await setStatus(env, jobId, 'running');

  const repoRow = await q1(env, `SELECT * FROM ${T.repos} WHERE ${C.repos.id} = ?`, [
    job.repo_id,
  ]);
  const repo = repoRow as {
    slug: string;
    default_branch: string;
    github_installation_id?: number | null;
  };
  const installationId = repo.github_installation_id;
  if (!installationId) {
    await setStatus(env, jobId, 'failed');
    return;
  }
  const [owner, name] = repo.slug.split('/') as [string, string];

  // The first run pins {base, head}; continuation batches carry them in the
  // cursor so the file list (and its order) is identical across runs.
  let base: string | null;
  let headCs: string;
  let githubSha: string | null;
  if (cursor) {
    base = cursor.base;
    headCs = cursor.head;
    githubSha = cursor.github_sha;
  } else {
    // base: what the last successful sync pushed
    const last = (await q1(
      env,
      `SELECT * FROM ${T.exportJobs}
        WHERE ${C.exportJobs.repoId} = ? AND ${C.exportJobs.status} = 'done'
          AND ${C.exportJobs.headCs} IS NOT NULL AND ${C.exportJobs.id} != ?
        ORDER BY ${C.exportJobs.updatedAt} DESC`,
      [job.repo_id, jobId],
    )) as { head_cs: string; github_sha: string | null } | null;
    base = last?.head_cs ?? null;
    githubSha = last?.github_sha ?? null;
    // target: the requested head, else the default branch head
    if (job.head_cs) {
      headCs = job.head_cs;
    } else {
      const headRow = (await q1(
        env,
        `SELECT ${C.refs.head} FROM ${T.refs} WHERE ${C.refs.repoId} = ? AND ${C.refs.name} = ?`,
        [job.repo_id, repo.default_branch],
      )) as { head: string } | null;
      if (!headRow) {
        await setStatus(env, jobId, 'failed');
        return;
      }
      headCs = headRow.head;
    }
  }
  const head = await getChangeset(env, job.repo_id, headCs);
  if (!head) {
    await setStatus(env, jobId, 'failed');
    return;
  }

  // first sync pushes everything; later runs push the delta (uncapped — the
  // cursor pages through it, ≤100 files per run)
  const files: FileDiff[] =
    base === null
      ? (await treeFiles(env, job.repo_id, head.root_tree as string)).map((f) => ({
          path: f.path,
          kind: 'add' as const,
          new_hash: f.hash,
        }))
      : base === headCs
        ? []
        : (
            await diffRevisions(env, job.repo_id, base, headCs, {
              mode: 'direct',
              maxFiles: Number.MAX_SAFE_INTEGER,
            })
          ).files;
  const offset = cursor?.offset ?? 0;
  const batch = files.slice(offset, offset + MAX_FILES_PER_SYNC);
  const message = `${head.message.split('\n')[0] as string}${
    batch.length > 1 ? ` (+${batch.length - 1} more)` : ''
  }`;
  const next = (done: number): GitImportMessage => ({
    type: 'export_job',
    job_id: jobId,
    cursor: { base, head: headCs, offset: done, github_sha: githubSha },
  });

  for (const [i, file] of batch.entries()) {
    const result = await syncFile(env, {
      installationId,
      repoId: job.repo_id,
      owner,
      name,
      branch: job.target,
      path: file.path,
      kind: file.kind,
      oldHash: file.old_hash,
      newHash: file.new_hash,
      message,
    });
    if (result.commitSha) githubSha = result.commitSha;
    if (result.rateLimited) {
      // honor the rate limit: requeue with a delay, resume after this file
      await env.IMPORT_QUEUE.send(next(offset + i + (result.refused ? 0 : 1)), {
        delaySeconds: 60,
      });
      await setStatus(env, jobId, 'queued');
      return;
    }
  }

  if (offset + batch.length < files.length) {
    // larger diffs continue as queued batches from the persisted cursor
    await env.IMPORT_QUEUE.send(next(offset + batch.length));
    return;
  }

  await run(
    env,
    `UPDATE ${T.exportJobs}
        SET ${C.exportJobs.headCs} = ?, ${C.exportJobs.githubSha} = ?,
            ${C.exportJobs.status} = 'done', ${C.exportJobs.updatedAt} = ?
      WHERE ${C.exportJobs.id} = ?`,
    [headCs, githubSha, Date.now(), jobId],
  );
}

async function syncFile(
  env: Env,
  opts: {
    installationId: number;
    repoId: string;
    owner: string;
    name: string;
    branch: string;
    path: string;
    kind: string;
    oldHash?: string;
    newHash?: string;
    message: string;
  },
): Promise<SyncResult> {
  const { installationId, owner, name, branch, path, message } = opts;
  const contentsUrl = `/repos/${owner}/${name}/contents/${path}`;

  if (opts.kind === 'del') {
    const existing = await githubApi(env, installationId, `${contentsUrl}?ref=${branch}`);
    if (!existing.ok) return NOT_SYNCED;
    const info = (await existing.json()) as { sha: string };
    const res = await githubApi(env, installationId, contentsUrl, {
      method: 'DELETE',
      body: JSON.stringify({ message, sha: info.sha, branch }),
    });
    return syncResult(res);
  }

  // add / mod: content travels base64 through the Contents API
  const blob = opts.newHash ? await getBlob(env, opts.repoId, opts.newHash) : null;
  if (!blob) return NOT_SYNCED;
  // updates need the CURRENT GitHub blob sha (git's sha1 space — different
  // from our sha256 addresses — so ask GitHub, never derive)
  let updateSha: string | undefined;
  if (opts.kind === 'mod') {
    const existing = await githubApi(env, installationId, `${contentsUrl}?ref=${branch}`);
    if (existing.ok) {
      updateSha = ((await existing.json()) as { sha: string }).sha;
    }
  }
  const res = await githubApi(env, installationId, contentsUrl, {
    method: 'PUT',
    body: JSON.stringify({
      message,
      content: bytesToB64(blob.content),
      branch,
      ...(updateSha ? { sha: updateSha } : {}),
    }),
  });
  return syncResult(res);
}

interface SyncResult {
  rateLimited: boolean;
  /** the request itself was refused by the rate limiter — redo this file */
  refused: boolean;
  /** GitHub commit sha the write produced */
  commitSha: string | null;
}

const NOT_SYNCED: SyncResult = { rateLimited: false, refused: false, commitSha: null };

async function syncResult(res: Response): Promise<SyncResult> {
  const commitSha = res.ok
    ? (((await res.json().catch(() => null)) as { commit?: { sha?: string } } | null)
        ?.commit?.sha ?? null)
    : null;
  return {
    rateLimited: isRateLimited(res),
    refused: res.status === 403 || res.status === 429,
    commitSha,
  };
}

function bytesToB64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function isRateLimited(res: Response): boolean {
  const remaining = Number(res.headers.get('x-ratelimit-remaining') ?? '1000');
  return remaining < RATE_LIMIT_FLOOR;
}

async function setStatus(env: Env, jobId: string, status: string): Promise<void> {
  await run(
    env,
    `UPDATE ${T.exportJobs} SET ${C.exportJobs.status} = ?, ${C.exportJobs.updatedAt} = ? WHERE ${C.exportJobs.id} = ?`,
    [status, Date.now(), jobId],
  );
}
