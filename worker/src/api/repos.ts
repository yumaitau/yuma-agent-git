import { Hono } from 'hono';
import { z } from 'zod';
import { C, T } from '../db/schema';
import { q } from '../db/client';
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

reposRoutes.get('/api/v1/repos', async (c) => {
  try {
    const principal = c.get('principal');
    // visible: public repos + repos where the caller is a member/creator
    const rows = await q(
      c.env,
      `SELECT * FROM ${T.repos} WHERE ${C.repos.visibility} = 'public'
       UNION
       SELECT r.* FROM ${T.repos} r
         JOIN ${T.repoMembers} m ON m.${C.repoMembers.repoId} = r.${C.repos.id}
        WHERE m.${C.repoMembers.userId} = ?
       UNION
       SELECT * FROM ${T.repos} WHERE created_by = ?`,
      [principal?.userId ?? '', principal?.userId ?? ''],
    );
    return c.json({ repos: rows }, 200, { 'cache-control': 'private, no-store' });
  } catch (err) {
    return errorResponse(c, err);
  }
});
