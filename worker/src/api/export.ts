import { Hono } from 'hono';
import type { Env } from '../env';
import { apiError, errorResponse, readJsonBody } from './errors';
import { getBlob } from '../core/blobs';
import { getTreeRecursive } from '../core/trees';
import { fastImportStream, treeFiles } from '../bridge/fastimport';
import { tarEntry, tarEnd } from '../bridge/tar';
import { startExportToGithub } from '../bridge/exportPush';
import { resolveRevision } from '../core/read';
import { loadWholeRepo } from '../auth/guards';
import { recordAudit } from '../audit/record';
import { bundleStream } from '../git/bundle';
import { GitProtocolError } from '../git/pktline';
import { commitShas, gitRefName } from '../git/upload-pack';
import { q } from '../db/client';
import { listRefs } from '../db/repos';
import type { RepoRecord } from '../db/client';

/**
 * Export routes (issue #16) — the off-ramp:
 *   GET  /api/v1/repos/:repo/export/tarball?cs=…
 *   GET  /api/v1/repos/:repo/export/fast-import?head=…&mode=snapshot|full|ranged&from=…
 *   POST /api/v1/repos/:repo/export/github  {target_branch, head?}
 *   GET  /api/v1/repos/:repo/export/bundle     Git bundle of every branch and tag (#70)
 *   GET  /api/v1/repos/:repo/export/metadata   issues, pull requests, reviews… as JSON (#70)
 *
 * Every export carries every path, so all three need whole-repository access
 * (path-restricted callers get 403 `whole_repository_required`).
 */
export const exportRoutes = new Hono<{ Bindings: Env }>();

const MAX_TAR_OBJECTS = 100_000;
const MAX_TAR_BYTES = 512 * 1024 * 1024;

/** Export size budget (testable in isolation). */
export function exceedsExportLimits(objectCount: number, bytes: number): boolean {
  return objectCount >= MAX_TAR_OBJECTS || bytes > MAX_TAR_BYTES;
}

exportRoutes.get('/repos/:repo{.+}/export/tarball', async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'read', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const repo = loaded.repo;
    const rev = c.req.query('cs');
    if (!rev) return apiError(c, 400, 'invalid_request', 'cs is required');
    const cs = await resolveRevision(c.env, repo.id, rev);
    const rootTree = cs.root_tree;
    if (rootTree === null) {
      return apiError(c, 404, 'revision_not_found', `revision ${rev} has no tree`);
    }

    // bounded estimate first — refuse absurd exports up front
    const trees = await getTreeRecursive(c.env, repo.id, rootTree, {
      maxObjects: MAX_TAR_OBJECTS,
    });
    let bytes = 0;
    for (const tree of trees.values()) {
      for (const entry of tree.entries) {
        if (entry.kind === 'blob') bytes += entry.size ?? 0;
      }
      if (bytes > MAX_TAR_BYTES) break;
    }
    if (exceedsExportLimits(trees.size, bytes)) {
      return apiError(c, 413, 'export_too_large', 'revision exceeds export limits', {
        max_objects: MAX_TAR_OBJECTS,
        max_bytes: MAX_TAR_BYTES,
      });
    }

    const files = await treeFiles(c.env, repo.id, rootTree);
    const gzip = new CompressionStream('gzip' as unknown as 'gzip');
    const stream = (async function* tarball(): AsyncGenerator<Uint8Array> {
      const mtime = Math.floor(cs.created_at / 1000);
      for (const file of files) {
        const blob = await getBlob(c.env, repo.id, file.hash);
        if (!blob) continue;
        // symlink-mode blobs (120000) are stored as their target text
        const symlink = file.mode === '120000';
        yield tarEntry(file.path, blob.content, {
          type: symlink ? 'symlink' : 'file',
          mode: symlink ? 0o777 : file.mode === '100755' ? 0o755 : 0o644,
          mtime,
        });
      }
      yield tarEnd();
    })()[Symbol.asyncIterator]();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await stream.next();
        if (next.done) {
          controller.close();
          return;
        }
        controller.enqueue(next.value);
      },
    });

    const short = cs.id.slice(0, 8);
    return new Response(body.pipeThrough(gzip), {
      status: 200,
      headers: {
        'content-type': 'application/gzip',
        'content-disposition': `attachment; filename="${repo.slug.replace(/\//g, '-')}-${short}.tar.gz"`,
        'cache-control':
          repo.visibility === 'public' && /^[0-9a-f]{64}$/.test(rev)
            ? 'public, max-age=31536000, immutable'
            : 'private, no-store',
      },
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

exportRoutes.get('/repos/:repo{.+}/export/fast-import', async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'read', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const repo = loaded.repo;
    const headRev = c.req.query('head');
    if (!headRev) return apiError(c, 400, 'invalid_request', 'head is required');
    const head = await resolveRevision(c.env, repo.id, headRev);
    const mode = (c.req.query('mode') ?? 'snapshot') as 'snapshot' | 'full' | 'ranged';
    const from = c.req.query('from');

    const stream = fastImportStream(c.env, repo.id, head.id, {
      mode: ['snapshot', 'full', 'ranged'].includes(mode) ? mode : 'snapshot',
      from,
    });
    return new Response(stream, {
      status: 200,
      headers: {
        'content-type': 'application/x-git-fast-import-stream',
        'content-disposition': `attachment; filename="${repo.slug.replace(/\//g, '-')}.fast-import"`,
        'cache-control':
          repo.visibility === 'public' && /^[0-9a-f]{64}$/.test(headRev)
            ? 'public, max-age=31536000, immutable'
            : 'private, no-store',
      },
    });
  } catch (err) {
    if (err instanceof Error && err.message === 'too-many-commits') {
      return apiError(
        c,
        413,
        'export_too_large',
        'history exceeds 10k commits — use mode=snapshot or a ranged export (?from=…&to=…)',
      );
    }
    return errorResponse(c, err);
  }
});

exportRoutes.post('/repos/:repo{.+}/export/github', async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'write', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const body = await readJsonBody(c);
    const started = await startExportToGithub(c.env, loaded.repo.id, body ?? {});
    await recordAudit(c, {
      action: 'repo.export',
      repo: loaded.repo,
      target: { job_id: started.job_id, destination: 'github' },
    });
    return c.json({ job_id: started.job_id, status: 'queued' }, 202);
  } catch (err) {
    return errorResponse(c, err);
  }
});

/** Rows of a repository's collaboration data, keyed by table (#70). */
const REPO_TABLES: [table: string, where: string][] = [
  ['tags', 'repo_id = ?1'],
  ['labels', 'repo_id = ?1'],
  ['milestones', 'repo_id = ?1'],
  ['issues', 'repo_id = ?1'],
  ['issue_comments', 'issue_id IN (SELECT id FROM issues WHERE repo_id = ?1)'],
  ['issue_labels', 'issue_id IN (SELECT id FROM issues WHERE repo_id = ?1)'],
  ['issue_assignees', 'issue_id IN (SELECT id FROM issues WHERE repo_id = ?1)'],
  ['issue_events', 'issue_id IN (SELECT id FROM issues WHERE repo_id = ?1)'],
  ['issue_links', 'parent_id IN (SELECT id FROM issues WHERE repo_id = ?1)'],
  ['pull_requests', 'repo_id = ?1'],
  ['pull_reviews', 'pull_id IN (SELECT id FROM pull_requests WHERE repo_id = ?1)'],
  ['review_requests', 'pull_id IN (SELECT id FROM pull_requests WHERE repo_id = ?1)'],
  ['review_threads', 'pull_id IN (SELECT id FROM pull_requests WHERE repo_id = ?1)'],
  [
    'review_comments',
    'thread_id IN (SELECT t.id FROM review_threads t JOIN pull_requests p ON p.id = t.pull_id WHERE p.repo_id = ?1)',
  ],
  ['releases', 'repo_id = ?1'],
  ['release_assets', 'repo_id = ?1'],
  ['lfs_objects', 'repo_id = ?1'],
  ['lfs_locks', 'repo_id = ?1'],
];
const PEOPLE = ['author_id', 'created_by', 'owner_id', 'uploaded_by', 'author'];

export async function repoMetadata(
  env: Env,
  repo: RepoRecord,
): Promise<Record<string, unknown>> {
  const tables: Record<string, Record<string, unknown>[]> = {};
  const people = new Set<string>();
  for (const [table, where] of REPO_TABLES) {
    const rows = await q<Record<string, unknown>>(
      env,
      `SELECT * FROM ${table} WHERE ${where}`,
      [repo.id],
    );
    tables[table] = rows;
    for (const row of rows)
      for (const col of PEOPLE) if (typeof row[col] === 'string') people.add(row[col]);
  }
  const users = await q<{ id: string; login: string }>(
    env,
    'SELECT id, login FROM users WHERE id IN (SELECT value FROM json_each(?))',
    [JSON.stringify([...people])],
  );
  const refs = await listRefs(env, repo.id);
  const shas = await commitShas(
    env,
    repo.id,
    refs.map((r) => r.head),
  );
  return {
    format: 'yag-repo-export/1',
    exported_at: new Date().toISOString(),
    repository: repo,
    refs: refs.map((r) => ({
      name: gitRefName(r.name),
      changeset: r.head,
      sha1: shas.get(r.head) ?? null,
    })),
    users: Object.fromEntries(users.map((u) => [u.id, u.login])),
    tables,
  };
}

/** Git IDs still being computed: the client retries. */
function retryLater(c: Parameters<typeof apiError>[0], err: unknown): Response | null {
  return err instanceof GitProtocolError
    ? apiError(c, 503, 'export_not_ready', err.message)
    : null;
}

exportRoutes.get('/repos/:repo{.+}/export/bundle', async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'read', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const stream = await bundleStream(c.env, loaded.repo);
    if (!stream)
      return apiError(c, 409, 'empty_repository', 'the repository has no branches yet');
    await recordAudit(c, {
      action: 'repo.export',
      repo: loaded.repo,
      target: { destination: 'bundle' },
    });
    return new Response(stream, {
      headers: {
        'content-type': 'application/x-git-bundle',
        'content-disposition': `attachment; filename="${loaded.repo.slug.replace(/\//g, '-')}.bundle"`,
        'cache-control': 'private, no-store',
      },
    });
  } catch (err) {
    return retryLater(c, err) ?? errorResponse(c, err);
  }
});

exportRoutes.get('/repos/:repo{.+}/export/metadata', async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'read', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const body = await repoMetadata(c.env, loaded.repo);
    await recordAudit(c, {
      action: 'repo.export',
      repo: loaded.repo,
      target: { destination: 'metadata' },
    });
    return c.json(body, 200, { 'cache-control': 'private, no-store' });
  } catch (err) {
    return retryLater(c, err) ?? errorResponse(c, err);
  }
});
