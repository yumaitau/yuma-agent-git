import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../auth/principal';
import { requireRecentMfa } from '../auth/session';
import {
  satisfiesSso,
  ssoConfigSchema,
  ssoProviderId,
  type SsoConfig,
} from '../auth/sso';
import { q1, run } from '../db/client';
import { ApiError } from '../core/errors';
import { recordAudit } from '../audit/record';
import { errorResponse, readJsonBody } from './errors';
import { loadOrg } from './orgs';

/**
 * Org SSO settings (issue #27). Members read them (to know where to sign in);
 * owners with a recent second factor change them. The IdP must be one of the
 * instance's OIDC providers, and an owner can only enforce SSO from a session
 * that already meets it, so enforcing never locks the owner out.
 *
 *   GET    /api/v1/orgs/:org/sso   settings, plus whether the caller meets them
 *   PUT    /api/v1/orgs/:org/sso   set (owners)
 *   DELETE /api/v1/orgs/:org/sso   remove (owners)
 */
export const orgSsoRoutes = new Hono<AppEnv>();

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export const putSsoSchema = z.object({
  protocol: z.enum(['oidc', 'saml']),
  issuer: z.url(),
  client_id: z.string().min(1).max(256),
  enforced: z.boolean(),
  allowed_domains: z
    .array(
      z
        .string()
        .transform((d) => d.toLowerCase())
        .pipe(z.string().regex(DOMAIN_RE)),
    )
    .max(50)
    .optional(),
});

async function loadSso(
  env: AppEnv['Bindings'],
  orgId: string,
): Promise<SsoConfig | null> {
  const row = await q1(env, 'SELECT * FROM org_sso WHERE org_id = ?', [orgId]);
  return row ? ssoConfigSchema.parse(row) : null;
}

function view(env: AppEnv['Bindings'], cfg: SsoConfig): Record<string, unknown> {
  return {
    protocol: cfg.protocol,
    issuer: cfg.issuer,
    client_id: cfg.client_id,
    enforced: cfg.enforced === 1,
    allowed_domains: z.array(z.string()).parse(JSON.parse(cfg.allowed_domains)),
    provider: ssoProviderId(env, cfg),
  };
}

orgSsoRoutes.get('/orgs/:org/sso', async (c) => {
  try {
    const { org } = await loadOrg(c, 'member');
    const cfg = await loadSso(c.env, org.id);
    const principal = c.get('principal');
    return c.json(
      {
        sso: cfg ? view(c.env, cfg) : null,
        satisfied:
          cfg !== null &&
          principal !== null &&
          (await satisfiesSso(
            c.env,
            principal.userId,
            principal.authMethod ?? null,
            cfg,
          )),
      },
      200,
      { 'cache-control': 'private, no-store' },
    );
  } catch (err) {
    return errorResponse(c, err);
  }
});

orgSsoRoutes.put('/orgs/:org/sso', async (c) => {
  try {
    const { org, me } = await loadOrg(c, 'owner');
    const mfa = await requireRecentMfa(c);
    if (mfa) return mfa;
    const parsed = putSsoSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) {
      throw new ApiError(
        400,
        'invalid_request',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      );
    }
    const input = parsed.data;
    if (input.protocol === 'saml') {
      throw new ApiError(400, 'saml_unsupported', 'SAML sign-in is not available yet');
    }
    const cfg: SsoConfig = {
      org_id: org.id,
      protocol: input.protocol,
      issuer: input.issuer,
      client_id: input.client_id,
      enforced: input.enforced ? 1 : 0,
      allowed_domains: JSON.stringify(input.allowed_domains ?? []),
    };
    if (ssoProviderId(c.env, cfg) === null) {
      throw new ApiError(
        400,
        'unknown_identity_provider',
        'issuer and client_id must match a configured OIDC provider',
      );
    }
    const authMethod = c.get('principal')?.authMethod ?? null;
    if (input.enforced && !(await satisfiesSso(c.env, me.user_id, authMethod, cfg))) {
      throw new ApiError(
        409,
        'sso_not_verified',
        'sign in through this identity provider before enforcing it',
      );
    }
    await run(
      c.env,
      `INSERT INTO org_sso (org_id, protocol, issuer, client_id, enforced, allowed_domains, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (org_id) DO UPDATE SET protocol = excluded.protocol, issuer = excluded.issuer,
         client_id = excluded.client_id, enforced = excluded.enforced,
         allowed_domains = excluded.allowed_domains, updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`,
      [
        cfg.org_id,
        cfg.protocol,
        cfg.issuer,
        cfg.client_id,
        cfg.enforced,
        cfg.allowed_domains,
        me.user_id,
        Date.now(),
      ],
    );
    const sso = view(c.env, cfg);
    await recordAudit(c, {
      action: 'org.sso.set',
      orgId: org.slug,
      target: { org: org.slug, ...sso },
    });
    return c.json({ sso });
  } catch (err) {
    return errorResponse(c, err);
  }
});

orgSsoRoutes.delete('/orgs/:org/sso', async (c) => {
  try {
    const { org } = await loadOrg(c, 'owner');
    const mfa = await requireRecentMfa(c);
    if (mfa) return mfa;
    const removed = await q1(
      c.env,
      'DELETE FROM org_sso WHERE org_id = ? RETURNING org_id',
      [org.id],
    );
    if (!removed)
      throw new ApiError(404, 'sso_not_configured', `org ${org.slug} has no SSO`);
    await recordAudit(c, {
      action: 'org.sso.delete',
      orgId: org.slug,
      target: { org: org.slug },
    });
    return c.json({ ok: true });
  } catch (err) {
    return errorResponse(c, err);
  }
});
