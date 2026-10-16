import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../auth/principal';
import { loadAdminRepo, loadReadableRepo } from '../auth/guards';
import { recordAudit } from '../audit/record';
import { q } from '../db/client';
import { packageRowSchema } from '../registry/packages';
import { apiError, errorResponse, readJsonBody } from './errors';

/**
 * Packages linked to a repo (issue #53): what the registry holds, and the
 * retention rule for OCI images.
 *
 *   GET   /repos/:repo/packages        readers
 *   PATCH /repos/:repo/packages/:id    admins: { keep_untagged: N | null }
 */
export const packagesRoutes = new Hono<AppEnv>();

export const patchPackageSchema = z
  .object({
    /** Keep the newest N untagged manifests; the cron deletes older ones. null keeps all. */
    keep_untagged: z.int().min(0).max(10_000).nullable(),
  })
  .strict();

const summaryRow = packageRowSchema.extend({
  versions: z.number().int(),
  tags: z.number().int(),
  size: z.number().int().nullable(),
});

packagesRoutes.get('/repos/:repo{.+}/packages', async (c) => {
  try {
    const loaded = await loadReadableRepo(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const rows = await q(
      c.env,
      `SELECT p.*,
              (SELECT COUNT(*) FROM package_versions v WHERE v.package_id = p.id) AS versions,
              (SELECT COUNT(*) FROM package_tags t WHERE t.package_id = p.id) AS tags,
              (SELECT SUM(f.size) FROM package_files f WHERE f.package_id = p.id) AS size
         FROM packages p WHERE p.repo_id = ? ORDER BY p.kind, p.name`,
      [loaded.repo.id],
    );
    return c.json({
      packages: rows.map((row) => {
        const p = summaryRow.parse(row);
        return {
          id: p.id,
          kind: p.kind,
          name: p.name,
          keep_untagged: p.keep_untagged,
          versions: p.versions,
          tags: p.tags,
          size: p.size ?? 0,
          created_at: p.created_at,
        };
      }),
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

packagesRoutes.patch('/repos/:repo{.+}/packages/:id', async (c) => {
  try {
    const loaded = await loadAdminRepo(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const body = patchPackageSchema.safeParse(await readJsonBody(c));
    if (!body.success)
      return apiError(
        c,
        400,
        'invalid_request',
        body.error.issues[0]?.message ?? 'invalid body',
      );
    const id = c.req.param('id');
    const rows = await q(c.env, 'SELECT * FROM packages WHERE id = ? AND repo_id = ?', [
      id,
      loaded.repo.id,
    ]);
    const pkg = rows[0] ? packageRowSchema.parse(rows[0]) : null;
    if (!pkg) return apiError(c, 404, 'package_not_found', `no package ${id}`);
    await recordAudit(
      c,
      {
        action: 'package.settings.update',
        repo: loaded.repo,
        target: {
          package: pkg.name,
          kind: pkg.kind,
          keep_untagged: body.data.keep_untagged,
        },
      },
      [
        c.env.DB.prepare('UPDATE packages SET keep_untagged = ? WHERE id = ?').bind(
          body.data.keep_untagged,
          id,
        ),
      ],
    );
    return c.json({ id, keep_untagged: body.data.keep_untagged });
  } catch (err) {
    return errorResponse(c, err);
  }
});
