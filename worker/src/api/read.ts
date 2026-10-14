import { Hono } from 'hono';
import type { Env } from '../env';
import { apiError, errorResponse } from './errors';
import { firstParentHistory } from '../core/changesets';
import {
  contentTypeFor,
  lookupRev,
  provisionalPathHistory,
  resolveRevision,
} from '../core/read';
import { blobKey, getBlob, statBlob } from '../core/blobs';
import { decompressStream, parseCodec } from '../core/compress';
import { sha256Hex } from '../core/hashing';
import { getTree, resolvePath } from '../core/trees';
import {
  ConflictError,
  NotFoundError,
  ObjectNotFoundError,
  PayloadTooLargeError,
  RequestValidationError,
} from '../core/errors';
import { getRepoBySlug } from '../db/repos';
import { requireRepoRead } from '../auth/guards';

/**
 * Read RPCs — queries with no checkout (architecture §2):
 *   GET /api/v1/repos/:repo/file?cs=…&path=…[&format=raw]
 *   GET /api/v1/repos/:repo/tree?cs=…&path=…[&recursive=1]
 *   GET /api/v1/repos/:repo/history?cs=…&path=…&limit=…
 *   GET /api/v1/repos/:repo/changed-paths?cs=…
 */
export const readRoutes = new Hono<{ Bindings: Env }>();

const IMMUTABLE = 'public, max-age=31536000, immutable';
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_RECURSIVE_ENTRIES = 5_000;

async function etagFor(csId: string, path: string): Promise<string> {
  const digest = await sha256Hex(new TextEncoder().encode(path));
  return `"${csId}-${digest.slice(0, 16)}"`;
}

/** Query-param path validation (NFC, no traversal). Empty allowed for tree root. */
function normalizeQueryPath(raw: string, allowEmpty: boolean): string {
  const path = raw.normalize('NFC');
  if (path === '') {
    if (allowEmpty) return '';
    throw new RequestValidationError('path is required', {}, 'invalid_path');
  }
  const segments = path.split('/');
  if (
    path.startsWith('/') ||
    path.endsWith('/') ||
    segments.some((s) => s === '' || s === '.' || s === '..')
  ) {
    throw new RequestValidationError(
      `invalid path ${JSON.stringify(raw)}`,
      {},
      'invalid_path',
    );
  }
  return path;
}

function bytesToB64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// GET /file
// ---------------------------------------------------------------------------

readRoutes.get('/repos/:repo{.+}/file', async (c) => {
  try {
    const repo = await getRepoBySlug(c.env, c.req.param('repo'));
    if (!repo) {
      return apiError(c, 404, 'repo_not_found', `no repo ${c.req.param('repo')}`);
    }
    if (!(await requireRepoRead(c.env, c, repo))) {
      return apiError(c, 403, 'forbidden', 'read access required');
    }

    const rev = c.req.query('cs');
    const rawPath = c.req.query('path');
    if (!rev || rawPath === undefined) {
      return apiError(c, 400, 'invalid_request', 'cs and path are required');
    }
    const path = normalizeQueryPath(rawPath, false);
    const cs = await resolveRevision(c.env, repo.id, rev);
    const rootTree = cs.root_tree;
    if (rootTree === null) {
      throw new NotFoundError('revision_not_found', `revision ${rev} has no tree`, {
        rev,
      });
    }

    const entry = await resolvePath(c.env, repo.id, rootTree, path.split('/'));
    if (!entry || entry.kind !== 'blob') {
      return apiError(c, 404, 'path_not_found', `no file ${path} at ${rev}`, { path });
    }

    const size = entry.size ?? (await statBlob(c.env, repo.id, entry.hash)) ?? 0;
    const etag = await etagFor(cs.id, path);
    const format = c.req.query('format') ?? 'json';

    if (format === 'raw') {
      // Streamed from R2 — never fully buffered — and decompressed on the way out.
      const obj = await c.env.OBJECTS.get(blobKey(repo.id, entry.hash));
      if (!obj) throw new ObjectNotFoundError('blob', entry.hash);
      const stream = obj.body.pipeThrough(
        decompressStream(parseCodec(obj.customMetadata?.encoding)),
      );
      return new Response(stream, {
        headers: {
          'content-type': contentTypeFor(path),
          'content-disposition': `inline; filename="${entry.name}"`,
          'content-length': String(size),
          'cache-control': IMMUTABLE,
          etag,
        },
      });
    }

    if (size > MAX_JSON_BYTES) {
      throw new PayloadTooLargeError(
        `file ${path} is ${size} bytes; use ?format=raw`,
        'file_too_large',
        { use: '?format=raw', size },
      );
    }

    const blob = await getBlob(c.env, repo.id, entry.hash);
    if (!blob) throw new ObjectNotFoundError('blob', entry.hash);
    return c.json(
      {
        path,
        size,
        blob_sha256: entry.hash,
        cs: cs.id,
        content_b64: bytesToB64(blob.content),
      },
      200,
      { 'cache-control': IMMUTABLE, etag },
    );
  } catch (err) {
    return errorResponse(c, err);
  }
});

// ---------------------------------------------------------------------------
// GET /tree
// ---------------------------------------------------------------------------

readRoutes.get('/repos/:repo{.+}/tree', async (c) => {
  try {
    const repo = await getRepoBySlug(c.env, c.req.param('repo'));
    if (!repo) {
      return apiError(c, 404, 'repo_not_found', `no repo ${c.req.param('repo')}`);
    }
    if (!(await requireRepoRead(c.env, c, repo))) {
      return apiError(c, 403, 'forbidden', 'read access required');
    }

    const rev = c.req.query('cs');
    if (!rev) return apiError(c, 400, 'invalid_request', 'cs is required');
    const path = normalizeQueryPath(c.req.query('path') ?? '', true);
    const recursive = c.req.query('recursive') === '1';

    const cs = await resolveRevision(c.env, repo.id, rev);
    let treeHash = cs.root_tree;
    if (treeHash === null) {
      throw new NotFoundError('revision_not_found', `revision ${rev} has no tree`, {
        rev,
      });
    }
    if (path !== '') {
      const entry = await resolvePath(c.env, repo.id, treeHash, path.split('/'));
      if (!entry)
        return apiError(c, 404, 'path_not_found', `no path ${path} at ${rev}`, { path });
      if (entry.kind !== 'tree') {
        return apiError(c, 400, 'not_a_tree', `${path} is not a directory`, { path });
      }
      treeHash = entry.hash;
    }

    const etag = await etagFor(cs.id, path);
    const headers = { 'cache-control': IMMUTABLE, etag };

    if (!recursive) {
      const tree = await getTree(c.env, repo.id, treeHash);
      if (!tree) throw new ObjectNotFoundError('tree', treeHash);
      return c.json({ path, entries: tree.entries }, 200, headers);
    }

    const entries: {
      path: string;
      kind: 'tree' | 'blob';
      hash: string;
      size?: number;
    }[] = [];
    const stack: { hash: string; base: string }[] = [{ hash: treeHash, base: path }];
    while (stack.length > 0) {
      const frame = stack.pop();
      if (!frame) break;
      const tree = await getTree(c.env, repo.id, frame.hash);
      if (!tree) throw new ObjectNotFoundError('tree', frame.hash);
      for (const e of tree.entries) {
        const childPath = frame.base === '' ? e.name : `${frame.base}/${e.name}`;
        entries.push({ path: childPath, kind: e.kind, hash: e.hash, size: e.size });
        if (entries.length > MAX_RECURSIVE_ENTRIES) {
          throw new ConflictError(
            'tree_too_large',
            `recursive tree exceeds ${MAX_RECURSIVE_ENTRIES} entries`,
            { limit: MAX_RECURSIVE_ENTRIES },
          );
        }
        if (e.kind === 'tree') stack.push({ hash: e.hash, base: childPath });
      }
    }
    return c.json({ path, entries }, 200, headers);
  } catch (err) {
    return errorResponse(c, err);
  }
});

// ---------------------------------------------------------------------------
// GET /history
// ---------------------------------------------------------------------------

readRoutes.get('/repos/:repo{.+}/history', async (c) => {
  try {
    const repo = await getRepoBySlug(c.env, c.req.param('repo'));
    if (!repo) {
      return apiError(c, 404, 'repo_not_found', `no repo ${c.req.param('repo')}`);
    }
    if (!(await requireRepoRead(c.env, c, repo))) {
      return apiError(c, 403, 'forbidden', 'read access required');
    }

    const revParam = c.req.query('cs') ?? 'ref:main';
    const rawPath = c.req.query('path');
    const limitRaw = Number(c.req.query('limit') ?? '50');
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 50;

    const cs = await lookupRev(c.env, repo.id, revParam);
    if (!cs) {
      if (c.req.query('cs') === undefined) return c.json({ changesets: [] });
      return apiError(c, 404, 'revision_not_found', `no revision ${revParam}`);
    }

    const headers = { 'cache-control': 'public, max-age=10' };

    if (rawPath === undefined) {
      const changesets = await firstParentHistory(c.env, repo.id, cs.id, limit);
      return c.json({ changesets }, 200, headers);
    }

    // Path history — provisional first-parent walk until the `path_history`
    // derived-data kind lands (issue #10).
    const path = normalizeQueryPath(rawPath, false);
    const changesets = await provisionalPathHistory(c.env, repo.id, cs.id, path, limit);
    return c.json({ path, changesets }, 200, {
      ...headers,
      'x-yag-provisional': 'path-history',
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

// ---------------------------------------------------------------------------
// GET /changed-paths
// ---------------------------------------------------------------------------

readRoutes.get('/repos/:repo{.+}/changed-paths', async (c) => {
  try {
    const repo = await getRepoBySlug(c.env, c.req.param('repo'));
    if (!repo) {
      return apiError(c, 404, 'repo_not_found', `no repo ${c.req.param('repo')}`);
    }
    if (!(await requireRepoRead(c.env, c, repo))) {
      return apiError(c, 403, 'forbidden', 'read access required');
    }

    const rev = c.req.query('cs');
    if (!rev) return apiError(c, 400, 'invalid_request', 'cs is required');
    const cs = await resolveRevision(c.env, repo.id, rev);
    return c.json({ cs: cs.id, changed_files: cs.changed_files }, 200, {
      'cache-control': IMMUTABLE,
      etag: await etagFor(cs.id, 'changed-paths'),
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});
