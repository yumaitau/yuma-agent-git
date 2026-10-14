import { z } from 'zod';
import type { Env } from '../env';
import { getRef, setRef } from '../db/repos';
import { isAncestorDag } from './ancestry';
import { ApiError } from './errors';
import { validateRefName } from './refs';

const moveSchema = z.object({
  repo_id: z.string().min(1),
  name: z.string().min(1),
  from: z.string().min(1).nullable(),
  to: z.string().min(1),
  force: z.boolean().optional(),
});

function ok(from: string | null, to: string): Response {
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

    // Fast-forward check runs OUTSIDE the gate: reachability over immutable
    // changesets never changes, and keeping the D1 walk out of
    // blockConcurrencyWhile keeps the gate short (it resets the DO on throw
    // or after 30s). Full-DAG reachability (git semantics: a merge descends
    // from both parents) — the first-parent skip list alone would reject
    // moving off a merge's second parent.
    let fastForward = true;
    if (!args.force && args.from !== null && args.to !== args.from) {
      try {
        fastForward = await isAncestorDag(this.env, args.repo_id, args.from, args.to);
      } catch (err) {
        console.error('ref-lock ancestry check failed', err);
        return fail(500, 'internal_error', 'ancestry check failed');
      }
    }

    // The CAS itself: blockConcurrencyWhile makes the read-check-write atomic
    // (a DO otherwise interleaves events at await points).
    return this.state.blockConcurrencyWhile(async () => {
      try {
        return await this.moveRef(args, fastForward);
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
  }

  private async moveRef(
    args: z.infer<typeof moveSchema>,
    fastForward: boolean,
  ): Promise<Response> {
    // Defense in depth: never let an unvalidated name reach idFromName callers
    // (or create a "zombie" ref) even if a future call site skips the check.
    validateRefName(args.name);
    const { repo_id: repoId, name, from, to, force } = args;

    const current = await getRef(this.env, repoId, name);

    if (current === null) {
      if (from !== null) {
        return fail(409, 'ref_stale', `ref ${name} does not exist`, {
          expected: from,
          actual: null,
        });
      }
      await setRef(this.env, repoId, name, to);
      return ok(null, to);
    }

    if (current.head !== from && !force) {
      return fail(409, 'ref_stale', `ref ${name} moved`, {
        expected: from,
        actual: current.head,
      });
    }

    if (!fastForward) {
      return fail(409, 'ref_not_fast_forward', `ref ${name} is not a fast-forward`, {
        from,
        to,
      });
    }

    await setRef(this.env, repoId, name, to);
    return ok(current.head, to);
  }
}

export { RefLockDO as RefLock };
