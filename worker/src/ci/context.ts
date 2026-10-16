import { z } from 'zod';
import type { Env } from '../env';
import { getRef } from '../db/repos';
import type { Principal } from '../auth/principal';

/**
 * What started a run (issue #50), recorded on `ci_runs.context`. Secrets, OIDC
 * claims and environment rules read it; a run without it gets no credentials.
 */
export const runContextSchema = z.object({
  event: z.enum(['push', 'pull_request', 'workflow_dispatch']),
  /** `refs/heads/<b>`, `refs/tags/<t>`, `refs/pull/<n>/merge`, or null for a bare revision. */
  ref: z.string().max(512).nullable(),
  pull_id: z.number().int().nullable().default(null),
  /** A pull request whose head comes from another repository. */
  fork: z.boolean().default(false),
  /** Bearer tokens count as agents: a human-only gate fails closed. */
  actor_kind: z.enum(['human', 'agent']),
  /** Request origin, the issuer fallback when CI_OIDC_ISSUER is unset. */
  origin: z.string().url(),
  approval_id: z.string().nullable().default(null),
});
export type RunContext = z.infer<typeof runContextSchema>;

export function parseContext(raw: string | null | undefined): RunContext | null {
  if (!raw) return null;
  try {
    const parsed = runContextSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function actorKindOf(principal: Principal | null): 'human' | 'agent' {
  return principal?.kind === 'user' ? 'human' : 'agent';
}

/**
 * The full ref a run revision came from, when `rev` names a branch or tag
 * that still points at `csId`. Agent work refs and bare ids give null.
 */
export async function runRef(
  env: Env,
  repoId: string,
  rev: string,
  csId: string,
): Promise<string | null> {
  const name = rev.startsWith('ref:') ? rev.slice(4) : rev;
  if (/^[a-f0-9]{64}$/.test(name)) return null;
  for (const candidate of name.startsWith('refs/')
    ? [name]
    : [name, `refs/tags/${name}`]) {
    const ref = await getRef(env, repoId, candidate);
    if (!ref) continue;
    if (ref.head !== csId) return null;
    if (candidate.startsWith('refs/tags/')) return candidate;
    return candidate.startsWith('refs/') ? null : `refs/heads/${candidate}`;
  }
  return null;
}
