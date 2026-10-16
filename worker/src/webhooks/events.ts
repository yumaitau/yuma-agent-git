import { z } from 'zod';
import type { Env } from '../env';
import type { RepoRecord } from '../db/client';
import { q } from '../db/client';
import type { AuditActor } from '../audit/record';

/**
 * Domain events for outbound webhooks (issue #75). A code path calls
 * `emitEvent` once its change has committed. When some active hook for the
 * repository subscribes to the event, a small message goes to the
 * `forge-events` queue; `queues/webhooks.ts` fans it out to a delivery per
 * hook and builds each payload there, so a push or merge pays only for one
 * indexed read here. Emitting never fails the caller.
 */
export const WEBHOOK_EVENTS = [
  'push',
  'ref',
  'pull_request',
  'pull_request_review',
  'issues',
  'ci_run',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export const forgeEventSchema = z.object({
  event: z.enum(WEBHOOK_EVENTS),
  action: z.string().nullable(),
  repo_id: z.string(),
  sender: z.object({
    kind: z.string(),
    id: z.string(),
    /** The person behind the actor (the user, or who a token acts for). */
    user_id: z.string().nullable(),
  }),
  /** Public origin of the forge for links; null outside a request. */
  origin: z.string().nullable(),
  at: z.number(),
  data: z.record(z.string(), z.unknown()),
});
export type ForgeEvent = z.infer<typeof forgeEventSchema>;

/**
 * Active hooks that may receive events for a repository: its own, its org's,
 * and those of apps installed on it. Binds the repo id, then the org id.
 */
export const HOOKS_FOR_REPO = `active = 1 AND (
  (scope = 'repo' AND owner_id = ?1)
  OR (scope = 'org' AND owner_id = ?2)
  OR (scope = 'app' AND owner_id IN (
    SELECT i.app_id FROM app_installations i
      JOIN app_installation_repos r ON r.installation_id = i.id
     WHERE r.repo_id = ?1)))`;

export function hookBinds(repo: Pick<RepoRecord, 'id' | 'owner_kind' | 'owner_id'>) {
  return [repo.id, repo.owner_kind === 'org' ? repo.owner_id : null];
}

export function parseEvents(text: string): string[] {
  return z.array(z.string()).parse(JSON.parse(text));
}

export async function emitEvent(
  env: Env,
  repo: Pick<RepoRecord, 'id' | 'owner_kind' | 'owner_id'>,
  input: {
    event: WebhookEvent;
    action: string | null;
    actor: AuditActor;
    origin?: string | null;
    data: Record<string, unknown>;
  },
): Promise<void> {
  try {
    if (!env.EVENTS_QUEUE) return;
    const hooks = await q<{ events: string }>(
      env,
      `SELECT events FROM webhooks WHERE ${HOOKS_FOR_REPO}`,
      hookBinds(repo),
    );
    if (!hooks.some((h) => parseEvents(h.events).includes(input.event))) return;
    const event: ForgeEvent = {
      event: input.event,
      action: input.action,
      repo_id: repo.id,
      sender: {
        kind: input.actor.kind,
        id: input.actor.id,
        user_id:
          input.actor.kind === 'user' ? input.actor.id : (input.actor.onBehalfOf ?? null),
      },
      origin: input.origin ?? null,
      at: Date.now(),
      data: input.data,
    };
    await env.EVENTS_QUEUE.send({ type: 'event', event });
  } catch (err) {
    console.error('webhooks: event not queued', input.event, err);
  }
}

/** A ref moved, was created or was deleted: a `push`, plus `ref` for create and delete. */
export async function emitRefUpdate(
  env: Env,
  repo: Pick<RepoRecord, 'id' | 'owner_kind' | 'owner_id'>,
  update: {
    name: string;
    from: string | null;
    to: string | null;
    /** New changesets, parents first. */
    commits: string[];
    forced: boolean;
  },
  actor: AuditActor,
  origin: string | null,
): Promise<void> {
  const ref = update.name.startsWith('refs/') ? update.name : `refs/heads/${update.name}`;
  await emitEvent(env, repo, {
    event: 'push',
    action: null,
    actor,
    origin,
    data: {
      ref: update.name,
      before: update.from,
      after: update.to,
      commits: update.commits,
      forced: update.forced,
    },
  });
  if ((update.from === null) === (update.to === null)) return;
  await emitEvent(env, repo, {
    event: 'ref',
    action: update.to === null ? 'deleted' : 'created',
    actor,
    origin,
    data: {
      ref,
      ref_type: ref.startsWith('refs/tags/')
        ? 'tag'
        : ref.startsWith('refs/agents/')
          ? 'agent'
          : 'branch',
      changeset: update.to ?? update.from,
    },
  });
}
