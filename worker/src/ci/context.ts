import type { Context } from 'hono';
import { z } from 'zod';
import type { Env } from '../env';
import { getRef } from '../db/repos';
import type { AppEnv, Principal } from '../auth/principal';

/**
 * What started a run (issue #50), recorded on `ci_runs.context`. Secrets, OIDC
 * claims and environment rules read it; a run without it gets no credentials.
 */
export const runContextSchema = z.object({
  event: z.enum(['push', 'pull_request', 'workflow_dispatch', 'schedule', 'merge_group']),
  /**
   * `refs/heads/<b>`, `refs/tags/<t>`, `refs/pull/<n>/merge`,
   * `refs/merge-queue/<b>/<group>` or null for a bare revision.
   */
  ref: z.string().max(512).nullable(),
  pull_id: z.number().int().nullable().default(null),
  /** A pull request whose head comes from another repository. */
  fork: z.boolean().default(false),
  /** Bearer tokens count as agents and schedules as system: a human-only gate fails closed. */
  actor_kind: z.enum(['human', 'agent', 'system']),
  /** Request origin, the issuer fallback when CI_OIDC_ISSUER is unset; null for schedules. */
  origin: z.string().url().nullable(),
  approval_id: z.string().nullable().default(null),
  /** The agent identity (#57) that started the run, for guardrails (#62). */
  agent_id: z.string().nullable().optional(),
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

export function agentIdOf(principal: Principal | null): string | null {
  return principal?.kind === 'agent' ? principal.agentId : null;
}

/** Who started a run or pipeline, from the request that did. */
export interface Trigger {
  actor: string;
  actor_kind: RunContext['actor_kind'];
  origin: string | null;
  agent_id?: string | null;
}

export function triggerOf(c: Context<AppEnv>): Trigger {
  const principal = c.get('principal');
  return {
    actor: principal!.userId,
    actor_kind: actorKindOf(principal),
    origin: new URL(c.req.url).origin,
    agent_id: agentIdOf(principal),
  };
}

/** A pull request whose head comes from a fork (#36). */
export function forkPull(pull: {
  repo_id: string;
  head_repo_id?: string | null;
}): boolean {
  return (pull.head_repo_id ?? pull.repo_id) !== pull.repo_id;
}

/** A fresh run context; `ref` is a full ref name or null. */
export function contextFor(
  trigger: Trigger,
  event: RunContext['event'],
  ref: string | null,
  pullId: number | null = null,
  fork = false,
): RunContext {
  return {
    event,
    ref,
    pull_id: pullId,
    fork,
    actor_kind: trigger.actor_kind,
    origin: trigger.origin,
    approval_id: null,
    agent_id: trigger.agent_id ?? null,
  };
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
