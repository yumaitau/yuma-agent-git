import type { Env } from '../env';
import { compressBytes, decompressBytes, parseCodec, preferredCodec } from './compress';
import { ObjectCorruptError } from './errors';
import { sha256Hex } from './hashing';

/**
 * Content-addressed blob store over R2 (architecture §1.1).
 *
 * Key layout: `repos/{repo_id}/blobs/{hash[0:2]}/{hash}`
 * Address = SHA-256 of uncompressed content. Immutable; re-writing an existing
 * hash is a no-op (dedup for free). No packfiles, ever.
 */

export function blobKey(repoId: string, hash: string): string {
  return `repos/${repoId}/blobs/${hash.slice(0, 2)}/${hash}`;
}

export interface PutBlobResult {
  hash: string;
  size: number;
  /** False when the object was already stored (dedupe). */
  stored: boolean;
}

/**
 * Store file content. Hashes uncompressed bytes, compresses with the
 * preferred codec, and skips the upload entirely when the hash exists.
 */
export async function putBlob(
  env: Env,
  repoId: string,
  content: Uint8Array,
): Promise<PutBlobResult> {
  const hash = await sha256Hex(content);
  const key = blobKey(repoId, hash);
  const existing = await env.OBJECTS.head(key);
  if (existing) {
    return { hash, size: content.byteLength, stored: false };
  }
  const codec = preferredCodec();
  const compressed = await compressBytes(content, codec);
  await env.OBJECTS.put(key, compressed, {
    httpMetadata: { contentType: 'application/octet-stream' },
    customMetadata: { size: String(content.byteLength), encoding: codec },
  });
  return { hash, size: content.byteLength, stored: true };
}

/**
 * Store a pre-compressed blob under a client-declared hash (client pre-upload
 * path). The compressed bytes are decompressed to measure the true size and to
 * confirm the content address before storing — cheap defense in depth; reads
 * verify again on every path.
 */
export async function putBlobByHash(
  env: Env,
  repoId: string,
  hash: string,
  compressedBytes: Uint8Array,
  codec = preferredCodec(),
): Promise<PutBlobResult> {
  const key = blobKey(repoId, hash);
  const existing = await env.OBJECTS.head(key);
  if (existing) {
    const size = Number(existing.customMetadata?.size ?? '0');
    return { hash, size: Number.isFinite(size) ? size : 0, stored: false };
  }
  const content = await decodeOrThrow(hash, compressedBytes, codec);
  const actual = await sha256Hex(content);
  if (actual !== hash) {
    throw new ObjectCorruptError('blob', hash, `hash mismatch: got ${actual}`);
  }
  await env.OBJECTS.put(key, compressedBytes, {
    httpMetadata: { contentType: 'application/octet-stream' },
    customMetadata: { size: String(content.byteLength), encoding: codec },
  });
  return { hash, size: content.byteLength, stored: true };
}

export interface BlobContent {
  content: Uint8Array;
  size: number;
}

/**
 * Read a blob: decompress, then **verify** sha256(content) === hash on every
 * read. Throws `ObjectCorruptError` on mismatch or undecodable bytes.
 */
export async function getBlob(
  env: Env,
  repoId: string,
  hash: string,
): Promise<BlobContent | null> {
  const obj = await env.OBJECTS.get(blobKey(repoId, hash));
  if (!obj) return null;
  const stored = new Uint8Array(await obj.arrayBuffer());
  const content = await decodeOrThrow(
    hash,
    stored,
    parseCodec(obj.customMetadata?.encoding),
  );
  const actual = await sha256Hex(content);
  if (actual !== hash) {
    throw new ObjectCorruptError('blob', hash, `hash mismatch: got ${actual}`);
  }
  return { content, size: content.byteLength };
}

async function decodeOrThrow(
  hash: string,
  bytes: Uint8Array,
  codec: ReturnType<typeof parseCodec>,
): Promise<Uint8Array> {
  try {
    return await decompressBytes(bytes, codec);
  } catch (err) {
    throw new ObjectCorruptError(
      'blob',
      hash,
      err instanceof Error
        ? `decompression failed: ${err.message}`
        : 'decompression failed',
    );
  }
}

/** Batched existence check — which of these hashes are stored? */
export async function hasBlob(
  env: Env,
  repoId: string,
  hashes: string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  const queue = [...hashes];
  const worker = async (): Promise<void> => {
    for (;;) {
      const hash = queue.shift();
      if (hash === undefined) return;
      const head = await env.OBJECTS.head(blobKey(repoId, hash));
      if (head) found.add(hash);
    }
  };
  await Promise.all(Array.from({ length: Math.min(20, hashes.length) }, () => worker()));
  return found;
}
