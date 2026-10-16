import { z } from 'zod';
import type { Env } from '../env';
import { getRef, setRef } from '../db/repos';
import { isAncestorDag } from './ancestry';
import { ApiError } from './errors';
import { mutatePullLocked } from '../reviews/pulls';
import { parsePolicy } from '../ci/config';
import { tx, type RepoRecord } from '../db/client';
import { getRepo } from '../db/repos';
import { TAG_PREFIX, validateRefName } from './refs';
import { actorOf } from '../audit/record';
import {
  actorFor,
  applies,
  ciPolicyRulesetStatement,
  violationError,
  evaluate,
  principalSchema,
  recordOutcome,
  rulesetsFor,
  type Actor,
  type Outcome,
  type Ruleset,
} from '../policy/rulesets';

const moveSchema = z.object({
  repo_id: z.string().min(1),
  name: z.string().min(1),
  from: z.string().min(1).nullable(),
  /** null deletes the ref. */
  to: z.string().min(1).nullable(),
  force: z.boolean().optional(),
  /** Skip the fast-forward check but keep the compare-and-swap (git push). */
  non_ff: z.boolean().optional(),
  /** Who moves the ref, for rulesets (null: the system, e.g. imports). */
  actor: principalSchema.nullable().optional(),
  via: z.string().max(32).optional(),
  /** Only for putting back a move the same push made (atomic rollback). */
  skip_rulesets: z.boolean().optional(),
});

interface Policy {
  repo: RepoRecord | null;
  rulesets: Ruleset[];
  actor: Actor;
}

function ok(from: string | null, to: string | null): Response {
  return new Response(JSON.stringify({ ok: true, from, to }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function fail(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  return new Response(JSON.stringify({ error: { code, message, ...extra } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Compare-and-swap lock for one `(repo_id, ref_name)` pair (architecture §1.4).
 *
 * The DO holds **no state**: all ref state lives in D1 rows, so DO eviction is
 * always safe. The DO's only job is to serialize moves — one instance per
 * (repo, ref) via `idFromName`, so parallel land attempts queue instead of
 * racing.
 */
export class RefLockDO {
  private readonly state: DurableObjectState;
  private readonly env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/ci-config') {
      const input = (await request.json()) as { repo_id: string; config: unknown };
      return this.state.blockConcurrencyWhile(async () => {
        try {
          const config = parsePolicy(input.config);
          const now = Date.now();
          // the protection fields live on as the CI policy ruleset (#41)
          await this.env.DB.batch([
            this.env.DB.prepare(
              `INSERT INTO ci_settings (repo_id,version,config,updated_at) VALUES (?,1,?,?)
            ON CONFLICT(repo_id) DO UPDATE SET version = version + 1, config = excluded.config, updated_at = excluded.updated_at`,
            ).bind(input.repo_id, JSON.stringify(config), now),
            ciPolicyRulesetStatement(this.env, input.repo_id, config, now),
          ]);
          return Response.json({ ok: true });
        } catch (err) {
          if (err instanceof ApiError) return fail(err.status, err.code, err.message);
          return fail(500, 'internal_error', 'Configuration update failed');
        }
      });
    }
    if (request.method === 'POST' && url.pathname.startsWith('/pull/')) {
      const input: unknown = await request.json();
      return this.state.blockConcurrencyWhile(async () => {
        try {
          return Response.json(
            await mutatePullLocked(this.env, url.pathname.slice(6), input),
          );
        } catch (err) {
          if (err instanceof ApiError) return fail(err.status, err.code, err.message);
          return fail(500, 'internal_error', 'Pull request operation failed');
        }
      });
    }
    if (request.method !== 'POST' || url.pathname !== '/move') {
      return fail(404, 'not_found', 'unknown ref-lock operation');
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return fail(400, 'invalid_json', 'malformed JSON body');
    }
    const parsed = moveSchema.safeParse(body);
    if (!parsed.success) {
      return fail(400, 'invalid_request', 'invalid move request', {
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }
    const args = parsed.data;

    // Rulesets, actor facts and the fast-forward check all read OUTSIDE the
    // gate: reachability over immutable changesets never changes, rulesets
    // are configuration, and keeping D1 walks out of blockConcurrencyWhile
    // keeps the gate short (it resets the DO on throw or after 30s).
    let policy: Policy;
    try {
      const repo = await getRepo(this.env, args.repo_id);
      const rulesets =
        repo && !args.skip_rulesets ? await rulesetsFor(this.env, repo) : [];
      const actor = repo
        ? await actorFor(this.env, repo, args.actor ?? null, rulesets)
        : { principal: null, role: null, teams: [] };
      policy = { repo, rulesets, actor };
    } catch (err) {
      console.error('ref-lock ruleset load failed', err);
      return fail(500, 'internal_error', 'ruleset load failed');
    }

    // `fastForward`: `to` descends from `ffBase`. Full-DAG reachability (git
    // semantics: a merge descends from both parents) — the first-parent skip
    // list alone would reject moving off a merge's second parent. A forced
    // move skips the check unless a non_fast_forward rule needs the answer;
    // then it is taken against the head as read here.
    let fastForward = true;
    let ffBase = args.from;
    try {
      if (args.non_ff) {
        fastForward = false;
      } else if (args.force) {
        const repo = policy.repo;
        const needed =
          repo !== null &&
          policy.rulesets.some(
            (r) =>
              applies(r, repo, args.name) &&
              r.rules.some((rule) => rule.type === 'non_fast_forward'),
          );
        if (needed && args.to !== null) {
          ffBase = (await getRef(this.env, args.repo_id, args.name))?.head ?? null;
          if (ffBase !== null && ffBase !== args.to)
            fastForward = await isAncestorDag(this.env, args.repo_id, ffBase, args.to);
        }
      } else if (args.from !== null && args.to !== null && args.to !== args.from) {
        fastForward = await isAncestorDag(this.env, args.repo_id, args.from, args.to);
      }
    } catch (err) {
      console.error('ref-lock ancestry check failed', err);
      return fail(500, 'internal_error', 'ancestry check failed');
    }

    // The CAS itself: blockConcurrencyWhile makes the read-check-write atomic
    // (a DO otherwise interleaves events at await points).
    let outcome: Outcome | null = null;
    const response = await this.state.blockConcurrencyWhile(async () => {
      try {
        const moved = await this.moveRef(args, fastForward, ffBase, policy);
        if (moved instanceof Response) return moved;
        outcome = moved.outcome;
        return moved.response;
      } catch (err) {
        // Never let an exception escape the gate: it would terminate and
        // reset the whole DO, failing queued moves for this ref.
        if (err instanceof ApiError) {
          return fail(err.status, err.code, err.message, err.details);
        }
        console.error('ref-lock move failed', err);
        return fail(500, 'internal_error', 'ref move failed');
      }
    });
    // recorded after the move, outside the gate: a failed log never fails it
    if (outcome !== null && policy.repo !== null) {
      try {
        await recordOutcome(this.env, outcome, {
          repo: policy.repo,
          actor: args.actor ? actorOf(args.actor) : { kind: 'system', id: 'system' },
          ref: args.name,
          via: args.via ?? 'system',
        });
      } catch (err) {
        console.error('ref-lock ruleset outcome not recorded', err);
      }
    }
    return response;
  }

  private async moveRef(
    args: z.infer<typeof moveSchema>,
    fastForward: boolean,
    ffBase: string | null,
    policy: Policy,
  ): Promise<Response | { response: Response; outcome: Outcome }> {
    // Defense in depth: never let an unvalidated name reach idFromName callers
    // (or create a "zombie" ref) even if a future call site skips the check.
    validateRefName(args.name);
    const { repo_id: repoId, name, from, to, force } = args;

    const current = await getRef(this.env, repoId, name);

    if (current === null) {
      if (from !== null || to === null) {
        return fail(409, 'ref_stale', `ref ${name} does not exist`, {
          expected: from,
          actual: null,
        });
      }
    } else {
      // Tags never move without force, as `git push` treats them.
      if (name.startsWith(TAG_PREFIX) && !force && to !== null && to !== current.head) {
        return fail(409, 'tag_exists', `tag ${name} already exists`, {
          expected: from,
          actual: current.head,
        });
      }
      if (current.head !== from && !force) {
        return fail(409, 'ref_stale', `ref ${name} moved`, {
          expected: from,
          actual: current.head,
        });
      }
      if (!fastForward && !force && !args.non_ff) {
        return fail(409, 'ref_not_fast_forward', `ref ${name} is not a fast-forward`, {
          from,
          to,
        });
      }
    }

    // Rulesets (#41): the one evaluator for every direct move. Merges go
    // through mergePullLocked instead, so a direct move is never a merge.
    // Re-pointing a ref at its own head changes nothing, so no rule applies.
    const outcome = evaluate(current?.head === to ? [] : policy.rulesets, {
      repo: policy.repo ?? { slug: '', default_branch: '' },
      actor: policy.actor,
      ref: {
        name,
        kind: to === null ? 'delete' : current === null ? 'create' : 'update',
        fastForward: fastForward && current?.head === ffBase,
      },
    });
    if (!outcome.allowed) {
      const err = violationError(outcome.blocking);
      return fail(err.status, err.code, err.message, err.details);
    }

    if (current === null) {
      await setRef(this.env, repoId, name, to as string);
      return { response: ok(null, to), outcome };
    }
    if (to === null) {
      // a deleted tag takes its annotation with it
      await tx(this.env, (t) => {
        t.q('DELETE FROM refs WHERE repo_id = ? AND name = ?', [repoId, name]);
        if (name.startsWith(TAG_PREFIX)) {
          t.q('DELETE FROM tags WHERE repo_id = ? AND name = ?', [
            repoId,
            name.slice(TAG_PREFIX.length),
          ]);
        }
      });
      return { response: ok(current.head, null), outcome };
    }
    await setRef(this.env, repoId, name, to);
    return { response: ok(current.head, to), outcome };
  }
}

export { RefLockDO as RefLock };
