import { z } from 'zod';
import { Hono } from 'hono';
import type { Env } from '../env';
import { C, T } from '../db/schema';
import { parseUserRow, q1, run } from '../db/client';
import { apiError, errorResponse } from '../api/errors';
import { ApiError } from '../core/errors';
import { sha256Hex } from '../core/hashing';
import { b64urlDecode, b64urlEncode, randomB64url, sha256Bytes } from './encoding';
import {
  createSession,
  createUser,
  findIdentityUser,
  linkIdentity,
  requireRecentMfa,
  sessionCookie,
} from './session';
import type { AppEnv } from './principal';

/**
 * Generic OIDC sign-in (issue #27): authorisation code flow with PKCE (S256),
 * issuer discovery, and single-use state + nonce checks. Google Workspace and
 * Microsoft Entra ID are presets; any compliant issuer works.
 *
 * `OIDC_PROVIDERS` is a JSON array (a plain var, no secrets in it):
 *   [{"id":"google","preset":"google","client_id":"…","allowed_domains":["example.com"]},
 *    {"id":"entra","preset":"entra","tenant":"<tenant id>","client_id":"…"},
 *    {"id":"okta","name":"Okta","issuer":"https://…","client_id":"…"}]
 * Each client secret is the Worker secret `OIDC_<ID>_CLIENT_SECRET`.
 */

export const oidcRoutes = new Hono<AppEnv>();

const STATE_TTL_MS = 10 * 60 * 1000;
const CACHE_TTL_MS = 60 * 60 * 1000;
const CLOCK_SKEW_S = 60;

const providerConfigSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,32}$/),
  preset: z.enum(['google', 'entra']).optional(),
  name: z.string().min(1).optional(),
  issuer: z.url().optional(),
  // Entra issuers embed the tenant id; a domain name would not match discovery
  tenant: z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    .optional(),
  client_id: z.string().min(1),
  allowed_domains: z.array(z.string().min(1)).optional(),
});

export interface OidcProvider {
  id: string;
  name: string;
  issuer: string;
  clientId: string;
  clientSecret: string | null;
  allowedDomains: string[];
  /** Google Workspace: the `hd` claim must be an allowed domain as well. */
  checkHostedDomain: boolean;
}

/** Configured providers. Bad config is logged (shape only) and yields none. */
export function oidcProviders(env: Env): OidcProvider[] {
  if (!env.OIDC_PROVIDERS) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(env.OIDC_PROVIDERS);
  } catch {
    console.error('OIDC_PROVIDERS is not valid JSON');
    return [];
  }
  const parsed = z.array(providerConfigSchema).safeParse(raw);
  if (!parsed.success) {
    console.error('OIDC_PROVIDERS does not match the expected shape');
    return [];
  }
  const providers: OidcProvider[] = [];
  for (const cfg of parsed.data) {
    const issuer =
      cfg.preset === 'google'
        ? 'https://accounts.google.com'
        : cfg.preset === 'entra'
          ? cfg.tenant &&
            `https://login.microsoftonline.com/${cfg.tenant.toLowerCase()}/v2.0`
          : cfg.issuer;
    if (!issuer) {
      console.error(`OIDC provider ${cfg.id} has no issuer (Entra needs a tenant id)`);
      continue;
    }
    const secretName = `OIDC_${cfg.id.toUpperCase().replace(/-/g, '_')}_CLIENT_SECRET`;
    const secret = (env as unknown as Record<string, unknown>)[secretName];
    providers.push({
      id: cfg.id,
      name:
        cfg.name ??
        (cfg.preset === 'google'
          ? 'Google'
          : cfg.preset === 'entra'
            ? 'Microsoft'
            : cfg.id),
      issuer,
      clientId: cfg.client_id,
      clientSecret: typeof secret === 'string' && secret !== '' ? secret : null,
      allowedDomains: (cfg.allowed_domains ?? []).map((d) => d.toLowerCase()),
      checkHostedDomain: cfg.preset === 'google',
    });
  }
  return providers;
}

// ---------------------------------------------------------------------------
// Discovery + JWKS (cached per isolate)
// ---------------------------------------------------------------------------

const discoverySchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.url(),
  token_endpoint: z.url(),
  jwks_uri: z.url(),
});
type Discovery = z.infer<typeof discoverySchema>;

const jwkSchema = z
  .object({
    kty: z.string(),
    kid: z.string().optional(),
    n: z.string().optional(),
    e: z.string().optional(),
    crv: z.string().optional(),
    x: z.string().optional(),
    y: z.string().optional(),
  })
  .loose();
type Jwk = z.infer<typeof jwkSchema>;

const discoveryCache = new Map<string, { at: number; doc: Discovery }>();
const jwksCache = new Map<string, { at: number; keys: Jwk[] }>();

async function discover(issuer: string, now: number = Date.now()): Promise<Discovery> {
  const hit = discoveryCache.get(issuer);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.doc;
  const res = await fetch(
    `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`,
    {
      headers: { accept: 'application/json' },
    },
  );
  const doc = discoverySchema.safeParse(res.ok ? await res.json() : null);
  if (
    !doc.success ||
    doc.data.issuer !== issuer ||
    ![doc.data.authorization_endpoint, doc.data.token_endpoint, doc.data.jwks_uri].every(
      (u) => u.startsWith('https://'),
    )
  ) {
    throw new ApiError(
      502,
      'oidc_discovery_failed',
      'identity provider discovery failed',
    );
  }
  discoveryCache.set(issuer, { at: now, doc: doc.data });
  return doc.data;
}

async function fetchJwks(jwksUri: string, now: number): Promise<Jwk[]> {
  const res = await fetch(jwksUri, { headers: { accept: 'application/json' } });
  const body = z
    .object({ keys: z.array(jwkSchema) })
    .safeParse(res.ok ? await res.json() : null);
  if (!body.success) {
    throw new ApiError(
      502,
      'oidc_discovery_failed',
      'identity provider keys unavailable',
    );
  }
  jwksCache.set(jwksUri, { at: now, keys: body.data.keys });
  return body.data.keys;
}

/** The provider key for `kid`, refetching once in case keys rotated. */
async function signingKey(
  jwksUri: string,
  kid: string | undefined,
  now: number,
): Promise<Jwk> {
  const hit = jwksCache.get(jwksUri);
  const pick = (keys: Jwk[]): Jwk | undefined =>
    keys.find((k) => kid === undefined || k.kid === kid);
  const cached = hit && now - hit.at < CACHE_TTL_MS ? pick(hit.keys) : undefined;
  const key = cached ?? pick(await fetchJwks(jwksUri, now));
  if (!key) throw new ApiError(401, 'invalid_id_token', 'unknown signing key');
  return key;
}

// ---------------------------------------------------------------------------
// ID token verification
// ---------------------------------------------------------------------------

const JWS_ALGS = {
  RS256: {
    kty: 'RSA',
    importAlg: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    verifyAlg: { name: 'RSASSA-PKCS1-v1_5' },
  },
  ES256: {
    kty: 'EC',
    importAlg: { name: 'ECDSA', namedCurve: 'P-256' },
    verifyAlg: { name: 'ECDSA', hash: 'SHA-256' },
  },
} as const;

const headerSchema = z.object({ alg: z.string(), kid: z.string().optional() });

const claimsSchema = z.object({
  iss: z.string(),
  sub: z.string().min(1),
  aud: z.union([z.string(), z.array(z.string())]),
  exp: z.number(),
  iat: z.number(),
  nonce: z.string().optional(),
  azp: z.string().optional(),
  email: z.string().optional(),
  email_verified: z.union([z.boolean(), z.string()]).optional(),
  hd: z.string().optional(),
  preferred_username: z.string().optional(),
  amr: z.array(z.string()).optional(),
});
export type IdTokenClaims = z.infer<typeof claimsSchema>;

function decodeJson(part: string): unknown {
  return JSON.parse(new TextDecoder().decode(b64urlDecode(part)));
}

/**
 * Verify an ID token: RS256/ES256 signature against the issuer's JWKS, then
 * iss, aud (+azp), exp, iat and nonce. Anything off is `401 invalid_id_token`.
 */
export async function verifyIdToken(
  idToken: string,
  expected: { issuer: string; clientId: string; nonce: string; jwksUri: string },
  now: number = Date.now(),
): Promise<IdTokenClaims> {
  const invalid = (why: string): ApiError =>
    new ApiError(401, 'invalid_id_token', `id token rejected: ${why}`);
  const [h = '', p = '', s = '', ...rest] = idToken.split('.');
  if (rest.length > 0 || !h || !p || !s) throw invalid('malformed');
  let header: z.infer<typeof headerSchema>;
  let claims: IdTokenClaims;
  try {
    header = headerSchema.parse(decodeJson(h));
    claims = claimsSchema.parse(decodeJson(p));
  } catch {
    throw invalid('malformed');
  }
  const alg = JWS_ALGS[header.alg as keyof typeof JWS_ALGS] as
    (typeof JWS_ALGS)[keyof typeof JWS_ALGS] | undefined;
  if (!alg) throw invalid('unsupported algorithm');
  const jwk = await signingKey(expected.jwksUri, header.kid, now);
  if (jwk.kty !== alg.kty) throw invalid('key type mismatch');
  // import only the key material: provider-supplied alg/use/key_ops stay out
  const material =
    jwk.kty === 'RSA'
      ? { kty: 'RSA', n: jwk.n, e: jwk.e }
      : { kty: 'EC', crv: jwk.crv, x: jwk.x, y: jwk.y };
  let ok = false;
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      material as JsonWebKey,
      alg.importAlg,
      false,
      ['verify'],
    );
    ok = await crypto.subtle.verify(
      alg.verifyAlg,
      key,
      b64urlDecode(s) as BufferSource,
      new TextEncoder().encode(`${h}.${p}`),
    );
  } catch {
    ok = false;
  }
  if (!ok) throw invalid('bad signature');

  const nowS = Math.floor(now / 1000);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== expected.issuer) throw invalid('issuer');
  if (!aud.includes(expected.clientId)) throw invalid('audience');
  if (aud.length > 1 && claims.azp !== expected.clientId)
    throw invalid('authorised party');
  if (claims.exp < nowS - CLOCK_SKEW_S) throw invalid('expired');
  if (claims.iat > nowS + CLOCK_SKEW_S) throw invalid('issued in the future');
  if (claims.nonce !== expected.nonce) throw invalid('nonce');
  return claims;
}

/** The email, lower-cased, only when the provider says it is verified. */
function verifiedEmail(claims: IdTokenClaims): string | null {
  const verified = claims.email_verified === true || claims.email_verified === 'true';
  return verified && claims.email ? claims.email.toLowerCase() : null;
}

function domainAllowed(
  provider: OidcProvider,
  claims: IdTokenClaims,
  email: string | null,
): boolean {
  if (provider.allowedDomains.length === 0) return true;
  const domain = email?.split('@')[1];
  if (!domain || !provider.allowedDomains.includes(domain)) return false;
  return (
    !provider.checkHostedDomain ||
    (claims.hd !== undefined && provider.allowedDomains.includes(claims.hd.toLowerCase()))
  );
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function callbackUrl(reqUrl: string, providerId: string): string {
  return `${new URL(reqUrl).origin}/auth/oidc/${providerId}/callback`;
}

const stateRowSchema = z.object({
  provider: z.string(),
  nonce: z.string(),
  code_verifier: z.string(),
  link_user_id: z.string().nullable(),
  expires_at: z.number(),
});

/**
 * `GET /auth/oidc/:provider` starts sign-in. With `?link=1` and a session it
 * links that identity to the signed-in user instead (needs recent MFA when
 * the user has a second factor, since it adds a way in).
 */
oidcRoutes.get('/auth/oidc/:provider', async (c) => {
  try {
    const provider = oidcProviders(c.env).find((p) => p.id === c.req.param('provider'));
    if (!provider)
      return apiError(c, 404, 'unknown_provider', 'no such sign-in provider');
    const user = c.get('user');
    const linking = c.req.query('link') === '1';
    if (linking) {
      const mfa = await requireRecentMfa(c);
      if (mfa) return mfa;
    }
    const doc = await discover(provider.issuer);
    const state = randomB64url(32);
    const nonce = randomB64url(16);
    const verifier = randomB64url(32);
    const now = Date.now();
    // opportunistic purge of expired states
    await run(c.env, 'DELETE FROM oidc_states WHERE expires_at < ?', [now]);
    await run(
      c.env,
      `INSERT INTO oidc_states (state_hash, provider, nonce, code_verifier, link_user_id, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        await sha256Hex(new TextEncoder().encode(state)),
        provider.id,
        nonce,
        verifier,
        linking && user ? user.id : null,
        now,
        now + STATE_TTL_MS,
      ],
    );
    const url = new URL(doc.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', provider.clientId);
    url.searchParams.set('redirect_uri', callbackUrl(c.req.url, provider.id));
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    url.searchParams.set(
      'code_challenge',
      b64urlEncode(await sha256Bytes(new TextEncoder().encode(verifier))),
    );
    url.searchParams.set('code_challenge_method', 'S256');
    return c.redirect(url.toString(), 302);
  } catch (err) {
    return errorResponse(c, err);
  }
});

oidcRoutes.get('/auth/oidc/:provider/callback', async (c) => {
  try {
    const provider = oidcProviders(c.env).find((p) => p.id === c.req.param('provider'));
    if (!provider)
      return apiError(c, 404, 'unknown_provider', 'no such sign-in provider');
    if (c.req.query('error')) {
      return apiError(c, 400, 'oidc_error', 'the identity provider did not sign you in');
    }
    const code = c.req.query('code');
    const state = c.req.query('state');
    if (!code || !state) {
      return apiError(c, 400, 'invalid_request', 'code and state are required');
    }

    // single-use state: consumed atomically BEFORE any token exchange
    const consumed = await q1(
      c.env,
      'DELETE FROM oidc_states WHERE state_hash = ? RETURNING *',
      [await sha256Hex(new TextEncoder().encode(state))],
    );
    const stored = consumed ? stateRowSchema.parse(consumed) : null;
    if (!stored || stored.provider !== provider.id) {
      return apiError(c, 400, 'invalid_state', 'unknown or reused oidc state');
    }
    if (stored.expires_at < Date.now()) {
      return apiError(c, 400, 'invalid_state', 'expired oidc state');
    }

    const doc = await discover(provider.issuer);
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: callbackUrl(c.req.url, provider.id),
      client_id: provider.clientId,
      code_verifier: stored.code_verifier,
    });
    if (provider.clientSecret) form.set('client_secret', provider.clientSecret);
    const tokenRes = await fetch(doc.token_endpoint, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: form,
    });
    const tokenBody = z
      .object({ id_token: z.string() })
      .safeParse(tokenRes.ok ? await tokenRes.json() : null);
    if (!tokenBody.success) {
      return apiError(
        c,
        502,
        'oidc_exchange_failed',
        'identity provider token exchange failed',
      );
    }
    const claims = await verifyIdToken(tokenBody.data.id_token, {
      issuer: provider.issuer,
      clientId: provider.clientId,
      nonce: stored.nonce,
      jwksUri: doc.jwks_uri,
    });
    const email = verifiedEmail(claims);
    if (!domainAllowed(provider, claims, email)) {
      return apiError(
        c,
        403,
        'domain_not_allowed',
        'this account is not in an allowed domain',
      );
    }

    const identity = `oidc:${provider.id}`;
    const owner = await findIdentityUser(c.env, identity, claims.sub);

    if (stored.link_user_id) {
      const user = c.get('user');
      if (!user || user.id !== stored.link_user_id) {
        return apiError(c, 403, 'link_session_mismatch', 'sign in again, then link');
      }
      if (owner && owner !== user.id) {
        return apiError(
          c,
          409,
          'identity_in_use',
          'that identity belongs to another account',
        );
      }
      await linkIdentity(c.env, user.id, identity, claims.sub, email);
      return c.redirect('/security', 302);
    }

    // Known identity, else a SCIM-provisioned person with the same verified
    // email, else a brand new user (just-in-time).
    let userId = owner;
    if (!userId && email) {
      const scim = await q1<{ user_id: string }>(
        c.env,
        "SELECT user_id FROM user_identities WHERE provider = 'scim' AND email = ?",
        [email],
      );
      userId = scim?.user_id ?? null;
    }
    const user = userId
      ? parseUserRow(
          await q1(c.env, `SELECT * FROM ${T.users} WHERE ${C.users.id} = ?`, [userId]),
        )
      : await createUser(c.env, email ?? claims.preferred_username ?? claims.sub);
    if (user.active === 0) {
      return apiError(c, 403, 'account_disabled', 'this account has been deprovisioned');
    }
    if (!owner) await linkIdentity(c.env, user.id, identity, claims.sub, email);

    // an IdP-asserted MFA (RFC 8176 `amr`) counts as this session's second factor
    const now = Date.now();
    const session = await createSession(c.env, user.id, now, {
      method: identity,
      mfaAt: claims.amr?.includes('mfa') ? now : null,
    });
    return new Response(null, {
      status: 302,
      headers: { location: '/', 'set-cookie': sessionCookie(c.req.url, session.token) },
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});
