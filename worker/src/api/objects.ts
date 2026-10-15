import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../env';
import { apiError, errorResponse, readJsonBody } from './errors';
import { blobKey, putBlob, statBlob } from '../core/blobs';
import { decompressBytes, parseCodec, type Codec } from '../core/compress';
import { getTree, getTreeRecursive } from '../core/trees';
import { sha256Hex } from '../core/hashing';
import { RequestValidationError } from '../core/errors';
import { resolveRevision } from '../core/read';
import { loadWholeRepo, loadWritableRepo } from '../auth/guards';
import { r2 } from '../observability/phase';

/**
 * Sparse-checkout protocol (architecture §2.4) — want-only negotiation:
 * clients never tell the server what they have; they start from a root tree
 * and request exactly the objects they want. Content-addressed + immutable ⇒
 * any cache tier can answer and requests are resumable.
 *
 *   GET  /api/v1/repos/:repo/object/tree/:hash
 *   GET  /api/v1/repos/:repo/object/blob/:hash?encoding=zstd|identity
 *   POST /api/v1/repos/:repo/fetch-objects
 *   GET  /api/v1/repos/:repo/checkout-info?cs=…
 *   PUT  /api/v1/repos/:repo/blob?sha256=…&encoding=…
 *
 * A hash cannot be mapped back to the paths it appears under, so every read
 * here needs whole-repository read: a caller any path rule restricts gets
 * 403 `whole_repository_required` and uses the path-checked read RPCs.
 */
export const objectsRoutes = new Hono<{ Bindings: Env }>();

const IMMUTABLE = 'public, max-age=31536000, immutable';
const NO_STORE = 'private, no-store';

const fetchObjectsSchema = z.object({
  // bounds are enforced by the route (413 fetch_too_large), not the schema
  trees: z.array(z.string().regex(/^[0-9a-f]{64}$/)).optional(),
  blobs: z.array(z.string().regex(/^[0-9a-f]{64}$/)).optional(),
  blob_encoding: z.enum(['zstd', 'identity']).optional(),
});

/** Request caps: 200 objects / 32 MiB of payload per call. */
const MAX_OBJECTS = 200;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

function cacheHeaders(visibility: string): Record<string, string> {
  return { 'cache-control': visibility === 'public' ? IMMUTABLE : NO_STORE };
}

// ---------------------------------------------------------------------------
// GET /object/tree/:hash
// ---------------------------------------------------------------------------

objectsRoutes.get('/repos/:repo{.+}/object/tree/:hash', async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'read', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const hash = c.req.param('hash');
    const tree = await getTree(c.env, loaded.repo.id, hash);
    if (!tree) {
      return apiError(c, 404, 'object_not_found', `no tree ${hash}`, { hash });
    }
    return c.json({ hash, ...tree }, 200, {
      ...cacheHeaders(loaded.repo.visibility),
      etag: `"${hash}"`,
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

// ---------------------------------------------------------------------------
// GET /object/blob/:hash?encoding=zstd|identity
// ---------------------------------------------------------------------------

objectsRoutes.get('/repos/:repo{.+}/object/blob/:hash', async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'read', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const repo = loaded.repo;
    const hash = c.req.param('hash');
    const mode = c.req.query('encoding') ?? 'zstd';

    const obj = await r2(c.env.OBJECTS).get(blobKey(repo.id, hash));
    if (!obj) {
      return apiError(c, 404, 'object_not_found', `no blob ${hash}`, { hash });
    }
    const codec = parseCodec(obj.customMetadata?.encoding);
    const stored = new Uint8Array(await obj.arrayBuffer());

    if (mode === 'identity') {
      // Server-side decompression + full hash verification (#3 contract).
      const content = await decompressBytes(stored, codec);
      const actual = await sha256Hex(content);
      if (actual !== hash) {
        return apiError(c, 500, 'object_corrupt', `blob ${hash} failed verification`);
      }
      return new Response(content as unknown as BodyInit, {
        status: 200,
        headers: {
          ...cacheHeaders(repo.visibility),
          etag: `"${hash}"`,
          'x-yag-encoding': 'identity',
          'content-type': 'application/octet-stream',
        },
      });
    }

    // Passthrough: serve the stored (compressed) bytes verbatim and tell the
    // client which codec to apply — no server transform surprises.
    return new Response(stored as unknown as BodyInit, {
      status: 200,
      headers: {
        ...cacheHeaders(repo.visibility),
        etag: `"${hash}"`,
        'x-yag-encoding': codec,
        'content-type': 'application/octet-stream',
      },
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

// ---------------------------------------------------------------------------
// POST /fetch-objects — batched, want-only
// ---------------------------------------------------------------------------

objectsRoutes.post('/repos/:repo{.+}/fetch-objects', async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'read', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const repo = loaded.repo;

    const body = await readJsonBody(c);
    const parsed = fetchObjectsSchema.safeParse(body);
    if (!parsed.success) {
      return apiError(c, 400, 'invalid_request', 'invalid fetch-objects body', {
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }
    const treeHashes = parsed.data.trees ?? [];
    const blobHashes = parsed.data.blobs ?? [];
    const total = treeHashes.length + blobHashes.length;
    if (total > MAX_OBJECTS) {
      return apiError(
        c,
        413,
        'fetch_too_large',
        `at most ${MAX_OBJECTS} objects per request; split the batch`,
        { limit_objects: MAX_OBJECTS, requested: total },
      );
    }

    const wantIdentity = parsed.data.blob_encoding === 'identity';
    const trees: { hash: string; payload_b64: string }[] = [];
    const blobs: { hash: string; size: number; encoding: string; data_b64: string }[] =
      [];
    const missing: string[] = [];
    let bytesOut = 0;

    for (const hash of treeHashes) {
      const tree = await getTree(c.env, repo.id, hash);
      if (tree === null) {
        missing.push(hash);
        continue;
      }
      const payload = new TextEncoder().encode(JSON.stringify(tree));
      bytesOut += payload.byteLength;
      if (bytesOut > MAX_RESPONSE_BYTES) {
        return apiError(
          c,
          413,
          'fetch_too_large',
          'response exceeded 32 MiB; split the batch',
          { limit_bytes: MAX_RESPONSE_BYTES },
        );
      }
      trees.push({ hash, payload_b64: bytesToB64(payload) });
    }

    for (const hash of blobHashes) {
      const obj = await r2(c.env.OBJECTS).get(blobKey(repo.id, hash));
      if (obj === null) {
        missing.push(hash);
        continue;
      }
      const codec = parseCodec(obj.customMetadata?.encoding);
      const stored = new Uint8Array(await obj.arrayBuffer());
      let data: Uint8Array;
      let encoding: string;
      if (wantIdentity) {
        data = await decompressBytes(stored, codec);
        encoding = 'identity';
      } else {
        data = stored;
        encoding = codec;
      }
      bytesOut += data.byteLength;
      if (bytesOut > MAX_RESPONSE_BYTES) {
        return apiError(
          c,
          413,
          'fetch_too_large',
          'response exceeded 32 MiB; split the batch',
          { limit_bytes: MAX_RESPONSE_BYTES },
        );
      }
      blobs.push({ hash, size: data.byteLength, encoding, data_b64: bytesToB64(data) });
    }

    return c.json({ trees, blobs, missing }, 200, cacheHeaders(repo.visibility));
  } catch (err) {
    return errorResponse(c, err);
  }
});

// ---------------------------------------------------------------------------
// GET /checkout-info?cs=…
// ---------------------------------------------------------------------------

objectsRoutes.get('/repos/:repo{.+}/checkout-info', async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'read', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const rev = c.req.query('cs');
    if (!rev) return apiError(c, 400, 'invalid_request', 'cs is required');
    const cs = await resolveRevision(c.env, loaded.repo.id, rev);
    const rootTree = cs.root_tree;
    if (rootTree === null) {
      return apiError(c, 404, 'revision_not_found', `revision ${rev} has no tree`);
    }

    // Bounded recursive walk for the estimate (clients plan sparse checkouts).
    const trees = await getTreeRecursive(c.env, loaded.repo.id, rootTree, {
      maxObjects: 20_000,
    });
    const seenBlobs = new Set<string>();
    let bytes = 0;
    for (const tree of trees.values()) {
      for (const entry of tree.entries) {
        if (entry.kind !== 'blob' || seenBlobs.has(entry.hash)) continue;
        seenBlobs.add(entry.hash);
        bytes += entry.size ?? (await statBlob(c.env, loaded.repo.id, entry.hash)) ?? 0;
      }
    }

    return c.json(
      {
        cs: cs.id,
        root_tree: rootTree,
        size_estimate: { blobs: seenBlobs.size, bytes },
      },
      200,
      {
        ...cacheHeaders(loaded.repo.visibility),
        etag: `"${cs.id}-checkout"`,
      },
    );
  } catch (err) {
    return errorResponse(c, err);
  }
});

// ---------------------------------------------------------------------------
// PUT /blob?sha256=…&encoding=… — client pre-upload (large files)
// ---------------------------------------------------------------------------

objectsRoutes.put('/repos/:repo{.+}/blob', async (c) => {
  try {
    const loaded = await loadWritableRepo(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const repo = loaded.repo;

    const declared = c.req.query('sha256') ?? c.req.header('x-yag-sha256');
    if (!declared || !/^[0-9a-f]{64}$/.test(declared)) {
      throw new RequestValidationError(
        'sha256 query parameter required',
        {},
        'missing_sha256',
      );
    }
    const encodingRaw = c.req.query('encoding') ?? 'identity';
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.byteLength > 64 * 1024 * 1024) {
      return apiError(c, 413, 'payload_too_large', 'blob uploads are capped at 64 MiB');
    }

    let content: Uint8Array;
    if (encodingRaw === 'identity') {
      content = bytes;
    } else {
      let codec: Codec;
      try {
        codec = parseCodec(encodingRaw);
      } catch {
        throw new RequestValidationError(
          `unknown encoding ${encodingRaw}`,
          {},
          'invalid_request',
        );
      }
      content = await decompressBytes(bytes, codec);
    }
    // Verify the content address before storing (hash of uncompressed bytes).
    const actual = await sha256Hex(content);
    if (actual !== declared) {
      return apiError(c, 400, 'hash_mismatch', `content hashes to ${actual}`, {
        declared,
        actual,
      });
    }
    const put = await putBlob(c.env, repo.id, content);
    return c.json(
      { sha256: declared, size: content.byteLength, deduped: !put.stored },
      201,
    );
  } catch (err) {
    return errorResponse(c, err);
  }
});

function bytesToB64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
