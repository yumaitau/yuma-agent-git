import { z } from 'zod';
import { Hono } from 'hono';
import { q, q1 } from '../db/client';
import { apiError, errorResponse } from '../api/errors';
import { oidcProviders, oidcRoutes } from './oidc';
import { scimRoutes } from './scim';
import { currentSession, MFA_MAX_AGE_MS } from './session';
import { totpRoutes } from './totp';
import { listPasskeys, webauthnRoutes } from './webauthn';
import type { AppEnv } from './principal';

/**
 * Account security summary (issue #27) for the dashboard's Security page, and
 * the one mount point for every Yuma-owned identity route.
 */

const securityRoutes = new Hono<AppEnv>();

const identityRowSchema = z.object({
  provider: z.string(),
  email: z.string().nullable(),
  linked_at: z.number(),
});

securityRoutes.get('/api/v1/me/security', async (c) => {
  try {
    const user = c.get('user');
    if (!user) return apiError(c, 401, 'unauthorized', 'session required');
    const session = await currentSession(c.env, c.req.header('cookie'));
    const identities = await q(
      c.env,
      'SELECT provider, email, linked_at FROM user_identities WHERE user_id = ? ORDER BY linked_at',
      [user.id],
    );
    const totp = await q1<{ confirmed_at: number | null }>(
      c.env,
      'SELECT confirmed_at FROM totp_secrets WHERE user_id = ?',
      [user.id],
    );
    const mfaAt = session?.mfa_at ?? null;
    return c.json(
      {
        user: { id: user.id, login: user.login },
        session: {
          auth_method: session?.auth_method ?? 'github',
          mfa_at: mfaAt,
          mfa_fresh: mfaAt !== null && Date.now() - mfaAt <= MFA_MAX_AGE_MS,
        },
        identities: identities.map((r) => identityRowSchema.parse(r)),
        passkeys: (await listPasskeys(c.env, user.id)).map((k) => ({
          id: k.id,
          label: k.label,
          created_at: k.created_at,
          last_used_at: k.last_used_at,
        })),
        totp: { enrolled: totp?.confirmed_at != null },
        providers: oidcProviders(c.env).map((p) => ({ id: p.id, name: p.name })),
      },
      200,
      { 'cache-control': 'private, no-store' },
    );
  } catch (err) {
    return errorResponse(c, err);
  }
});

export const identityRoutes = new Hono<AppEnv>()
  .route('/', oidcRoutes)
  .route('/', webauthnRoutes)
  .route('/', totpRoutes)
  .route('/', securityRoutes)
  .route('/', scimRoutes);
