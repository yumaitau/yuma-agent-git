import { Hono } from 'hono';
import { z } from 'zod';
import { C, T } from '../db/schema';
import { parseRepoRow, q } from '../db/client';
import { apiError, errorResponse, readJsonBody } from './errors';
import { createRepo, getRepoBySlug, listRefs } from '../db/repos';
import { loadAdminRepo, loadReadableRepo } from '../auth/guards';
import { decide } from '../auth/rbac';
import { commitChanges } from '../core/commit';
import { moveRefViaDO, validateRefName } from '../core/refs';
import type { AppEnv } from '../auth/principal';

/**
 * Repo index + creation (issue #14: creators are admins; issue #20's
 * dashboard lists repos here).
 */
export const reposRoutes = new Hono<AppEnv>();

const createRepoSchema = z.object({
  slug: z
    .string()
    .min(3)
    .max(128)
    .regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/, 'slug must be owner/name'),
  visibility: z.enum(['private', 'public']).optional(),
  default_branch: z.string().min(1).max(64).optional(),
});

reposRoutes.post('/api/v1/repos', async (c) => {
  try {
    const user = c.get('user');
    if (!user) return apiError(c, 401, 'unauthorized', 'session required');
    const body = await readJsonBody(c);
    const parsed = createRepoSchema.safeParse(body);
    if (!parsed.success) {
      return apiError(c, 400, 'invalid_request', 'invalid repo request', {
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }
    if (await getRepoBySlug(c.env, parsed.data.slug)) {
      return apiError(c, 409, 'repo_exists', `repo ${parsed.data.slug} already exists`);
    }
    validateRefName(parsed.data.default_branch ?? 'main');
    const repo = await createRepo(c.env, {
      slug: parsed.data.slug,
      visibility: parsed.data.visibility,
      defaultBranch: parsed.data.default_branch,
      createdBy: user.id,
    });
    return c.json({ repo }, 201);
  } catch (err) {
    return errorResponse(c, err);
  }
});

reposRoutes.get('/api/v1/repos/:owner/:name', async (c) => {
  try {
    const loaded = await loadReadableRepo(
      c,
      `${c.req.param('owner')}/${c.req.param('name')}`,
    );
    if (!loaded.ok) return loaded.response;
    const admin = await decide(c.env, loaded.repo, c.get('principal'), 'admin');
    return c.json({ repo: loaded.repo, can_admin: admin.allowed }, 200, {
      'cache-control': 'private, no-store',
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

// Native bootstrap: deterministic content allows retry after an interrupted write.
// Ref CAS prevents concurrent requests from replacing a branch that already exists.
reposRoutes.post('/api/v1/repos/:owner/:name/initialize', async (c) => {
  try {
    const loaded = await loadAdminRepo(
      c,
      `${c.req.param('owner')}/${c.req.param('name')}`,
    );
    if (!loaded.ok) return loaded.response;
    const repo = loaded.repo;
    const name = validateRefName(repo.default_branch);
    const access = await decide(c.env, repo, c.get('principal'), 'write', 'README.md');
    if (!access.allowed)
      return apiError(c, 403, 'forbidden', 'README write access required');
    if ((await listRefs(c.env, repo.id)).length) {
      return apiError(c, 409, 'repo_initialized', 'Repository already has a branch');
    }
    const result = await commitChanges(c.env, repo.id, {
      first_parent: null,
      author: { agent: 'yuma:initialize' },
      message: 'Initialize repository',
      created_at: repo.created_at,
      changes: [{ path: 'README.md', op: 'add', content_b64: btoa(`# ${repo.slug}\n`) }],
    });
    await moveRefViaDO(c.env, repo.id, name, { from: null, to: result.changeset.id });
    return c.json({ changeset: result.changeset }, 201);
  } catch (err) {
    return errorResponse(c, err);
  }
});

function pageLimit(raw: string | undefined): number {
  const n = Number(raw ?? 50);
  if (!Number.isInteger(n) || n < 1) return 50;
  return Math.min(n, 100);
}

reposRoutes.get('/api/v1/repos', async (c) => {
  try {
    const principal = c.get('principal');
    if (
      principal?.kind === 'token' &&
      !principal.scopes.some((scope) => scope === 'repo:read' || scope === 'repo:write')
    )
      return apiError(c, 403, 'insufficient_scope', 'Token requires repository access');
    const tokenRepo = principal?.kind === 'token' ? principal.repoId : null;
    const userId = principal?.userId ?? '';
    const limit = pageLimit(c.req.query('limit'));
    const cursorRaw = c.req.query('cursor');
    let hasCursor = 0;
    let cursorCreated = 0;
    let cursorId = '';
    if (cursorRaw !== undefined && cursorRaw !== '') {
      const split = cursorRaw.indexOf(':');
      const created = Number(cursorRaw.slice(0, split));
      const id = cursorRaw.slice(split + 1);
      if (split <= 0 || !Number.isInteger(created) || id === '') {
        return apiError(c, 400, 'invalid_request', 'invalid cursor');
      }
      hasCursor = 1;
      cursorCreated = created;
      cursorId = id;
    }
    // visible: public repos + repos where the caller is a member/creator.
    // Keyset pagination on (created_at, id) descending.
    const rows = await q(
      c.env,
      `SELECT * FROM (
         SELECT * FROM ${T.repos} WHERE ${C.repos.visibility} = 'public'
         UNION
         SELECT r.* FROM ${T.repos} r
           JOIN ${T.repoMembers} m ON m.${C.repoMembers.repoId} = r.${C.repos.id}
          WHERE m.${C.repoMembers.userId} = ?
         UNION
         SELECT * FROM ${T.repos} WHERE created_by = ?
       )
       WHERE (? IS NULL OR id = ?) AND ((? = 0) OR created_at < ? OR (created_at = ? AND id < ?))
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
      [
        userId,
        userId,
        tokenRepo,
        tokenRepo,
        hasCursor,
        cursorCreated,
        cursorCreated,
        cursorId,
        limit + 1,
      ],
    );
    const page = rows.slice(0, limit).map((row) => parseRepoRow(row));
    const last = page[page.length - 1];
    const nextCursor =
      rows.length > limit && last ? `${last.created_at}:${last.id}` : null;
    return c.json({ repos: page, next_cursor: nextCursor }, 200, {
      'cache-control': 'private, no-store',
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});
