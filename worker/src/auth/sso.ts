import { z } from 'zod';
import type { Env } from '../env';
import { C, T } from '../db/schema';
import { q } from '../db/client';
import type { RepoRecord } from '../db/client';
import { oidcProviders } from './oidc';
import type { Principal } from './principal';

/**
 * Org SSO enforcement (issue #27). An org with `org_sso.enforced = 1` admits
 * its members (org members and team members) to org repos only when the
 * credential signed in through the org's IdP: a session whose method is that
 * provider, or a token minted from such a session. With `allowed_domains`,
 * the verified email on that identity must be in one of them. RBAC (rbac.ts)
 * applies this to every decision; callers turn it into `sso_required`.
 */

export interface SsoRequirement {
  org: string;
  /** Where to sign in (`/auth/oidc/<provider>`), or null if no provider matches. */
  sign_in: string | null;
}

export const ssoConfigSchema = z.object({
  org_id: z.string(),
  protocol: z.enum(['oidc', 'saml']),
  issuer: z.string(),
  client_id: z.string(),
  enforced: z.number(),
  allowed_domains: z.string(),
});
export type SsoConfig = z.infer<typeof ssoConfigSchema>;

/** The configured OIDC provider id for an org's IdP, or null. */
export function ssoProviderId(env: Env, cfg: SsoConfig): string | null {
  if (cfg.protocol !== 'oidc') return null;
  return (
    oidcProviders(env).find(
      (p) => p.issuer === cfg.issuer && p.clientId === cfg.client_id,
    )?.id ?? null
  );
}

/** Whether a user's credential, signed in by `authMethod`, meets the org's SSO. */
export async function satisfiesSso(
  env: Env,
  userId: string,
  authMethod: string | null,
  cfg: SsoConfig,
): Promise<boolean> {
  const provider = ssoProviderId(env, cfg);
  if (provider === null || authMethod !== `oidc:${provider}`) return false;
  const domains = z.array(z.string()).parse(JSON.parse(cfg.allowed_domains));
  if (domains.length === 0) return true;
  const rows = await q<{ email: string | null }>(
    env,
    'SELECT email FROM user_identities WHERE user_id = ? AND provider = ?',
    [userId, authMethod],
  );
  return rows.some((r) => domains.includes(r.email?.split('@').pop() ?? ''));
}

/**
 * Enforced orgs this principal belongs to but has not signed in for, by org
 * id. Empty for anonymous and internal principals (no `authMethod`).
 */
export async function unmetSso(
  env: Env,
  principal: Principal | null,
): Promise<Map<string, SsoRequirement>> {
  const unmet = new Map<string, SsoRequirement>();
  if (principal?.authMethod === undefined) return unmet;
  const rows = await q<Record<string, unknown>>(
    env,
    `SELECT s.*, o.${C.orgs.slug} AS slug FROM org_sso s
       JOIN ${T.orgs} o ON o.${C.orgs.id} = s.org_id
      WHERE s.enforced = 1
        AND (EXISTS (SELECT 1 FROM ${T.orgMembers} m
                      WHERE m.${C.orgMembers.orgId} = s.org_id AND m.${C.orgMembers.userId} = ?)
             OR EXISTS (SELECT 1 FROM ${T.teamMembers} tm
                          JOIN ${T.teams} t ON t.${C.teams.id} = tm.${C.teamMembers.teamId}
                         WHERE t.${C.teams.orgId} = s.org_id AND tm.${C.teamMembers.userId} = ?))`,
    [principal.userId, principal.userId],
  );
  for (const row of rows) {
    const cfg = ssoConfigSchema.parse(row);
    if (await satisfiesSso(env, principal.userId, principal.authMethod, cfg)) continue;
    const provider = ssoProviderId(env, cfg);
    unmet.set(cfg.org_id, {
      org: z.string().parse(row['slug']),
      sign_in: provider && `/auth/oidc/${provider}`,
    });
  }
  return unmet;
}

/** The unmet SSO requirement guarding this repo for this principal, or null. */
export async function ssoRequirement(
  env: Env,
  repo: RepoRecord,
  principal: Principal | null,
): Promise<SsoRequirement | null> {
  if (repo.owner_kind !== 'org' || !repo.owner_id) return null;
  if (principal?.authMethod === undefined) return null;
  return (await unmetSso(env, principal)).get(repo.owner_id) ?? null;
}

/** Human message for an `sso_required` refusal. */
export function ssoMessage(req: SsoRequirement, origin: string): string {
  return `org ${req.org} requires signing in through its identity provider${
    req.sign_in ? ` (${origin}${req.sign_in})` : ''
  }; API tokens must be created after that sign-in`;
}
