import { z } from 'zod';
import type { Env } from '../env';
import type { RepoRecord } from '../db/client';
import { q } from '../db/client';
import { ulid } from '../core/ids';
import type { AuditActor } from '../audit/record';

/**
 * Domain events for outbound webhooks (issue #75). A code path calls
 * `emitEvent` once its change has committed. When some active hook for the
 * repository subscribes to the event, a small message goes to the
 * `forge-events` queue; `queues/webhooks.ts` fans it out to a delivery per
 * hook and builds each payload there, so a push or merge pays only for one
 * indexed read here. Events people are notified about (#44) also go to the
 * `notifications` queue (queues/notify.ts). Emitting never fails the caller.
 */
export const WEBHOOK_EVENTS = [
  'push',
  'ref',
  'pull_request',
  'pull_request_review',
  'pull_request_review_thread',
  'issues',
  // notifications (#44): issue comments
  'issue_comment',
  'ci_run',
  'work_item',
  'secret_scanning_alert',
  // dependency and code scanning alerts (#67): created, fixed, reopened, dismissed
  'dependency_alert',
  'code_scanning_alert',
  'merge_group',
  'release',
  // package registry (#53): published, tagged, deleted
  'package',
  // forks (#36): yag-format hooks only for now
  'fork',
  // agent review loops (#60): requested, completed, escalated
  'agent_review',
  // usage budgets (#61): soft_limit, hard_limit
  'usage_budget',
  // notifications (#44): deployments and agent actions waiting for a person
  'environment_approval',
  'agent_approval',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export const forgeEventSchema = z.object({
  /** Fixes the delivery ids, so a redelivered queue message sends nothing twice; absent on messages queued before it. */
  id: z.string().optional(),
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

/** App permissions that read a repository; every event needs one (#75). */
export const APP_READ_SCOPES = ['contents:read', 'contents:write'];

/**
 * Active hooks that may receive events for a repository: its own, its org's,
 * and those of apps installed on it that could read it with an installation
 * token (an active installer and a read permission). Binds the repo id, then
 * the org id.
 */
export const HOOKS_FOR_REPO = `active = 1 AND (
  (scope = 'repo' AND owner_id = ?1)
  OR (scope = 'org' AND owner_id = ?2)
  OR (scope = 'app' AND owner_id IN (
    SELECT i.app_id FROM app_installations i
      JOIN app_installation_repos r ON r.installation_id = i.id
      JOIN users u ON u.id = i.installed_by AND u.active = 1
      JOIN apps a ON a.id = i.app_id
     WHERE r.repo_id = ?1 AND EXISTS (
       SELECT 1 FROM json_each(a.permissions) p
        WHERE p.value IN (${APP_READ_SCOPES.map((s) => `'${s}'`).join(', ')})))))`;

export function hookBinds(repo: Pick<RepoRecord, 'id' | 'owner_kind' | 'owner_id'>) {
  return [repo.id, repo.owner_kind === 'org' ? repo.owner_id : null];
}

export function parseEvents(text: string): string[] {
  return z.array(z.string()).parse(JSON.parse(text));
}

/** Events notifications may come from; pushes, refs, releases and packages never do. */
const NOTIFY_EVENTS = new Set<WebhookEvent>([
  'pull_request',
  'pull_request_review',
  'pull_request_review_thread',
  'issues',
  'issue_comment',
  'work_item',
  'secret_scanning_alert',
  'environment_approval',
  'agent_approval',
  'agent_review',
  'dependency_alert',
  'code_scanning_alert',
  'usage_budget',
]);

function notifies(event: WebhookEvent, action: string | null): boolean {
  return NOTIFY_EVENTS.has(event) || (event === 'ci_run' && action === 'completed');
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
    const event: ForgeEvent = {
      id: ulid(),
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
    // notifications (#44) take the same event, with the same id, on their own queue
    if (env.NOTIFY_QUEUE && notifies(input.event, input.action))
      await env.NOTIFY_QUEUE.send(event).catch((err: unknown) =>
        console.error('notifications: event not queued', input.event, err),
      );
    if (!env.EVENTS_QUEUE) return;
    const hooks = await q<{ events: string }>(
      env,
      `SELECT events FROM webhooks WHERE ${HOOKS_FOR_REPO}`,
      hookBinds(repo),
    );
    if (!hooks.some((h) => parseEvents(h.events).includes(input.event))) return;
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
