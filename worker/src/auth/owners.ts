import { z } from 'zod';
import type { Context } from 'hono';
import type { Env } from '../env';
import { q1 } from '../db/client';
import { ApiError } from '../core/errors';
import { getOrgBySlug, orgMembership } from '../api/orgs';
import type { AppEnv } from './principal';
import { ssoMessage, unmetSso } from './sso';

/**
 * Ownership and request helpers shared by webhooks, apps and OAuth apps
 * (issue #75). An owner is a user or an org; org owners and admins manage
 * what the org owns.
 */

export interface Owner {
  owner_kind: 'user' | 'org';
  owner_id: string;
}

/** Owners manage: the owning user, or an org owner or admin. Null otherwise. */
export async function canManageOwner(
  env: Env,
  owner: Owner,
  userId: string,
): Promise<{ auditOrg?: string } | null> {
  if (owner.owner_kind === 'user') return owner.owner_id === userId ? {} : null;
  const row = await q1<{ role: string; slug: string }>(
    env,
    `SELECT m.role, o.slug FROM org_members m JOIN orgs o ON o.id = m.org_id
      WHERE m.org_id = ? AND m.user_id = ?`,
    [owner.owner_id, userId],
  );
  return row && (row.role === 'owner' || row.role === 'admin')
    ? { auditOrg: row.slug }
    : null;
}

/** Org-level settings need the org's SSO, like its repos (#27). */
export async function requireOrgSso(c: Context<AppEnv>, orgId: string): Promise<void> {
  const sso = (await unmetSso(c.env, c.get('principal'))).get(orgId);
  if (sso)
    throw new ApiError(403, 'sso_required', ssoMessage(sso, new URL(c.req.url).origin), {
      ...sso,
    });
}

/** The new app's owner: the caller, or an org they own or administer. */
export async function resolveOwner(
  c: Context<AppEnv>,
  userId: string,
  org: string | undefined,
): Promise<Owner & { auditOrg?: string }> {
  if (org === undefined) return { owner_kind: 'user', owner_id: userId };
  const found = await getOrgBySlug(c.env, org);
  const me = found ? await orgMembership(c.env, found.id, userId) : null;
  if (!found || !me) throw new ApiError(404, 'org_not_found', `no org ${org}`);
  if (me.role !== 'owner' && me.role !== 'admin')
    throw new ApiError(403, 'forbidden', 'org owner or admin required');
  await requireOrgSso(c, found.id);
  return { owner_kind: 'org', owner_id: found.id, auditOrg: found.slug };
}

export function sessionUser(c: Context<AppEnv>): string {
  const user = c.get('user');
  if (!user) throw new ApiError(401, 'unauthorized', 'session required');
  return user.id;
}

export function parseBody<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new ApiError(
      400,
      'invalid_request',
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  return parsed.data;
}
