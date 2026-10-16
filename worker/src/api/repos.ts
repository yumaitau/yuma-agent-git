import { Hono } from 'hono';
import { z } from 'zod';
import { C, T } from '../db/schema';
import { parseRepoRow, q, run } from '../db/client';
import { apiError, errorResponse, readJsonBody } from './errors';
import { createRepo, getRef, getRepoBySlug, listRefs, listRefsPage } from '../db/repos';
import { loadAdminRepo, loadReadableRepo } from '../auth/guards';
import { decide, USER_TEAMS_CTE } from '../auth/rbac';
import { getOrgBySlug, orgMembership } from './orgs';
import { commitChanges } from '../core/commit';
import { moveRefViaDO, validateBranchName } from '../core/refs';
import { boundRepos, hasScope, type AppEnv } from '../auth/principal';
import { recordAudit } from '../audit/record';

/**
 * Repo index + creation (issue #14: creators are admins; issue #20's
 * dashboard lists repos here; issue #26: repos can belong to an org).
 */
export const reposRoutes = new Hono<AppEnv>();

export const createRepoSchema = z.object({
  slug: z
    .string()
    .min(3)
    .max(128)
    .regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/, 'slug must be owner/name'),
  visibility: z.enum(['private', 'public']).optional(),
  default_branch: z.string().min(1).max(64).optional(),
  /** Org slug; must match the slug prefix. */
  org: z.string().min(1).max(39).optional(),
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
    // A slug prefix naming an org makes the repo org-owned, so an org
    // namespace cannot be filled by non-members just by omitting `org`.
    // Org slugs are lowercase, so `Yuma/x` cannot dodge the `yuma` org.
    const prefix = parsed.data.slug.split('/')[0] as string;
    const org = await getOrgBySlug(c.env, prefix.toLowerCase());
    if (
      (parsed.data.org !== undefined && parsed.data.org !== prefix) ||
      (org && org.slug !== prefix)
    ) {
      return apiError(c, 400, 'invalid_request', 'slug owner must match org');
    }
    if (parsed.data.org !== undefined && !org) {
      return apiError(c, 404, 'org_not_found', `no org ${parsed.data.org}`);
    }
    if (org) {
      const member = await orgMembership(c.env, org.id, user.id);
      if (!member) return apiError(c, 404, 'org_not_found', `no org ${org.slug}`);
      const mayCreate =
        member.role === 'owner' ||
        member.role === 'admin' ||
        (member.role === 'member' && org.members_can_create_repos);
      if (!mayCreate) {
        return apiError(c, 403, 'forbidden', 'org role does not allow creating repos');
      }
    }
    if (await getRepoBySlug(c.env, parsed.data.slug)) {
      return apiError(c, 409, 'repo_exists', `repo ${parsed.data.slug} already exists`);
    }
    validateBranchName(parsed.data.default_branch ?? 'main');
    const repo = await createRepo(c.env, {
      slug: parsed.data.slug,
      visibility: parsed.data.visibility,
      defaultBranch: parsed.data.default_branch,
      createdBy: user.id,
      ...(org ? { ownerKind: 'org' as const, ownerId: org.id } : {}),
    });
    await recordAudit(c, {
      action: 'repo.create',
      repo,
      target: {
        slug: repo.slug,
        visibility: repo.visibility,
        default_branch: repo.default_branch,
      },
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

export const updateRepoSchema = z.object({
  default_branch: z.string().min(1).max(255).optional(),
  refs_mode: z.enum(['scion', 'git']).optional(),
});

// Repo settings (issue #33): the default branch is what HEAD points at, so it
// must name an existing branch once the repo has any refs.
reposRoutes.put('/api/v1/repos/:owner/:name', async (c) => {
  try {
    const loaded = await loadAdminRepo(
      c,
      `${c.req.param('owner')}/${c.req.param('name')}`,
    );
    if (!loaded.ok) return loaded.response;
    const repo = loaded.repo;
    const parsed = updateRepoSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) {
      return apiError(c, 400, 'invalid_request', 'invalid repo update', {
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }
    const mode = parsed.data.refs_mode ?? repo.refs_mode ?? 'scion';
    const branch = parsed.data.default_branch ?? repo.default_branch;
    if (parsed.data.default_branch !== undefined) {
      validateBranchName(branch, mode);
      const empty =
        (await listRefsPage(c.env, repo.id, { prefix: '', after: '', limit: 1 }))
          .length === 0;
      if (!empty && !(await getRef(c.env, repo.id, branch))) {
        return apiError(c, 400, 'ref_not_found', `no branch ${branch}`);
      }
    }
    await run(c.env, 'UPDATE repos SET default_branch = ?, refs_mode = ? WHERE id = ?', [
      branch,
      mode,
      repo.id,
    ]);
    await recordAudit(c, {
      action: 'repo.settings.update',
      repo,
      target: { default_branch: branch, refs_mode: mode },
    });
    return c.json({ repo: { ...repo, default_branch: branch, refs_mode: mode } }, 200, {
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
    const name = validateBranchName(repo.default_branch, repo.refs_mode ?? 'scion');
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
    await moveRefViaDO(c.env, repo.id, name, {
      from: null,
      to: result.changeset.id,
      actor: c.get('principal'),
      via: 'api',
    });
    await recordAudit(c, {
      action: 'repo.initialize',
      repo,
      target: { ref: name, from: null, to: result.changeset.id },
    });
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
      principal &&
      principal.kind !== 'user' &&
      !hasScope(principal, 'repo:read') &&
      !hasScope(principal, 'repo:write')
    )
      return apiError(c, 403, 'insufficient_scope', 'Token requires repository access');
    const bound = boundRepos(principal);
    const tokenRepos = bound === null ? null : JSON.stringify(bound);
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
    // visible: public repos + repos where the caller is a member/creator,
    // gets a team grant, or holds an org role with access (issue #26).
    // Keyset pagination on (created_at, id) descending.
    const rows = await q(
      c.env,
      `WITH RECURSIVE ${USER_TEAMS_CTE}
       SELECT * FROM (
         SELECT * FROM ${T.repos} WHERE ${C.repos.visibility} = 'public'
         UNION
         SELECT r.* FROM ${T.repos} r
           JOIN ${T.repoMembers} m ON m.${C.repoMembers.repoId} = r.${C.repos.id}
          WHERE m.${C.repoMembers.userId} = ?
         UNION
         SELECT * FROM ${T.repos} WHERE created_by = ?
         UNION
         SELECT r.* FROM ${T.repos} r
           JOIN ${T.teamRepos} tr ON tr.${C.teamRepos.repoId} = r.${C.repos.id}
          WHERE tr.${C.teamRepos.teamId} IN (SELECT team_id FROM user_teams)
         UNION
         SELECT r.* FROM ${T.repos} r
           JOIN ${T.orgs} o ON o.${C.orgs.id} = r.${C.repos.ownerId}
           JOIN ${T.orgMembers} om ON om.${C.orgMembers.orgId} = o.${C.orgs.id}
          WHERE r.${C.repos.ownerKind} = 'org' AND om.${C.orgMembers.userId} = ?
            AND (om.${C.orgMembers.role} = 'owner'
                 OR (om.${C.orgMembers.role} IN ('admin', 'member') AND o.${C.orgs.baseRole} <> 'none'))
       )
       WHERE (? IS NULL OR id IN (SELECT value FROM json_each(?))) AND ((? = 0) OR created_at < ? OR (created_at = ? AND id < ?))
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
      [
        userId,
        userId,
        userId,
        userId,
        tokenRepos,
        tokenRepos,
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
