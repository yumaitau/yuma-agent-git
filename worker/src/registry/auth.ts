import { z } from 'zod';
import type { Env } from '../env';
import type { Principal } from '../auth/principal';
import { decide, pathDecider, restrictingDecision } from '../auth/rbac';
import { ssoMessage } from '../auth/sso';
import { resolveTokenPrincipal } from '../auth/tokens';
import { randomB64url } from '../auth/encoding';
import { resolveCloneToken } from '../ci/runners';
import { REQUEST_TOKEN_PREFIX, verifyIdToken } from '../ci/oidc';
import type { CiRun } from '../ci/config';
import { sha256Hex } from '../core/hashing';
import { q1, run } from '../db/client';
import type { RepoRecord } from '../db/client';

/**
 * Registry credentials and access (issue #53). Package permissions are the
 * linked repo's: pull needs `read`, push needs `write`, delete needs
 * `admin`. Token limits apply on top: API tokens pull with `repo:read` and
 * push with `repo:write`; agent tokens pull with `contents:read` and push
 * with `packages:write` (the delegating human's role still caps them). A
 * caller any path rule restricts cannot use packages at all, like Git: an
 * image or tarball is built from the whole tree.
 *
 * CI jobs sign in with their request token (`yagjob_…`, the
 * `YAG_ID_TOKEN_REQUEST_TOKEN` variable) or an ID token minted for the
 * registry host as audience. Either may pull and push the packages linked to
 * the job's own repo, nothing else. A self-hosted runner's clone token pulls
 * only. Only the Authorization header counts: browser sessions never reach
 * the registry, so a cross-site request cannot write.
 */

export type PackageAction = 'pull' | 'push' | 'delete';

export interface Refusal {
  status: 403 | 404;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export const REGISTRY_TOKEN_PREFIX = 'yagreg_';
export const REGISTRY_TOKEN_TTL_S = 300;

const accessSchema = z.array(
  z.object({ name: z.string(), actions: z.array(z.enum(['pull', 'push', 'delete'])) }),
);
export type Access = z.infer<typeof accessSchema>;

export interface RegistryCaller {
  principal: Principal;
  /** What a registry token was granted; null for a forge credential used directly. */
  access: Access | null;
}

async function hashToken(raw: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(raw));
}

function ciPrincipal(job: CiRun): Principal | null {
  if (job.state !== 'running' || !job.deadline || job.deadline <= Date.now()) return null;
  return {
    kind: 'token',
    userId: job.requested_by,
    tokenId: `ci-run:${job.id}`,
    scopes: ['packages:write'],
    repoId: job.repo_id,
    ciRunId: job.id,
  };
}

/** A running job from its request token (issued only to trusted runs). */
async function requestTokenPrincipal(env: Env, raw: string): Promise<Principal | null> {
  const row = await q1<{ run_id: string; expires_at: number }>(
    env,
    'SELECT run_id, expires_at FROM ci_job_tokens WHERE token_hash = ?',
    [await hashToken(raw)],
  );
  if (!row || row.expires_at <= Date.now()) return null;
  const job = await q1<CiRun>(env, 'SELECT * FROM ci_runs WHERE id = ?', [row.run_id]);
  return job ? ciPrincipal(job) : null;
}

/** A running job from an ID token minted with the registry host as audience. */
async function idTokenPrincipal(
  env: Env,
  raw: string,
  origin: string,
): Promise<Principal | null> {
  const claims = await verifyIdToken(env, raw, new URL(origin).host, origin);
  if (!claims) return null;
  const job = await q1<CiRun>(env, 'SELECT * FROM ci_runs WHERE id = ?', [claims.run_id]);
  return job && job.repo_id === claims.repository_id ? ciPrincipal(job) : null;
}

/** A forge credential: API, agent or app token, CI request or ID token, clone token. */
export async function credentialPrincipal(
  env: Env,
  secret: string,
  origin: string,
): Promise<Principal | null> {
  if (!secret) return null;
  if (secret.startsWith(REQUEST_TOKEN_PREFIX)) return requestTokenPrincipal(env, secret);
  if (secret.split('.').length === 3) return idTokenPrincipal(env, secret, origin);
  return (
    (await resolveTokenPrincipal(env, secret)) ?? (await resolveCloneToken(env, secret))
  );
}

/** The secret in HTTP Basic: the password, or the username when there is none. */
export function basicSecret(header: string): string {
  let decoded = '';
  try {
    decoded = atob(header.slice('Basic '.length).trim());
  } catch {
    return '';
  }
  const colon = decoded.indexOf(':');
  const user = colon < 0 ? decoded : decoded.slice(0, colon);
  const password = colon < 0 ? '' : decoded.slice(colon + 1);
  return password || user;
}

/** The caller from the Authorization header: a registry token or a forge credential. */
export async function registryCaller(
  env: Env,
  header: string | undefined,
  origin: string,
): Promise<RegistryCaller | null> {
  if (!header) return null;
  if (header.startsWith('Basic ')) {
    const principal = await credentialPrincipal(env, basicSecret(header), origin);
    return principal ? { principal, access: null } : null;
  }
  if (!header.startsWith('Bearer ')) return null;
  const raw = header.slice('Bearer '.length).trim();
  if (!raw.startsWith(REGISTRY_TOKEN_PREFIX)) {
    const principal = await credentialPrincipal(env, raw, origin);
    return principal ? { principal, access: null } : null;
  }
  const row = await q1<{ principal: string; access: string; expires_at: number }>(
    env,
    'SELECT principal, access, expires_at FROM registry_tokens WHERE token_hash = ?',
    [await hashToken(raw)],
  );
  if (!row || row.expires_at <= Date.now()) return null;
  return {
    principal: JSON.parse(row.principal) as Principal,
    access: accessSchema.parse(JSON.parse(row.access)),
  };
}

/** Mint a registry token for what the caller was granted. */
export async function mintRegistryToken(
  env: Env,
  principal: Principal,
  access: Access,
): Promise<string> {
  const raw = `${REGISTRY_TOKEN_PREFIX}${randomB64url(32)}`;
  await run(
    env,
    'INSERT INTO registry_tokens (token_hash, principal, access, expires_at) VALUES (?, ?, ?, ?)',
    [
      await hashToken(raw),
      JSON.stringify(principal),
      JSON.stringify(access),
      Date.now() + REGISTRY_TOKEN_TTL_S * 1000,
    ],
  );
  return raw;
}

/** Whether a registry token's grant covers `action` on `name` (forge credentials always do). */
export function granted(
  caller: RegistryCaller,
  name: string,
  action: PackageAction,
): boolean {
  return (
    caller.access === null ||
    caller.access.some((a) => a.name === name && a.actions.includes(action))
  );
}

const HIDDEN: Refusal = {
  status: 404,
  code: 'name_unknown',
  message: 'repository name not known to registry',
};

/**
 * Whether `principal` may `action` a package linked to `repo`: null when
 * allowed, else 404 (repo unreadable, existence never leaked) or 403.
 * Agent guardrails are judged separately, at the publish itself.
 */
export async function authorize(
  env: Env,
  origin: string,
  principal: Principal,
  repo: RepoRecord,
  action: PackageAction,
): Promise<Refusal | null> {
  if (principal.kind === 'token' && principal.ciRunId) {
    if (principal.repoId !== repo.id) return HIDDEN;
    if (action === 'pull') return null;
    if (action === 'push' && principal.scopes.includes('packages:write')) return null;
    return {
      status: 403,
      code: 'forbidden',
      message:
        action === 'push'
          ? 'this CI credential can only pull packages'
          : 'CI jobs cannot delete packages',
    };
  }
  let effective = principal;
  if (principal.kind === 'agent' && action !== 'pull') {
    if (!principal.scopes.includes('packages:write'))
      return {
        status: 403,
        code: 'insufficient_scope',
        message: 'Agent token requires packages:write',
      };
    // packages:write stands in for contents:write here; the human's role still applies
    effective = { ...principal, scopes: [...principal.scopes, 'contents:write'] };
  }
  const sso = (
    required: NonNullable<Awaited<ReturnType<typeof decide>>['ssoRequired']>,
  ) =>
    ({
      status: 403,
      code: 'sso_required',
      message: ssoMessage(required, origin),
      details: { ...required },
    }) satisfies Refusal;
  const read = await decide(env, repo, effective, 'read');
  if (read.ssoRequired) return sso(read.ssoRequired);
  if (!read.allowed) return HIDDEN;
  if (action !== 'pull') {
    const decision = await decide(
      env,
      repo,
      effective,
      action === 'push' ? 'write' : 'admin',
    );
    if (decision.ssoRequired) return sso(decision.ssoRequired);
    if (!decision.allowed)
      return {
        status: 403,
        code: 'forbidden',
        message: 'insufficient permission',
        details: decision.deniedBy ? { denied_by: decision.deniedBy } : {},
      };
  }
  const restricted = restrictingDecision(await pathDecider(env, repo, effective), [
    'read',
    'history',
  ]);
  if (restricted)
    return {
      status: 403,
      code: 'path_restricted',
      // the rule's prefix is not named: that would reveal the hidden path
      message:
        'permission rules hide part of this repository from you and packages are built from the whole tree',
    };
  return null;
}
