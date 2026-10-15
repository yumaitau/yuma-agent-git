import { Hono } from 'hono';
import type { Env } from '../env';
import type { RepoRecord } from '../db/client';
import { apiError, errorResponse } from './errors';
import { firstParentHistory, getChangeset } from '../core/changesets';
import { contentTypeFor, lookupRev, resolveRevision } from '../core/read';
import { PATH_HISTORY, pathHistoryAt } from '../core/derived/pathHistory';
import { enqueueDerived, peekDerived } from '../core/derived';
import { blobKey, getBlob, statBlob } from '../core/blobs';
import { decompressStream, parseCodec } from '../core/compress';
import { IncrementalSha256, sha256Hex } from '../core/hashing';
import { getTree, resolvePath } from '../core/trees';
import {
  ConflictError,
  NotFoundError,
  ObjectCorruptError,
  ObjectNotFoundError,
  PayloadTooLargeError,
  RequestValidationError,
} from '../core/errors';
import {
  guardPathHistory,
  guardPathRead,
  loadReadableRepo as loadReadable,
  pathReadFilter,
  visibleChangeset,
} from '../auth/guards';
import { r2 } from '../observability/phase';

/**
 * Read RPCs — queries with no checkout (architecture §2):
 *   GET /api/v1/repos/:repo/file?cs=…&path=…[&format=raw]
 *   GET /api/v1/repos/:repo/tree?cs=…&path=…[&recursive=1]
 *   GET /api/v1/repos/:repo/history?cs=…&path=…&limit=…
 *   GET /api/v1/repos/:repo/changed-paths?cs=…
 *
 * Listings (tree entries, changed files, changesets) drop paths the caller
 * may not `read` under path rules and count them in `omitted_paths_count`.
 */
export const readRoutes = new Hono<{ Bindings: Env }>();

const IMMUTABLE = 'public, max-age=31536000, immutable';
const SHORT = 'public, max-age=10';
const NO_STORE = 'private, no-store';
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_RECURSIVE_ENTRIES = 5_000;
const CS_ID_RE = /^[0-9a-f]{64}$/;

async function etagFor(csId: string, variant: string): Promise<string> {
  const digest = await sha256Hex(new TextEncoder().encode(variant));
  return `"${csId}-${digest.slice(0, 16)}"`;
}

/**
 * Cache policy (issue #21: "correctness over speed — default is no-store for
 * anything auth'd"):
 *   - private repo                       → `private, no-store`
 *   - public repo + content-addressed rev (64-hex cs id) → immutable
 *   - public repo + ref-addressed rev (`ref:main`, `main`) → short TTL:
 *     the URL is mutable while `main` moves, so it must never be frozen.
 */
function cacheHeaders(
  repo: RepoRecord,
  requestedRev: string,
  etag: string,
): Record<string, string> {
  if (repo.visibility !== 'public') return { 'cache-control': NO_STORE, etag };
  return CS_ID_RE.test(requestedRev)
    ? { 'cache-control': IMMUTABLE, etag }
    : { 'cache-control': SHORT, etag };
}

/** Query-param path validation (NFC, no traversal). Empty allowed for tree root. */
export function normalizeQueryPath(raw: string, allowEmpty: boolean): string {
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

/** Header-safe filename (CR/LF/quotes would split or spoof the header). */
function safeFilename(name: string): string {
  // Stripping control characters is the entire point here.
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\x00-\x1f\x7f"\\;]/g, '_');
  return cleaned === '' ? 'download' : cleaned;
}

/** Types a browser would execute on our origin: force download, never inline. */
const ACTIVE_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'application/xml',
  'text/javascript',
  'text/typescript',
]);

// ---------------------------------------------------------------------------
// GET /file
// ---------------------------------------------------------------------------

readRoutes.get('/repos/:repo{.+}/file', async (c) => {
  try {
    const loaded = await loadReadable(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const repo = loaded.repo;

    const rev = c.req.query('cs');
    const rawPath = c.req.query('path');
    if (!rev || rawPath === undefined) {
      return apiError(c, 400, 'invalid_request', 'cs and path are required');
    }
    const path = normalizeQueryPath(rawPath, false);
    const denied = await guardPathRead(c, repo, path);
    if (denied) return denied;
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
    const format = c.req.query('format') ?? 'json';
    const etag = await etagFor(cs.id, `${format}:${path}`);
    const headers = cacheHeaders(repo, rev, etag);
    const contentType = contentTypeFor(path);

    if (format === 'raw') {
      // Streamed from R2 — never fully buffered — decompressed on the way out,
      // and hash-verified while it streams (content addresses are checked on
      // EVERY read path; a mismatch aborts the stream).
      const obj = await r2(c.env.OBJECTS).get(blobKey(repo.id, entry.hash));
      if (!obj) throw new ObjectNotFoundError('blob', entry.hash);
      const hasher = new IncrementalSha256();
      let decompressor: ReturnType<typeof decompressStream>;
      try {
        decompressor = decompressStream(parseCodec(obj.customMetadata?.encoding));
      } catch (err) {
        throw new ObjectCorruptError(
          'blob',
          entry.hash,
          err instanceof Error ? err.message : 'unknown encoding',
        );
      }
      const stream = obj.body.pipeThrough(decompressor).pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            hasher.update(chunk);
            controller.enqueue(chunk);
          },
          flush() {
            if (hasher.digestHex() !== entry.hash) {
              throw new ObjectCorruptError(
                'blob',
                entry.hash,
                'hash mismatch on streaming read',
              );
            }
          },
        }),
      );
      const active = ACTIVE_TYPES.has(contentType.split(';')[0] as string);
      return new Response(stream, {
        headers: {
          ...headers,
          'content-type': contentType,
          'content-disposition': `${active ? 'attachment' : 'inline'}; filename="${safeFilename(entry.name)}"`,
          'content-length': String(size),
          'x-content-type-options': 'nosniff',
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
      headers,
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
    const loaded = await loadReadable(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const repo = loaded.repo;

    const rev = c.req.query('cs');
    if (!rev) return apiError(c, 400, 'invalid_request', 'cs is required');
    const path = normalizeQueryPath(c.req.query('path') ?? '', true);
    const denied = await guardPathRead(c, repo, path);
    if (denied) return denied;
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
      if (!entry) {
        return apiError(c, 404, 'path_not_found', `no path ${path} at ${rev}`, { path });
      }
      if (entry.kind !== 'tree') {
        return apiError(c, 400, 'not_a_tree', `${path} is not a directory`, { path });
      }
      treeHash = entry.hash;
    }

    const headers = cacheHeaders(repo, rev, await etagFor(cs.id, `tree:${path}`));
    const canRead = await pathReadFilter(c, repo);
    const omitted = (count: number) => (count > 0 ? { omitted_paths_count: count } : {});

    if (!recursive) {
      const tree = await getTree(c.env, repo.id, treeHash);
      if (!tree) throw new ObjectNotFoundError('tree', treeHash);
      const visible = tree.entries.filter((e) =>
        canRead(path === '' ? e.name : `${path}/${e.name}`),
      );
      return c.json(
        { path, entries: visible, ...omitted(tree.entries.length - visible.length) },
        200,
        headers,
      );
    }

    const entries: {
      path: string;
      kind: 'tree' | 'blob';
      hash: string;
      size?: number;
    }[] = [];
    const stack: { hash: string; base: string }[] = [{ hash: treeHash, base: path }];
    let walked = 0;
    while (stack.length > 0) {
      const frame = stack.pop();
      if (!frame) break;
      const tree = await getTree(c.env, repo.id, frame.hash);
      if (!tree) throw new ObjectNotFoundError('tree', frame.hash);
      for (const e of tree.entries) {
        const childPath = frame.base === '' ? e.name : `${frame.base}/${e.name}`;
        // Still descend into hidden directories: a longer grant can reopen a
        // subtree below a denied prefix.
        if (canRead(childPath)) {
          entries.push({ path: childPath, kind: e.kind, hash: e.hash, size: e.size });
        }
        if (++walked > MAX_RECURSIVE_ENTRIES) {
          throw new ConflictError(
            'tree_too_large',
            `recursive tree exceeds ${MAX_RECURSIVE_ENTRIES} entries`,
            { limit: MAX_RECURSIVE_ENTRIES },
          );
        }
        if (e.kind === 'tree') stack.push({ hash: e.hash, base: childPath });
      }
    }
    return c.json({ path, entries, ...omitted(walked - entries.length) }, 200, headers);
  } catch (err) {
    return errorResponse(c, err);
  }
});

// ---------------------------------------------------------------------------
// GET /history
// ---------------------------------------------------------------------------

readRoutes.get('/repos/:repo{.+}/history', async (c) => {
  try {
    const loaded = await loadReadable(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const repo = loaded.repo;

    const revParam = c.req.query('cs') ?? 'ref:main';
    const rawPath = c.req.query('path');
    const limitRaw = Number(c.req.query('limit') ?? '50');
    const limit =
      Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 50;

    const cs = await lookupRev(c.env, repo.id, revParam);
    if (!cs) {
      if (c.req.query('cs') === undefined) {
        return c.json({ changesets: [] }, 200, { 'cache-control': NO_STORE });
      }
      return apiError(c, 404, 'revision_not_found', `no revision ${revParam}`);
    }

    // History depends on mutable heads and permissions — short TTL max.
    const headers = {
      'cache-control': repo.visibility === 'public' ? SHORT : NO_STORE,
    };

    const canRead = await pathReadFilter(c, repo);
    if (rawPath === undefined) {
      const changesets = await firstParentHistory(c.env, repo.id, cs.id, limit);
      return c.json(
        { changesets: changesets.map((c2) => visibleChangeset(c2, canRead)) },
        200,
        headers,
      );
    }

    // Path history via the `path_history` derived kind (issue #10 — the
    // provisional walk is gone). Cold + background=1 → 202 + queue; otherwise
    // bounded inline walk with a resume cursor.
    const path = normalizeQueryPath(rawPath, false);
    const denied = await guardPathHistory(c, repo, path);
    if (denied) return denied;
    const background = c.req.query('background') === '1';
    const cold = (await peekDerived(c.env, repo.id, PATH_HISTORY, cs.id)) === null;
    if (background && cold) {
      await enqueueDerived(c.env, [
        { repo_id: repo.id, kind: PATH_HISTORY, cs_id: cs.id },
      ]);
      return c.json({ status: 'computing', path, cs: cs.id }, 202, headers);
    }

    const result = await pathHistoryAt(c.env, repo.id, cs.id, path, limit);
    const changesets = (
      await Promise.all(result.commits.map((id) => getChangeset(c.env, repo.id, id)))
    )
      .filter((c2) => c2 !== null)
      .map((c2) => visibleChangeset(c2, canRead));
    return c.json(
      { path, changesets, next: result.next, complete: result.complete },
      200,
      headers,
    );
  } catch (err) {
    return errorResponse(c, err);
  }
});

// ---------------------------------------------------------------------------
// GET /changed-paths
// ---------------------------------------------------------------------------

readRoutes.get('/repos/:repo{.+}/changed-paths', async (c) => {
  try {
    const loaded = await loadReadable(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const repo = loaded.repo;

    const rev = c.req.query('cs');
    if (!rev) return apiError(c, 400, 'invalid_request', 'cs is required');
    const cs = await resolveRevision(c.env, repo.id, rev);
    const visible = visibleChangeset(cs, await pathReadFilter(c, repo));
    return c.json(
      {
        cs: cs.id,
        changed_files: visible.changed_files,
        ...(visible.omitted_paths_count
          ? { omitted_paths_count: visible.omitted_paths_count }
          : {}),
      },
      200,
      {
        ...cacheHeaders(repo, rev, await etagFor(cs.id, 'changed-paths')),
      },
    );
  } catch (err) {
    return errorResponse(c, err);
  }
});
