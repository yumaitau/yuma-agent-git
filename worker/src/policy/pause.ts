import { z } from 'zod';
import type { Env } from '../env';
import type { RepoRecord } from '../db/client';
import { q1 } from '../db/client';
import { C, T } from '../db/schema';

/**
 * The agent kill switch (issue #62): a row in `agent_pauses` for an org, or
 * for the whole instance. Kept apart from the policy engine because token
 * resolution (auth/agents.ts) reads it too.
 */

/** `agent_pauses.scope_id` for the instance-wide switch. */
export const INSTANCE_SCOPE = '_instance';

const pauseRowSchema = z.object({
  scope_id: z.string(),
  paused_by: z.string(),
  paused_by_login: z.string().nullable(),
  reason: z.string(),
  paused_at: z.number(),
});
export type Pause = z.infer<typeof pauseRowSchema>;

/** The pause on `scopeId` (an org id or `_instance`), or null. */
export async function getPause(env: Env, scopeId: string): Promise<Pause | null> {
  const row = await q1(
    env,
    `SELECT p.*, u.${C.users.login} AS paused_by_login FROM agent_pauses p
       LEFT JOIN ${T.users} u ON u.${C.users.id} = p.paused_by
      WHERE p.scope_id = ?`,
    [scopeId],
  );
  return row ? pauseRowSchema.parse(row) : null;
}

/** The pause that stops agents on this repo: the instance's, else its org's. */
export async function pauseFor(env: Env, repo: RepoRecord): Promise<Pause | null> {
  const org = repo.owner_kind === 'org' && repo.owner_id ? repo.owner_id : null;
  return (await getPause(env, INSTANCE_SCOPE)) ?? (org ? await getPause(env, org) : null);
}

export function pauseMessage(pause: Pause): string {
  const scope = pause.scope_id === INSTANCE_SCOPE ? 'on this forge' : 'in this org';
  const by = pause.paused_by_login ?? pause.paused_by;
  return `agents are paused ${scope} by ${by}${pause.reason ? `: ${pause.reason}` : ''}`;
}
