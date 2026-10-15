import { Hono } from 'hono';
import { z } from 'zod';
import { C, T } from '../db/schema';
import { parseRepoRow, q } from '../db/client';
import { apiError, errorResponse, readJsonBody } from './errors';
import { createRepo, getRepoBySlug } from '../db/repos';
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

function pageLimit(raw: string | undefined): number {
  const n = Number(raw ?? 50);
  if (!Number.isInteger(n) || n < 1) return 50;
  return Math.min(n, 100);
}

reposRoutes.get('/api/v1/repos', async (c) => {
  try {
    const principal = c.get('principal');
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
       WHERE (? = 0) OR created_at < ? OR (created_at = ? AND id < ?)
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
      [userId, userId, hasCursor, cursorCreated, cursorCreated, cursorId, limit + 1],
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
