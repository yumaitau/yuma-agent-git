import { z } from 'zod';
import type { Env } from '../env';
import { ApiError } from '../core/errors';
import { ulid } from '../core/ids';
import { q1 } from '../db/client';

/**
 * Registry bytes in R2 (issue #53). Blobs are content addressed at
 * `registry/blobs/sha256/<hex>`; R2 checks the SHA-256 as it stores, so a
 * blob is never kept under a digest it does not have. Chunked uploads stream
 * into an R2 multipart upload in fixed parts; only the bytes below one part
 * are held in memory, and between requests they wait in a tail object. The
 * finished upload is then streamed once more into its blob key, which is
 * where the digest is checked. Nothing buffers a whole layer.
 */

export const BLOB_PREFIX = 'registry/blobs/sha256/';
const UPLOAD_PREFIX = 'registry/uploads/';
/** R2 multipart parts must match in size, except the last; at least 5 MiB. */
export const PART_SIZE = 8 * 1024 * 1024;
export const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const DEFAULT_QUOTA_BYTES = 10 * 1024 ** 3;

/** An OCI-coded failure; routes answer it in the OCI error format. */
export class RegistryError extends ApiError {
  readonly oci: string;
  constructor(
    status: number,
    oci: string,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(status, oci.toLowerCase(), message, details);
    this.oci = oci;
  }
}

export function blobKey(digest: string): string {
  return `${BLOB_PREFIX}${digest.slice('sha256:'.length)}`;
}

/** Store bytes under `digest`, refused by R2 unless the SHA-256 matches. */
export async function putVerifiedBlob(
  env: Env,
  digest: string,
  body: ReadableStream | Uint8Array,
  size: number,
): Promise<void> {
  if (!DIGEST_RE.test(digest))
    throw new RegistryError(400, 'DIGEST_INVALID', 'only sha256 digests are supported');
  const value =
    body instanceof Uint8Array ? body : body.pipeThrough(new FixedLengthStream(size));
  try {
    await env.OBJECTS.put(blobKey(digest), value, {
      sha256: digest.slice('sha256:'.length),
    });
  } catch (err) {
    console.warn('registry: blob refused', digest, err);
    throw new RegistryError(
      400,
      'DIGEST_INVALID',
      'the uploaded content does not match the digest',
    );
  }
}

/** Per-owner storage quota (REGISTRY_QUOTA_BYTES, default 10 GiB). */
export function quotaBytes(env: Env): number {
  const n = Number(env.REGISTRY_QUOTA_BYTES);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_QUOTA_BYTES;
}

/** Bytes still free for `owner`; throws once the quota is used up. */
export async function freeBytes(env: Env, owner: string, adding = 0): Promise<number> {
  const row = await q1<{ used: number | null }>(
    env,
    `SELECT SUM(f.size) AS used FROM package_files f
       JOIN packages p ON p.id = f.package_id WHERE p.owner = ?`,
    [owner],
  );
  const free = quotaBytes(env) - (row?.used ?? 0);
  if (free < adding) throw quotaExceeded(env, owner);
  return free;
}

export function quotaExceeded(env: Env, owner: string): RegistryError {
  return new RegistryError(
    413,
    'DENIED',
    `the package storage quota for ${owner} (${quotaBytes(env)} bytes) is used up`,
    { reason: 'quota_exceeded' },
  );
}

// --- chunked uploads ---------------------------------------------------------

const partSchema = z.object({ partNumber: z.number().int(), etag: z.string() });
export const uploadRowSchema = z.object({
  id: z.string(),
  package_id: z.string(),
  r2_upload_id: z.string().nullable(),
  parts: z.string(),
  size: z.number().int(),
  created_by: z.string(),
  created_at: z.number(),
  updated_at: z.number(),
});
export type UploadRow = z.infer<typeof uploadRowSchema>;

const tailKey = (id: string): string => `${UPLOAD_PREFIX}${id}/tail`;
const dataKey = (id: string): string => `${UPLOAD_PREFIX}${id}/data`;

export async function startUpload(
  env: Env,
  packageId: string,
  userId: string,
): Promise<UploadRow> {
  const now = Date.now();
  const row: UploadRow = {
    id: ulid(),
    package_id: packageId,
    r2_upload_id: null,
    parts: '[]',
    size: 0,
    created_by: userId,
    created_at: now,
    updated_at: now,
  };
  await env.DB.prepare(
    `INSERT INTO registry_uploads (id, package_id, r2_upload_id, parts, size, created_by, created_at, updated_at)
     VALUES (?, ?, NULL, '[]', 0, ?, ?, ?)`,
  )
    .bind(row.id, packageId, userId, now, now)
    .run();
  return row;
}

export async function getUpload(
  env: Env,
  packageId: string,
  id: string,
): Promise<UploadRow | null> {
  const row = await q1(
    env,
    'SELECT * FROM registry_uploads WHERE id = ? AND package_id = ?',
    [id, packageId],
  );
  return row ? uploadRowSchema.parse(row) : null;
}

/**
 * Stream `body` onto the upload: every full part goes to R2 as it fills, the
 * rest becomes the tail. At most `limit` bytes in total. The row moves only
 * if nobody else appended meanwhile (416 otherwise).
 */
export async function appendUpload(
  env: Env,
  upload: UploadRow,
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<UploadRow> {
  const parts = z.array(partSchema).parse(JSON.parse(upload.parts));
  const buffer = new Uint8Array(PART_SIZE);
  let fill = 0;
  const tail = await env.OBJECTS.get(tailKey(upload.id));
  if (tail) {
    buffer.set(new Uint8Array(await tail.arrayBuffer()));
    fill = tail.size;
  }
  let r2Id = upload.r2_upload_id;
  let size = upload.size;
  const flush = async (): Promise<void> => {
    const multipart = r2Id
      ? env.OBJECTS.resumeMultipartUpload(dataKey(upload.id), r2Id)
      : await env.OBJECTS.createMultipartUpload(dataKey(upload.id));
    r2Id = multipart.uploadId;
    const part = await multipart.uploadPart(parts.length + 1, buffer);
    parts.push({ partNumber: part.partNumber, etag: part.etag });
    fill = 0;
  };
  if (body) {
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        throw new RegistryError(
          413,
          'SIZE_INVALID',
          `the upload exceeds ${limit} bytes`,
          {
            reason: 'quota_exceeded',
          },
        );
      }
      for (let offset = 0; offset < value.length;) {
        const take = Math.min(PART_SIZE - fill, value.length - offset);
        buffer.set(value.subarray(offset, offset + take), fill);
        fill += take;
        offset += take;
        if (fill === PART_SIZE) await flush();
      }
    }
  }
  if (fill > 0) await env.OBJECTS.put(tailKey(upload.id), buffer.subarray(0, fill));
  else await env.OBJECTS.delete(tailKey(upload.id));
  const next: UploadRow = {
    ...upload,
    r2_upload_id: r2Id,
    parts: JSON.stringify(parts),
    size,
    updated_at: Date.now(),
  };
  const res = await env.DB.prepare(
    `UPDATE registry_uploads SET r2_upload_id = ?, parts = ?, size = ?, updated_at = ?
      WHERE id = ? AND size = ?`,
  )
    .bind(
      next.r2_upload_id,
      next.parts,
      next.size,
      next.updated_at,
      upload.id,
      upload.size,
    )
    .run();
  if (res.meta.changes !== 1)
    throw new RegistryError(
      416,
      'BLOB_UPLOAD_INVALID',
      'the upload moved on; resume from its range',
    );
  return next;
}

/** Complete the upload into its blob key (digest checked there) and drop the session. */
export async function finishUpload(
  env: Env,
  upload: UploadRow,
  digest: string,
): Promise<void> {
  const tail = await env.OBJECTS.get(tailKey(upload.id));
  if (!upload.r2_upload_id) {
    await putVerifiedBlob(env, digest, tail?.body ?? new Uint8Array(0), tail?.size ?? 0);
  } else {
    const parts = z.array(partSchema).parse(JSON.parse(upload.parts));
    const multipart = env.OBJECTS.resumeMultipartUpload(
      dataKey(upload.id),
      upload.r2_upload_id,
    );
    if (tail) {
      const last = await multipart.uploadPart(
        parts.length + 1,
        new Uint8Array(await tail.arrayBuffer()),
      );
      parts.push({ partNumber: last.partNumber, etag: last.etag });
    }
    await multipart.complete(parts);
    const data = await env.OBJECTS.get(dataKey(upload.id));
    if (!data)
      throw new RegistryError(404, 'BLOB_UPLOAD_UNKNOWN', 'the upload data is gone');
    await putVerifiedBlob(env, digest, data.body, data.size);
  }
  await dropUpload(env, upload, false);
}

/** Forget an upload: its R2 parts, tail and row. */
export async function dropUpload(
  env: Env,
  upload: Pick<UploadRow, 'id' | 'r2_upload_id'>,
  abort = true,
): Promise<void> {
  if (abort && upload.r2_upload_id) {
    await env.OBJECTS.resumeMultipartUpload(dataKey(upload.id), upload.r2_upload_id)
      .abort()
      .catch(() => undefined);
  }
  await env.OBJECTS.delete([tailKey(upload.id), dataKey(upload.id)]);
  await env.DB.prepare('DELETE FROM registry_uploads WHERE id = ?').bind(upload.id).run();
}
