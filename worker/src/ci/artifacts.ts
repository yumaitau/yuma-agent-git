import type { Env } from '../env';
import { q, q1 } from '../db/client';
import { ApiError } from '../core/errors';
import type { CiRun } from './config';

/**
 * R2 multipart accepts streams of unknown total length without buffering an
 * image. Returns the bytes stored.
 */
export async function storeArtifact(
  bucket: R2Bucket,
  key: string,
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<number> {
  const upload = await bucket.createMultipartUpload(key);
  const reader = stream.getReader();
  const parts: R2UploadedPart[] = [];
  const size = 5 * 1024 * 1024;
  let buffer = new Uint8Array(size);
  let used = 0;
  let total = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > limit) throw new Error('Artifact exceeds size limit');
      for (let offset = 0; offset < chunk.value.length;) {
        const length = Math.min(size - used, chunk.value.length - offset);
        buffer.set(chunk.value.subarray(offset, offset + length), used);
        used += length;
        offset += length;
        if (used === size) {
          parts.push(await upload.uploadPart(parts.length + 1, buffer));
          buffer = new Uint8Array(size);
          used = 0;
        }
      }
    }
    if (used)
      parts.push(await upload.uploadPart(parts.length + 1, buffer.subarray(0, used)));
    if (!parts.length) throw new Error('Image export is empty');
    await upload.complete(parts);
    return total;
  } catch (error) {
    await reader.cancel().catch(() => {});
    await upload.abort();
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Run artifacts (issue #51): files a job uploads for later jobs of the same
 * run and for people on the run page. Names are unique per run (the pipeline
 * run, or the settings run); only the job that uploaded a name may replace
 * it. Kept 14 days; the cron sweep deletes them and an R2 lifecycle rule on
 * `ci/artifacts/` backs it up (docs/deploy.md).
 */
export const ARTIFACT_RETENTION_MS = 14 * 24 * 60 * 60_000;
export const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;
/** Per job. */
export const MAX_ARTIFACTS = 20;
export const ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export interface ArtifactRow {
  id: string;
  repo_id: string;
  run_scope: string;
  ci_run_id: string;
  job_key: string | null;
  name: string;
  size: number;
  object_key: string;
  created_at: number;
  expires_at: number;
}

export function artifactView(row: ArtifactRow) {
  return {
    id: row.id,
    name: row.name,
    size: row.size,
    ci_run_id: row.ci_run_id,
    job_key: row.job_key,
    created_at: row.created_at,
    expires_at: row.expires_at,
  };
}

/** Every job of a pipeline run shares its artifacts; a settings run has its own. */
export function runScope(job: CiRun): string {
  return job.pipeline_run_id ?? job.id;
}

export async function uploadArtifact(
  env: Env,
  job: CiRun,
  name: string,
  body: ReadableStream<Uint8Array>,
): Promise<ArtifactRow> {
  if (!ARTIFACT_NAME.test(name))
    throw new ApiError(400, 'invalid_artifact_name', 'Use letters, digits, ., _ or -.');
  const scope = runScope(job);
  const mine = await q<{ name: string }>(
    env,
    'SELECT name FROM ci_artifacts WHERE ci_run_id = ?',
    [job.id],
  );
  if (mine.length >= MAX_ARTIFACTS && !mine.some((a) => a.name === name))
    throw new ApiError(
      409,
      'too_many_artifacts',
      `A job keeps ${MAX_ARTIFACTS} artifacts at most.`,
    );
  const id = crypto.randomUUID();
  const key = `ci/artifacts/${scope}/${id}`;
  let size: number;
  try {
    size = await storeArtifact(env.OBJECTS, key, body, MAX_ARTIFACT_BYTES);
  } catch {
    throw new ApiError(
      413,
      'artifact_rejected',
      'Artifacts must be non-empty and 100 MiB at most.',
    );
  }
  const now = Date.now();
  const previous = await q1<{ object_key: string }>(
    env,
    'SELECT object_key FROM ci_artifacts WHERE run_scope = ? AND name = ? AND ci_run_id = ?',
    [scope, name, job.id],
  );
  // another job's artifact of the same name is never replaced
  const row = await q1<ArtifactRow>(
    env,
    `INSERT INTO ci_artifacts (id, repo_id, run_scope, ci_run_id, job_key, name, size, object_key, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (run_scope, name) DO UPDATE SET id = excluded.id, size = excluded.size,
      object_key = excluded.object_key, created_at = excluded.created_at,
      expires_at = excluded.expires_at
    WHERE ci_artifacts.ci_run_id = excluded.ci_run_id
    RETURNING *`,
    [
      id,
      job.repo_id,
      scope,
      job.id,
      job.job_key ?? null,
      name,
      size,
      key,
      now,
      now + ARTIFACT_RETENTION_MS,
    ],
  );
  if (!row) {
    await env.OBJECTS.delete(key);
    throw new ApiError(
      409,
      'artifact_exists',
      'Another job of this run already uploaded an artifact with this name.',
    );
  }
  if (previous) await env.OBJECTS.delete(previous.object_key);
  return row;
}

/** Live artifacts of a run scope, or of one job. */
export async function listArtifacts(
  env: Env,
  where: { scope: string } | { ciRunId: string },
): Promise<ArtifactRow[]> {
  const [column, value] =
    'scope' in where ? ['run_scope', where.scope] : ['ci_run_id', where.ciRunId];
  return q<ArtifactRow>(
    env,
    `SELECT * FROM ci_artifacts WHERE ${column} = ? AND expires_at > ? ORDER BY name`,
    [value, Date.now()],
  );
}

/** Stream one artifact; 404 once it has expired. */
export async function artifactResponse(
  env: Env,
  row: ArtifactRow | null,
): Promise<Response> {
  const object =
    row && row.expires_at > Date.now() ? await env.OBJECTS.get(row.object_key) : null;
  if (!row || !object)
    throw new ApiError(404, 'artifact_not_found', 'No such artifact, or it has expired.');
  return new Response(object.body, {
    headers: {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="${row.name}"`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
    },
  });
}

/** Cron: delete expired artifacts, a batch at a time. */
export async function sweepArtifacts(env: Env): Promise<void> {
  const expired = await q<{ id: string; object_key: string }>(
    env,
    'SELECT id, object_key FROM ci_artifacts WHERE expires_at <= ? LIMIT 100',
    [Date.now()],
  );
  if (!expired.length) return;
  await env.OBJECTS.delete(expired.map((a) => a.object_key));
  await env.DB.batch(
    expired.map((a) =>
      env.DB.prepare('DELETE FROM ci_artifacts WHERE id = ?').bind(a.id),
    ),
  );
}
