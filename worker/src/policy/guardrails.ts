import { z } from 'zod';
import type { Env } from '../env';
import type { RepoRecord } from '../db/client';
import { q1 } from '../db/client';
import type { Principal } from '../auth/principal';
import { appendAudit, actorOf } from '../audit/record';
import { ApiError } from '../core/errors';
import { getBlob, statBlob } from '../core/blobs';
import { sha256Hex } from '../core/hashing';
import { ulid } from '../core/ids';
import type { Change } from '../core/commit';
import defaultPack from '../../../policies/default.json';
import {
  evaluatePolicy,
  isManifest,
  npmDependencies,
  policySchema,
  type Dependency,
  type Policy,
  type PolicyInput,
  type PolicyMatch,
} from './engine';
import { pauseFor, pauseMessage } from './pause';
import { budgetStop } from '../usage/record';
import { emitEvent } from '../webhooks/events';

/**
 * Agent guardrails (issue #62): the kill switch, the org policy and human
 * approvals, in front of every agent action (`guardAgentAction`). Called from
 * pre-receive, the commit RPC, ref moves, merges, tags, pipeline runs and the
 * agent tools. Humans are not judged by policies.
 *
 * Fails closed: a policy that cannot be loaded or parsed denies agents.
 */

export const DEFAULT_POLICY: Policy = policySchema.parse(defaultPack);
/**
 * The agent a request acts as: an agent identity (#57). API tokens carry
 * `agent:run` by default and people push with them, so they count as people
 * here; built-in runs and MCP calls are judged through the agent tools.
 */
export function agentKey(principal: Principal | null): string | null {
  return principal?.kind === 'agent' ? `agent:${principal.agentId}` : null;
}

/** The policy in force for a repo: its org's newest version, else the default pack. */
export async function policyFor(
  env: Env,
  repo: RepoRecord,
): Promise<{ version: number; policy: Policy }> {
  if (repo.owner_kind !== 'org' || !repo.owner_id)
    return { version: 0, policy: DEFAULT_POLICY };
  const row = await q1<{ version: number; document: string }>(
    env,
    'SELECT version, document FROM agent_policies WHERE org_id = ? ORDER BY version DESC LIMIT 1',
    [repo.owner_id],
  );
  if (!row) return { version: 0, policy: DEFAULT_POLICY };
  return { version: row.version, policy: policySchema.parse(JSON.parse(row.document)) };
}

export interface Payload {
  /** Everything the approval binds to; hashed, never stored. */
  exact: unknown;
  /** What the approver sees: ids, paths, refs; never file contents or secrets. */
  summary: Record<string, unknown>;
}

export type Guard =
  | { outcome: 'allow'; approval?: string }
  | {
      outcome: 'deny' | 'require_approval';
      code:
        | 'agents_paused'
        | 'budget_exceeded'
        | 'policy_unavailable'
        | 'policy_denied'
        | 'approval_rejected'
        | 'approval_required';
      message: string;
      details: Record<string, unknown>;
    };

const approvalRowSchema = z.object({
  id: z.string(),
  decision: z.enum(['pending', 'approved', 'rejected']),
});

/**
 * Judge one agent action. Allow for people; otherwise the kill switch, a
 * hard usage budget for work queue claims (#61), then the policy; a held
 * action becomes (or finds) an approval row for its exact
 * payload, and that same payload passes once a human approves it.
 */
export async function guardAgentAction(
  env: Env,
  principal: Principal | null,
  repo: RepoRecord,
  input: PolicyInput,
  payload: Payload,
  /** Who the approval belongs to; tools pass their run's key. */
  key: string | null = agentKey(principal),
): Promise<Guard> {
  if (key === null || principal === null) return { outcome: 'allow' };
  const pause = await pauseFor(env, repo);
  if (pause) {
    return {
      outcome: 'deny',
      code: 'agents_paused',
      message: pauseMessage(pause),
      details: { paused_by: pause.paused_by_login ?? pause.paused_by },
    };
  }
  // usage budgets (#61): a hard limit stops the agent taking new work
  if (input.action === 'queue.claim') {
    const stop = await budgetStop(
      env,
      repo,
      principal.kind === 'agent' ? principal.agentId : null,
    );
    if (stop) {
      const { budget, used } = stop;
      return {
        outcome: 'deny',
        code: 'budget_exceeded',
        message: `the ${budget.scope} budget of ${budget.hard_limit} ${budget.metric} per ${budget.period} is used up (${used}); new claims wait for the next period`,
        details: {
          budget: {
            id: budget.id,
            scope: budget.scope,
            scope_id: budget.scope_id,
            metric: budget.metric,
            period: budget.period,
            hard_limit: budget.hard_limit,
            used,
          },
        },
      };
    }
  }
  let version: number;
  let matches: PolicyMatch[];
  let outcome: 'allow' | 'deny' | 'require_approval';
  try {
    const loaded = await policyFor(env, repo);
    version = loaded.version;
    ({ outcome, matches } = evaluatePolicy(loaded.policy, input));
  } catch (err) {
    console.error('guardrails: policy unavailable; denying the agent', err);
    return {
      outcome: 'deny',
      code: 'policy_unavailable',
      message: 'the agent policy could not be evaluated, so agent actions are refused',
      details: {},
    };
  }
  if (outcome === 'allow') return { outcome: 'allow' };
  const policy = { version, matches };
  const actor = actorOf(principal);
  if (outcome === 'deny') {
    await appendAudit(env, {
      action: 'policy.deny',
      repo,
      actor,
      target: { action: input.action, ...payload.summary, policy },
    });
    return {
      outcome: 'deny',
      code: 'policy_denied',
      message: matches.find((m) => m.effect === 'deny')!.message,
      details: { policy },
    };
  }

  const hash = await sha256Hex(
    new TextEncoder().encode(
      JSON.stringify({ action: input.action, repo: repo.id, payload: payload.exact }),
    ),
  );
  const find = (): Promise<z.infer<typeof approvalRowSchema> | null> =>
    q1(
      env,
      `SELECT id, decision FROM approvals
        WHERE repo_id = ? AND principal = ? AND action = ? AND payload_hash = ?`,
      [repo.id, key, input.action, hash],
    ).then((row) => (row ? approvalRowSchema.parse(row) : null));
  let approval = await find();
  if (approval === null) {
    const id = ulid();
    const now = Date.now();
    const created = await appendAudit(
      env,
      {
        action: 'policy.approval.request',
        repo,
        actor,
        target: {
          approval_id: id,
          action: input.action,
          payload_hash: hash,
          ...payload.summary,
          policy,
        },
      },
      {},
      [
        env.DB.prepare(
          `INSERT INTO approvals
             (id, repo_id, action, principal, on_behalf_of, payload_hash, payload, reasons, requested_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          id,
          repo.id,
          input.action,
          key,
          principal.userId,
          hash,
          JSON.stringify(payload.summary),
          JSON.stringify(matches),
          now,
        ),
      ],
    )
      .then(() => true)
      .catch(async (err: unknown) => {
        // a concurrent identical request inserted first: use its row
        if (!String(err).includes('UNIQUE constraint failed: approvals')) throw err;
        return false;
      });
    approval = (await find())!;
    // repo admins decide; notifications (#44) tell them
    if (created)
      await emitEvent(env, repo, {
        event: 'agent_approval',
        action: 'requested',
        actor,
        data: { approval: { id, action: input.action, summary: payload.summary } },
      });
  }
  if (approval.decision === 'approved')
    return { outcome: 'allow', approval: approval.id };
  const ref = { id: approval.id, payload_hash: hash, decision: approval.decision };
  if (approval.decision === 'rejected') {
    return {
      outcome: 'deny',
      code: 'approval_rejected',
      message: `a human rejected approval ${approval.id} for this exact change`,
      details: { approval: ref, policy },
    };
  }
  return {
    outcome: 'require_approval',
    code: 'approval_required',
    message: `${matches[0]!.message}; approval ${approval.id} waits for a human (payload ${hash.slice(0, 12)})`,
    details: { approval: ref, policy },
  };
}

/** `guardAgentAction` for HTTP routes: anything but allow is a 403 with the reason. */
export async function enforceAgentAction(
  ...args: Parameters<typeof guardAgentAction>
): Promise<void> {
  const guard = await guardAgentAction(...args);
  if (guard.outcome !== 'allow')
    throw new ApiError(403, guard.code, guard.message, guard.details);
}

/** Policy facts for commit-RPC changes: files, sizes and manifest dependencies. */
export async function changeFacts(
  env: Env,
  repoId: string,
  changes: readonly Change[],
): Promise<Pick<PolicyInput, 'files' | 'dependencies'>> {
  const files: NonNullable<PolicyInput['files']> = [];
  const dependencies: Dependency[] = [];
  for (const change of changes) {
    if (change.op === 'del') {
      files.push({ path: change.path, op: 'del' });
      continue;
    }
    let content: Uint8Array | null = null;
    let size: number | null = null;
    if ('content_b64' in change) {
      try {
        content = Uint8Array.from(atob(change.content_b64), (ch) => ch.charCodeAt(0));
      } catch {
        // commitChanges refuses it as invalid base64
      }
    } else if (isManifest(change.path)) {
      content = (await getBlob(env, repoId, change.blob_sha256))?.content ?? null;
    } else {
      size = await statBlob(env, repoId, change.blob_sha256);
    }
    size ??= content?.length ?? null;
    files.push({ path: change.path, op: change.op, ...(size === null ? {} : { size }) });
    if (content && isManifest(change.path))
      dependencies.push(...npmDependencies(new TextDecoder().decode(content)));
  }
  return { files, dependencies };
}
