import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Env } from '../env';
import type { AppEnv } from '../auth/principal';
import { q1, run } from '../db/client';
import { getRepo } from '../db/repos';
import { ApiError } from '../core/errors';
import { sha256Hex } from '../core/hashing';
import { apiError, errorResponse } from '../api/errors';
import { b64urlEncode, randomB64url } from '../auth/encoding';
import { commitIdsFor } from '../git/mapping';
import { appendAudit } from '../audit/record';
import { parsePolicy, type CiPolicy, type CiRun } from './config';
import { parseContext, type RunContext } from './context';
import { jobTrust } from './environments';

/**
 * CI workload identity (issue #50): an OpenID Connect issuer whose ID tokens
 * look like GitHub Actions tokens, so cloud trust policies (AWS IAM, GCP
 * workload identity, Azure federated credentials, Vault JWT auth) port over.
 *
 *   GET  {issuer}/.well-known/openid-configuration   public, no session
 *   GET  {issuer}/jwks                                public, no session
 *   GET|POST {issuer}/token?audience=…                per-run request token
 *
 * issuer = CI_OIDC_ISSUER, else `{origin}/ci/oidc`. Tokens are RS256, signed
 * with the first key in the CI_OIDC_SIGNING_KEYS JWK set; every key in the set
 * is published, so a rotation keeps verifying tokens from the previous key.
 */
export const DEFAULT_AUDIENCE = 'sts.amazonaws.com';
export const DEFAULT_LIFETIME_SECONDS = 600;
export const MAX_LIFETIME_SECONDS = 3600;
export const REQUEST_TOKEN_PREFIX = 'yagjob_';
const AUDIENCE_RE = /^[\x21-\x7e]{1,256}$/;

const jwkSchema = z.object({
  kty: z.literal('RSA'),
  kid: z.string().min(1).max(128),
  n: z.string().min(1),
  e: z.string().min(1),
  d: z.string().optional(),
  p: z.string().optional(),
  q: z.string().optional(),
  dp: z.string().optional(),
  dq: z.string().optional(),
  qi: z.string().optional(),
});
const keySetSchema = z.object({ keys: z.array(jwkSchema).min(1).max(5) });

interface PublicJwk {
  kty: 'RSA';
  kid: string;
  n: string;
  e: string;
  alg: 'RS256';
  use: 'sig';
}
interface SigningKeys {
  kid: string;
  sign: CryptoKey;
  published: PublicJwk[];
}

let cached: { raw: string; keys: Promise<SigningKeys> } | null = null;

function notConfigured(): ApiError {
  return new ApiError(
    503,
    'oidc_not_configured',
    'CI OIDC is not configured. An operator must set CI_OIDC_SIGNING_KEYS.',
  );
}

async function importKeys(raw: string): Promise<SigningKeys> {
  let set: z.infer<typeof keySetSchema>;
  try {
    set = keySetSchema.parse(JSON.parse(raw));
  } catch {
    // never echo key material
    throw notConfigured();
  }
  const current = set.keys[0]!;
  if (!current.d) throw notConfigured();
  const sign = await crypto.subtle.importKey(
    'jwk',
    { ...current, alg: 'RS256', ext: false },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return {
    kid: current.kid,
    sign,
    published: set.keys.map((k) => ({
      kty: 'RSA',
      kid: k.kid,
      n: k.n,
      e: k.e,
      alg: 'RS256',
      use: 'sig',
    })),
  };
}

function signingKeys(env: Env): Promise<SigningKeys> {
  const raw = env.CI_OIDC_SIGNING_KEYS;
  if (!raw) return Promise.reject(notConfigured());
  if (cached?.raw !== raw) {
    const keys = importKeys(raw);
    cached = { raw, keys };
    keys.catch(() => {
      if (cached?.keys === keys) cached = null;
    });
  }
  return cached.keys;
}

export function issuerFor(env: Env, origin: string): string {
  return (env.CI_OIDC_ISSUER || `${origin}/ci/oidc`).replace(/\/+$/, '');
}

function encodeJson(value: unknown): string {
  return b64urlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

export async function signJwt(
  env: Env,
  claims: Record<string, unknown>,
): Promise<string> {
  const keys = await signingKeys(env);
  const input = `${encodeJson({ alg: 'RS256', typ: 'JWT', kid: keys.kid })}.${encodeJson(claims)}`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    keys.sign,
    new TextEncoder().encode(input),
  );
  return `${input}.${b64urlEncode(new Uint8Array(signature))}`;
}

export interface IdTokenClaims {
  iss: string;
  aud: string;
  sub: string;
  iat: number;
  nbf: number;
  exp: number;
  jti: string;
  repository: string;
  repository_id: string;
  repository_owner: string;
  ref: string;
  ref_type: 'branch' | 'tag' | '';
  sha?: string;
  changeset: string;
  run_id: string;
  job: string;
  event_name: RunContext['event'];
  environment?: string;
  actor: string;
  actor_id: string;
  actor_kind: RunContext['actor_kind'];
  job_workflow_ref: string;
}

/** GitHub-shaped claims for one run. Throws when the run has no subject. */
export async function claimsFor(
  env: Env,
  job: CiRun,
  policy: CiPolicy,
  context: RunContext,
  audience: string,
  lifetimeSeconds: number,
  now = Date.now(),
): Promise<IdTokenClaims> {
  const repo = await getRepo(env, job.repo_id);
  if (!repo) throw new ApiError(404, 'repo_not_found', 'Repository not found');
  const slug = repo.slug;
  const environment = policy.environment ?? undefined;
  let sub: string;
  if (environment) sub = `repo:${slug}:environment:${environment}`;
  else if (context.event === 'pull_request') sub = `repo:${slug}:pull_request`;
  else if (context.ref) sub = `repo:${slug}:ref:${context.ref}`;
  else
    throw new ApiError(
      409,
      'oidc_subject_unavailable',
      'Only runs of a branch, tag, pull request or environment can request an ID token.',
    );
  const ref = context.ref ?? '';
  const user = await q1<{ login: string }>(env, 'SELECT login FROM users WHERE id = ?', [
    job.requested_by,
  ]);
  const sha = (await commitIdsFor(env, repo.id, job.head_cs))?.sha1;
  const iat = Math.floor(now / 1000);
  const lifetime = Math.min(
    MAX_LIFETIME_SECONDS,
    Math.max(60, Math.floor(lifetimeSeconds)),
  );
  return {
    iss: issuerFor(env, context.origin),
    aud: audience,
    sub,
    iat,
    nbf: iat,
    exp: iat + lifetime,
    jti: crypto.randomUUID(),
    repository: slug,
    repository_id: repo.id,
    repository_owner: slug.split('/')[0]!,
    ref,
    ref_type: ref.startsWith('refs/heads/')
      ? 'branch'
      : ref.startsWith('refs/tags/')
        ? 'tag'
        : '',
    ...(sha ? { sha } : {}),
    changeset: job.head_cs,
    run_id: job.id,
    job: 'ci',
    event_name: context.event,
    ...(environment ? { environment } : {}),
    actor: user?.login ?? job.requested_by,
    actor_id: job.requested_by,
    actor_kind: context.actor_kind,
    job_workflow_ref: `${slug}/.yag/pipeline@${ref || job.head_cs}`,
  };
}

/** Sign an ID token for a running job and audit its claims (never the token). */
export async function mintIdToken(
  env: Env,
  job: CiRun,
  policy: CiPolicy,
  context: RunContext,
  audience: string,
  lifetimeSeconds = DEFAULT_LIFETIME_SECONDS,
): Promise<{ token: string; claims: IdTokenClaims }> {
  if (!AUDIENCE_RE.test(audience))
    throw new ApiError(
      400,
      'invalid_audience',
      'Audience must be 1 to 256 visible characters.',
    );
  const claims = await claimsFor(env, job, policy, context, audience, lifetimeSeconds);
  const token = await signJwt(env, { ...claims });
  const repo = await getRepo(env, job.repo_id);
  await appendAudit(env, {
    action: 'ci.oidc.token',
    repo: repo ? { id: repo.id, slug: repo.slug } : null,
    actor: { kind: 'system', id: `ci-run:${job.id}`, onBehalfOf: job.requested_by },
    target: { ...claims },
  });
  return { token, claims };
}

/** A per-run request token, stored hashed and dead at the run deadline. */
export async function createRequestToken(
  env: Env,
  runId: string,
  expiresAt: number,
): Promise<string> {
  const raw = `${REQUEST_TOKEN_PREFIX}${randomB64url(32)}`;
  await run(
    env,
    'INSERT INTO ci_job_tokens (token_hash, run_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
    [await sha256Hex(new TextEncoder().encode(raw)), runId, expiresAt, Date.now()],
  );
  return raw;
}

function unauthorized(): ApiError {
  return new ApiError(
    401,
    'invalid_request_token',
    'Unknown or expired CI request token.',
  );
}

/** Resolve a request token to its running job, or throw. */
async function jobForRequest(
  env: Env,
  raw: string,
  runId: string | undefined,
): Promise<CiRun> {
  if (!raw.startsWith(REQUEST_TOKEN_PREFIX)) throw unauthorized();
  const now = Date.now();
  const row = await q1<{ run_id: string; expires_at: number }>(
    env,
    'SELECT run_id, expires_at FROM ci_job_tokens WHERE token_hash = ?',
    [await sha256Hex(new TextEncoder().encode(raw))],
  );
  if (!row || row.expires_at <= now || (runId !== undefined && runId !== row.run_id))
    throw unauthorized();
  const job = await q1<CiRun>(env, 'SELECT * FROM ci_runs WHERE id = ?', [row.run_id]);
  if (!job || job.state !== 'running' || !job.deadline || job.deadline <= now)
    throw new ApiError(
      401,
      'run_not_active',
      'The run for this request token has ended.',
    );
  return job;
}

export const oidcRoutes = new Hono<AppEnv>();

function publicJson(c: Context<AppEnv>, body: unknown): Response {
  return c.json(body, 200, { 'cache-control': 'public, max-age=300' });
}

oidcRoutes.get('/ci/oidc/.well-known/openid-configuration', async (c) => {
  try {
    await signingKeys(c.env);
    const issuer = issuerFor(c.env, new URL(c.req.url).origin);
    return publicJson(c, {
      issuer,
      jwks_uri: `${issuer}/jwks`,
      response_types_supported: ['id_token'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      scopes_supported: ['openid'],
      claims_supported: [
        'iss',
        'aud',
        'sub',
        'iat',
        'nbf',
        'exp',
        'jti',
        'repository',
        'repository_id',
        'repository_owner',
        'ref',
        'ref_type',
        'sha',
        'changeset',
        'run_id',
        'job',
        'event_name',
        'environment',
        'actor',
        'actor_id',
        'actor_kind',
        'job_workflow_ref',
      ],
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

oidcRoutes.get('/ci/oidc/jwks', async (c) => {
  try {
    return publicJson(c, { keys: (await signingKeys(c.env)).published });
  } catch (err) {
    return errorResponse(c, err);
  }
});

const lifetimeSchema = z.coerce
  .number()
  .int()
  .min(60)
  .max(MAX_LIFETIME_SECONDS)
  .default(DEFAULT_LIFETIME_SECONDS);

oidcRoutes.on(['GET', 'POST'], '/ci/oidc/token', async (c) => {
  try {
    const header = c.req.header('authorization') ?? '';
    if (!header.startsWith('Bearer '))
      return apiError(
        c,
        401,
        'invalid_request_token',
        'Send the CI request token as a bearer token.',
      );
    const job = await jobForRequest(c.env, header.slice(7), c.req.query('run_id'));
    const policy = parsePolicy(JSON.parse(job.config));
    if (policy.permissions.id_token !== 'write')
      throw new ApiError(
        403,
        'id_token_not_permitted',
        'This pipeline does not have permissions.id_token: write.',
      );
    const context = parseContext(job.context);
    const trust = await jobTrust(c.env, job, policy, context);
    if (!trust.ok || !context)
      throw new ApiError(403, 'credentials_withheld', `No ID token: ${trust.reason}.`);
    const lifetime = lifetimeSchema.safeParse(c.req.query('lifetime') ?? undefined);
    if (!lifetime.success)
      throw new ApiError(400, 'invalid_lifetime', 'lifetime must be 60 to 3600 seconds.');
    const { token } = await mintIdToken(
      c.env,
      job,
      policy,
      context,
      c.req.query('audience') ?? DEFAULT_AUDIENCE,
      lifetime.data,
    );
    c.header('cache-control', 'no-store');
    return c.json({ value: token });
  } catch (err) {
    return errorResponse(c, err);
  }
});
