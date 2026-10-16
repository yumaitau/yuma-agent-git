import { z } from 'zod';
import type { Env } from '../env';
import { getRef, setRef } from '../db/repos';
import { isAncestorDag } from './ancestry';
import { ApiError } from './errors';
import { mutatePullLocked } from '../reviews/pulls';
import { settings, parsePolicy } from '../ci/config';
import { run, tx } from '../db/client';
import { getRepo } from '../db/repos';
import { TAG_PREFIX, validateRefName } from './refs';

const moveSchema = z.object({
  repo_id: z.string().min(1),
  name: z.string().min(1),
  from: z.string().min(1).nullable(),
  /** null deletes the ref. */
  to: z.string().min(1).nullable(),
  force: z.boolean().optional(),
  /** Skip the fast-forward check but keep the compare-and-swap (git push). */
  non_ff: z.boolean().optional(),
});

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
          await run(
            this.env,
            `INSERT INTO ci_settings (repo_id,version,config,updated_at) VALUES (?,1,?,?)
            ON CONFLICT(repo_id) DO UPDATE SET version = version + 1, config = excluded.config, updated_at = excluded.updated_at`,
            [input.repo_id, JSON.stringify(config), Date.now()],
          );
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

    // Fast-forward check runs OUTSIDE the gate: reachability over immutable
    // changesets never changes, and keeping the D1 walk out of
    // blockConcurrencyWhile keeps the gate short (it resets the DO on throw
    // or after 30s). Full-DAG reachability (git semantics: a merge descends
    // from both parents) — the first-parent skip list alone would reject
    // moving off a merge's second parent.
    let fastForward = true;
    if (
      !args.force &&
      !args.non_ff &&
      args.from !== null &&
      args.to !== null &&
      args.to !== args.from
    ) {
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
      if (to === null) {
        return fail(409, 'ref_stale', `ref ${name} does not exist`, {
          expected: from,
          actual: null,
        });
      }
      await setRef(this.env, repoId, name, to);
      return ok(null, to);
    }

    // Tags never move without force, as `git push` treats them.
    if (name.startsWith(TAG_PREFIX) && !force && to !== null && to !== current.head) {
      return fail(409, 'tag_exists', `tag ${name} already exists`, {
        expected: from,
        actual: current.head,
      });
    }

    const config = await settings(this.env, repoId);
    const repo = await getRepo(this.env, repoId);
    if (
      config?.policy.protect_default &&
      name === repo?.default_branch &&
      to !== current.head
    ) {
      return fail(
        403,
        'protected_branch',
        'Open a pull request to update the protected default branch.',
      );
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
      return ok(current.head, null);
    }
    await setRef(this.env, repoId, name, to);
    return ok(current.head, to);
  }
}

export { RefLockDO as RefLock };
