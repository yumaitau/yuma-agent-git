import type { Env } from '../env';
import { q, q1, run } from '../db/client';
import { getRepo } from '../db/repos';
import { ApiError } from '../core/errors';
import { MAX_TIMEOUT_S, type CiRun } from './config';
import { parseContext } from './context';
import { storeArtifact } from './artifacts';
import { poolFor } from './capacity';

/**
 * Dependency caches (issue #51), stored at R2 `ci/cache/<repo>/<scope>/<id>`.
 * An entry is immutable: reserve a key, upload once (which commits it), then
 * restore. Isolation, so untrusted refs cannot poison trusted ones:
 *
 * - a job writes only its own scope: the branch or tag it ran for, its pull
 *   request (`refs/pull/<n>`, fork or not), its merge group, or its revision
 *   when it ran for no ref;
 * - a job reads its own scope, then the default branch's.
 *
 * So a pull request job can never write an entry a `main` job reads. Entries
 * unused for 7 days are swept, and each repo stays under its pool's quota
 * (10 GiB by default) by evicting the least recently used first.
 */
export const CACHE_IDLE_MS = 7 * 24 * 60 * 60_000;
/** One upload is one request, so the Workers plan's request body limit also applies. */
export const MAX_CACHE_BYTES = 500 * 1024 * 1024;
/** Printable ASCII without spaces or commas (restore keys are comma-separated). */
export const CACHE_KEY = /^[\x21-\x2b\x2d-\x7e]{1,512}$/;
const PENDING_MS = (MAX_TIMEOUT_S + 600) * 1000;

export interface CacheRow {
  id: string;
  repo_id: string;
  scope: string;
  key: string;
  state: 'pending' | 'ready';
  size: number;
  object_key: string;
  ci_run_id: string;
  created_at: number;
  last_used_at: number;
}

export function cacheView(row: CacheRow) {
  return {
    id: row.id,
    key: row.key,
    scope: row.scope,
    state: row.state,
    size: row.size,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
  };
}

/** Where a job may write a cache, and where it reads from, in order. */
export function cacheScopes(
  job: CiRun,
  defaultBranch: string,
): { write: string; read: string[] } {
  const context = parseContext(job.context);
  const ref = context?.ref ?? null;
  const pull =
    (ref && /^refs\/pull\/(\d+)\//.exec(ref)?.[1]) ||
    (context?.event === 'pull_request' ? context.pull_id : null);
  // a pull request never shares a scope with a branch, whatever its ref says
  const own = pull
    ? `refs/pull/${pull}`
    : context?.event !== 'pull_request' && ref
      ? ref
      : `revision/${job.head_cs}`;
  const base = `refs/heads/${defaultBranch}`;
  return { write: own, read: own === base ? [own] : [own, base] };
}

async function scopesOf(env: Env, job: CiRun): Promise<{ write: string; read: string[] }> {
  const repo = await getRepo(env, job.repo_id);
  if (!repo) throw new ApiError(404, 'repo_not_found', 'Repository not found');
  return cacheScopes(job, repo.default_branch);
}

function checkKey(key: string): void {
  if (!CACHE_KEY.test(key))
    throw new ApiError(
      400,
      'invalid_cache_key',
      'Cache keys are 1 to 512 printable characters without spaces or commas.',
    );
}

/** Reserve `key` in the job's own scope; 409 when the entry exists or is being written. */
export async function reserveCache(env: Env, job: CiRun, key: string): Promise<CacheRow> {
  checkKey(key);
  const { write } = await scopesOf(env, job);
  // a reservation whose job ended without uploading frees the key
  await run(
    env,
    `DELETE FROM ci_caches WHERE repo_id = ? AND scope = ? AND key = ? AND state = 'pending'
    AND NOT EXISTS (SELECT 1 FROM ci_runs r WHERE r.id = ci_caches.ci_run_id AND r.state = 'running')`,
    [job.repo_id, write, key],
  );
  const id = crypto.randomUUID();
  const now = Date.now();
  const row = await q1<CacheRow>(
    env,
    `INSERT INTO ci_caches (id, repo_id, scope, key, state, object_key, ci_run_id, created_at, last_used_at)
    VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)
    ON CONFLICT (repo_id, scope, key) DO NOTHING RETURNING *`,
    [
      id,
      job.repo_id,
      write,
      key,
      `ci/cache/${job.repo_id}/${encodeURIComponent(write)}/${id}`,
      job.id,
      now,
      now,
    ],
  );
  if (!row)
    throw new ApiError(409, 'cache_exists', 'This cache key already exists in this scope.');
  return row;
}

/** Upload a reserved entry once and commit it; then evict down to the quota. */
export async function uploadCache(
  env: Env,
  job: CiRun,
  id: string,
  body: ReadableStream<Uint8Array>,
): Promise<CacheRow> {
  const row = await q1<CacheRow>(
    env,
    "SELECT * FROM ci_caches WHERE id = ? AND ci_run_id = ? AND state = 'pending'",
    [id, job.id],
  );
  if (!row)
    throw new ApiError(404, 'cache_not_found', 'No reservation of this job with this id.');
  let size: number;
  try {
    size = await storeArtifact(env.OBJECTS, row.object_key, body, MAX_CACHE_BYTES);
  } catch {
    await run(env, 'DELETE FROM ci_caches WHERE id = ?', [id]);
    throw new ApiError(
      413,
      'cache_rejected',
      'Cache entries must be non-empty and 500 MiB at most.',
    );
  }
  const committed = await q1<CacheRow>(
    env,
    `UPDATE ci_caches SET state = 'ready', size = ?, last_used_at = ?
    WHERE id = ? AND state = 'pending' RETURNING *`,
    [size, Date.now(), id],
  );
  if (!committed) {
    await env.OBJECTS.delete(row.object_key);
    throw new ApiError(409, 'cache_exists', 'This entry was already committed.');
  }
  await evictCaches(env, job.repo_id);
  return committed;
}

/**
 * The newest entry a job may read: in each readable scope, the exact key,
 * then each restore key as a prefix. Marks it used.
 */
export async function restoreCache(
  env: Env,
  job: CiRun,
  key: string,
  restoreKeys: string[],
): Promise<CacheRow | null> {
  for (const k of [key, ...restoreKeys]) checkKey(k);
  const { read } = await scopesOf(env, job);
  for (const scope of read) {
    for (const [i, k] of [key, ...restoreKeys].entries()) {
      const row = await q1<CacheRow>(
        env,
        `SELECT * FROM ci_caches WHERE repo_id = ? AND scope = ? AND state = 'ready'
        AND ${i === 0 ? 'key = ?' : 'substr(key, 1, length(?)) = ?'}
        ORDER BY created_at DESC LIMIT 1`,
        i === 0 ? [job.repo_id, scope, k] : [job.repo_id, scope, k, k],
      );
      if (!row) continue;
      await run(env, 'UPDATE ci_caches SET last_used_at = ? WHERE id = ?', [
        Date.now(),
        row.id,
      ]);
      return row;
    }
  }
  return null;
}

export async function deleteCaches(
  env: Env,
  rows: Pick<CacheRow, 'id' | 'object_key'>[],
): Promise<void> {
  if (!rows.length) return;
  await env.OBJECTS.delete(rows.map((r) => r.object_key));
  await env.DB.batch(
    rows.map((r) => env.DB.prepare('DELETE FROM ci_caches WHERE id = ?').bind(r.id)),
  );
}

/** Least recently used entries go first until the repo is within its quota. */
export async function evictCaches(env: Env, repoId: string): Promise<void> {
  const quota = (await poolFor(env, repoId)).limits.cache_quota_bytes;
  for (;;) {
    const total =
      (
        await q1<{ total: number }>(
          env,
          "SELECT COALESCE(SUM(size), 0) AS total FROM ci_caches WHERE repo_id = ? AND state = 'ready'",
          [repoId],
        )
      )?.total ?? 0;
    if (total <= quota) return;
    const oldest = await q<CacheRow>(
      env,
      `SELECT * FROM ci_caches WHERE repo_id = ? AND state = 'ready'
      ORDER BY last_used_at, created_at LIMIT 50`,
      [repoId],
    );
    const victims: CacheRow[] = [];
    let over = total - quota;
    for (const row of oldest) {
      if (over <= 0) break;
      victims.push(row);
      over -= row.size;
    }
    await deleteCaches(env, victims);
  }
}

/** Cron: entries unused for 7 days, and reservations that were never uploaded. */
export async function sweepCaches(env: Env): Promise<void> {
  const now = Date.now();
  const stale = await q<CacheRow>(
    env,
    `SELECT * FROM ci_caches WHERE (state = 'ready' AND last_used_at < ?)
    OR (state = 'pending' AND created_at < ?) LIMIT 100`,
    [now - CACHE_IDLE_MS, now - PENDING_MS],
  );
  await deleteCaches(env, stale);
}
