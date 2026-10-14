import { z } from 'zod';
import type { Env } from '../env';
import { getRef, setRef } from '../db/repos';
import { isAncestorProvisional } from './ancestry';

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
    // DOs interleave events at await points; blockConcurrencyWhile makes the
    // read-check-write below atomic (a real CAS, not a hopeful one).
    return this.state.blockConcurrencyWhile(() => this.moveRef(parsed.data));
  }

  private async moveRef(args: z.infer<typeof moveSchema>): Promise<Response> {
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

    if (!force && from !== null && to !== from) {
      // Fast-forward only: `to` must descend from `from`.
      // PROVISIONAL ancestry (issue #8 replaces with skip-list isAncestor).
      const fastForward = await isAncestorProvisional(this.env, repoId, from, to);
      if (!fastForward) {
        return fail(409, 'ref_not_fast_forward', `ref ${name} is not a fast-forward`, {
          from,
          to,
        });
      }
    }

    await setRef(this.env, repoId, name, to);
    return ok(current.head, to);
  }
}

export { RefLockDO as RefLock };
