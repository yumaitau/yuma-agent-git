import type { Context } from 'hono';
import type { Env } from '../env';
import type { Principal } from '../auth/principal';
import { requestIdOf } from '../middleware/observe';
import { timePhase } from '../observability/phase';

/**
 * Audit log (issue #65): one append-only event per security-relevant action.
 * Events chain per org: `hash = sha256(canonical fields + prev_hash)`, so an
 * edited or removed row breaks `yag audit verify` (cli/src/audit.ts holds the
 * same field order). Targets carry ids and settings, never secret values,
 * tokens or file contents.
 */
export type AuditAction =
  | 'auth.login'
  | 'auth.logout'
  | 'token.create'
  | 'token.revoke'
  | 'cache_token.create'
  | 'repo.create'
  | 'repo.initialize'
  | 'repo.connect'
  | 'repo.import'
  | 'repo.export'
  | 'member.set'
  | 'member.remove'
  | 'path_rule.create'
  | 'path_rule.delete'
  | 'ref.move'
  | 'pull.create'
  | 'pull.update'
  | 'pull.review'
  | 'pull.merge'
  | 'ci.settings.update'
  | 'ci.run.create'
  | 'ci.run.cancel'
  | 'agent.task.create'
  | 'agent.task.cancel'
  | 'agent.superfan.start'
  | 'agent.superfan.stop'
  | 'repo.settings.update'
  | 'tag.create'
  | 'org.create'
  | 'org.update'
  | 'org.member.set'
  | 'org.member.remove'
  | 'team.create'
  | 'team.member.set'
  | 'team.member.remove'
  | 'team.repo.set'
  | 'team.repo.remove'
  | 'auth.mfa'
  | 'identity.link'
  | 'mfa.passkey.add'
  | 'mfa.passkey.remove'
  | 'mfa.totp.enroll'
  | 'mfa.totp.remove'
  | 'scim.user.create'
  | 'scim.user.update'
  | 'scim.user.deprovision'
  | 'scim_token.create'
  | 'scim_token.revoke';

export interface AuditActor {
  kind: 'user' | 'token' | 'agent' | 'system' | 'anonymous';
  id: string;
  onBehalfOf?: string | null;
}

export interface AuditInput {
  action: AuditAction;
  repo?: { id: string; slug: string } | null;
  target?: Record<string, unknown>;
  /** Defaults to the request principal (sign-in passes the new user). */
  actor?: AuditActor;
  /** Chain to append to; defaults to the repo owner, else `_instance`. */
  orgId?: string;
}

export const INSTANCE_ORG = '_instance';

const HASH_FIELDS = [
  'org_id',
  'repo_id',
  'actor_kind',
  'actor_id',
  'on_behalf_of',
  'action',
  'target',
  'ip',
  'user_agent',
  'request_id',
  'at',
  'prev_hash',
] as const;

type AuditRow = Record<(typeof HASH_FIELDS)[number], string | number | null>;

async function hashRow(row: AuditRow): Promise<string> {
  const canonical = JSON.stringify(HASH_FIELDS.map((field) => row[field]));
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonical),
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function actorOf(principal: Principal | null): AuditActor {
  if (principal === null) return { kind: 'anonymous', id: 'anonymous' };
  if (principal.kind === 'user') return { kind: 'user', id: principal.userId };
  return { kind: 'token', id: principal.tokenId, onBehalfOf: principal.userId };
}

export interface AuditRequestMeta {
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

/** An event whose append failed after its change committed (audit-stream queue). */
export interface QueuedAppend {
  input: AuditInput & { actor: AuditActor };
  meta: AuditRequestMeta;
}

/**
 * Append from outside a request (agent tools, queues). `change` statements run
 * in the same D1 batch so the change and its event land or fail together.
 * Without `change` the action already happened (a ref moved by its Durable
 * Object, say), so a failed append must not fail the caller and report a done
 * change as failed: the event goes to the audit queue, whose consumer retries.
 */
export async function appendAudit(
  env: Env,
  input: AuditInput & { actor: AuditActor },
  meta: AuditRequestMeta = {},
  change: D1PreparedStatement[] = [],
): Promise<void> {
  try {
    await appendNow(env, input, meta, change);
  } catch (err) {
    if (change.length > 0) throw err;
    console.error('audit: append failed after its change; queued for retry', err);
    const queued: QueuedAppend = { input, meta };
    try {
      if (!env.AUDIT_QUEUE) throw new Error('AUDIT_QUEUE is not bound');
      await env.AUDIT_QUEUE.send({ append: queued });
    } catch (sendErr) {
      console.error('audit: event lost', JSON.stringify(queued), sendErr);
    }
  }
}

/** The queue consumer's retry of a `QueuedAppend`; throws so the queue retries. */
export function appendQueued(env: Env, queued: QueuedAppend): Promise<void> {
  return appendNow(env, queued.input, queued.meta, []);
}

async function appendNow(
  env: Env,
  input: AuditInput & { actor: AuditActor },
  meta: AuditRequestMeta,
  change: D1PreparedStatement[],
): Promise<void> {
  const base = {
    org_id: input.orgId ?? input.repo?.slug.split('/')[0] ?? INSTANCE_ORG,
    repo_id: input.repo?.id ?? null,
    actor_kind: input.actor.kind,
    actor_id: input.actor.id,
    on_behalf_of: input.actor.onBehalfOf ?? null,
    action: input.action,
    target: JSON.stringify(input.target ?? {}),
    ip: meta.ip ?? null,
    user_agent: meta.userAgent?.slice(0, 256) ?? null,
    request_id: meta.requestId ?? null,
  };
  // UNIQUE(org_id, prev_hash) rejects a concurrent append; re-read the head
  for (let attempt = 1; attempt <= 10; attempt++) {
    const head = await timePhase('d1', () =>
      env.DB.prepare(
        'SELECT hash FROM audit_events WHERE org_id = ? ORDER BY id DESC LIMIT 1',
      )
        .bind(base.org_id)
        .first<{ hash: string }>(),
    );
    const row: AuditRow = { ...base, at: Date.now(), prev_hash: head?.hash ?? '' };
    const insert = env.DB.prepare(
      `INSERT INTO audit_events (${HASH_FIELDS.join(', ')}, hash)
       VALUES (${HASH_FIELDS.map(() => '?').join(', ')}, ?)`,
    ).bind(...HASH_FIELDS.map((field) => row[field]), await hashRow(row));
    try {
      await timePhase('d1', () => env.DB.batch([...change, insert]));
    } catch (err) {
      if (String(err).includes('UNIQUE constraint failed: audit_events')) {
        // jittered backoff so racing writers stop colliding on the same head
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 10 * attempt));
        continue;
      }
      throw err;
    }
    if (env.AUDIT_STREAM_URL && env.AUDIT_QUEUE) {
      // best effort: the cron sweep kicks the stream again if this send fails
      await env.AUDIT_QUEUE.send({ kick: true }).catch(() => undefined);
    }
    return;
  }
  throw new Error('audit append contention: retries exhausted');
}

/** Record an event for the current request (actor, IP, user agent, request id). */
export function recordAudit(
  c: Context,
  input: AuditInput,
  change: D1PreparedStatement[] = [],
): Promise<void> {
  const principal = (c.get('principal') as Principal | null | undefined) ?? null;
  return appendAudit(
    c.env as Env,
    { ...input, actor: input.actor ?? actorOf(principal) },
    {
      ip: c.req.header('cf-connecting-ip') ?? null,
      userAgent: c.req.header('user-agent') ?? null,
      requestId: requestIdOf(c.req.raw),
    },
    change,
  );
}
