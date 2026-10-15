import { Hono, type Context } from 'hono';
import { can, listPathRules } from '../auth/rbac';
import { z } from 'zod';
import type { AppEnv } from '../auth/principal';
import { loadAdminRepo, loadReadableRepo, loadWritableRepo } from '../auth/guards';
import { apiError, errorResponse, readJsonBody } from './errors';
import { q, q1, run } from '../db/client';
import { getRef } from '../db/repos';
import { getChangeset } from '../core/changesets';
import { resolveRevision } from '../core/read';
import { getBlob } from '../core/blobs';
import { resolvePath } from '../core/trees';
import { ApiError } from '../core/errors';
import { getPull, pullGate, type Pull, type Review } from '../reviews/pulls';
import {
  monthlyBudget,
  parsePolicy,
  PRESETS,
  reservation,
  settings,
  type CiRun,
} from '../ci/config';
import { enqueueRun } from '../ci/runs';

export const collaborationRoutes = new Hono<AppEnv>();
const base = '/repos/:repo{.+}';
for (const path of [`${base}/pulls`, `${base}/pulls/*`, `${base}/ci`, `${base}/ci/*`]) {
  collaborationRoutes.use(path, async (c, next) => {
    await next();
    c.header('cache-control', 'private, no-store');
  });
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new ApiError(
      400,
      'invalid_request',
      parsed.error.issues.map((i) => i.message).join('; '),
    );
  return parsed.data;
}
const createPull = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().max(20000).default(''),
  head_cs: z.string().regex(/^[a-f0-9]{64}$/),
  draft: z.boolean().default(false),
});
collaborationRoutes.get(`${base}/pulls`, async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'read', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const before = Number(c.req.query('before') ?? Number.MAX_SAFE_INTEGER);
    if (!Number.isSafeInteger(before) || before < 1)
      throw new ApiError(400, 'invalid_cursor', 'Invalid pull request cursor');
    const rows = await q<Pull>(
      c.env,
      'SELECT * FROM pull_requests WHERE repo_id = ? AND id < ? ORDER BY id DESC LIMIT 51',
      [loaded.repo.id, before],
    );
    return c.json({
      pulls: rows.slice(0, 50),
      next_cursor: rows.length > 50 ? rows[49].id : null,
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});
collaborationRoutes.post(`${base}/pulls`, async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'write', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const body = parse(createPull, await readJsonBody(c));
    const ref = await getRef(c.env, loaded.repo.id, loaded.repo.default_branch);
    if (!ref || ref.head === body.head_cs)
      throw new ApiError(
        409,
        'no_changes',
        'Choose a proposed revision different from the default branch.',
      );
    if (!(await getChangeset(c.env, loaded.repo.id, body.head_cs)))
      throw new ApiError(404, 'changeset_not_found', 'Proposed revision not found');
    const result = await c.env.DB.prepare(
      `INSERT INTO pull_requests (repo_id,title,body,author_id,base_ref,base_cs,head_cs,state,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
      .bind(
        loaded.repo.id,
        body.title,
        body.body,
        c.get('principal')!.userId,
        loaded.repo.default_branch,
        ref.head,
        body.head_cs,
        body.draft ? 'draft' : 'open',
        Date.now(),
        Date.now(),
      )
      .run();
    const pull = await getPull(c.env, loaded.repo.id, result.meta.last_row_id);
    const ci = await autoCheck(c.env, pull, c.get('principal')!.userId);
    return c.json({ pull, ci }, 201);
  } catch (err) {
    return errorResponse(c, err);
  }
});
collaborationRoutes.get(`${base}/pulls/:id`, async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'read', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const pull = await getPull(c.env, loaded.repo.id, Number(c.req.param('id')));
    const reviews = await q<Review>(
      c.env,
      'SELECT * FROM pull_reviews WHERE pull_id = ? ORDER BY id DESC LIMIT 200',
      [pull.id],
    );
    return c.json({
      pull,
      reviews: reviews.reverse(),
      gate: await pullGate(c.env, pull),
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});
// Serialize reviews, revisions and merges with the same target ref DO.
for (const action of ['update', 'review', 'merge'] as const) {
  collaborationRoutes.post(`${base}/pulls/:id/${action}`, async (c) => {
    try {
      const loaded = await loadWholeRepo(c, 'write', c.req.param('repo'));
      if (!loaded.ok) return loaded.response;
      const pull = await getPull(c.env, loaded.repo.id, Number(c.req.param('id')));
      const body = await readJsonBody(c);
      const stub = c.env.REF_LOCK.get(
        c.env.REF_LOCK.idFromName(`${loaded.repo.id}:${pull.base_ref}`),
      );
      const response = await stub.fetch(`https://ref-lock/pull/${action}`, {
        method: 'POST',
        body: JSON.stringify({
          repo_id: loaded.repo.id,
          id: pull.id,
          actor: c.get('principal')!.userId,
          body,
        }),
      });
      if (response.ok && action === 'update') {
        const data = (await response.json()) as { pull: Pull };
        const ci =
          data.pull.head_cs !== pull.head_cs ||
          (pull.state === 'draft' && data.pull.state === 'open')
            ? await autoCheck(c.env, data.pull, c.get('principal')!.userId)
            : { status: 'unchanged' };
        return c.json({ ...data, ci });
      }
      return new Response(response.body, response);
    } catch (err) {
      return errorResponse(c, err);
    }
  });
}

collaborationRoutes.get(`${base}/ci`, async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'read', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const config = await settings(c.env, loaded.repo.id);
    const runs = await q<CiRun>(
      c.env,
      'SELECT * FROM ci_runs WHERE repo_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 30',
      [loaded.repo.id],
    );
    // Repository callers see their own reservation total; global budgets are operator-owned.
    const usage = await q1<{ reserved: number }>(
      c.env,
      'SELECT COALESCE(SUM(reserved_micros),0) AS reserved FROM ci_runs WHERE repo_id = ? AND month = ?',
      [loaded.repo.id, new Date().toISOString().slice(0, 7)],
    );
    return c.json({
      config: config?.policy ?? null,
      version: config?.version ?? null,
      runs,
      enabled: c.env.CI_ENABLED === 'true',
      can_admin: await can(c.env, loaded.repo, c.get('principal'), 'admin'),
      can_write: await can(c.env, loaded.repo, c.get('principal'), 'write'),
      monthly_budget_usd: monthlyBudget(c.env) / 1e6,
      reserved_usd: (usage?.reserved ?? 0) / 1e6,
      max_run_usd: config ? reservation(config.policy) / 1e6 : null,
      registry: c.env.CI_REGISTRY_HOST ?? null,
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});
collaborationRoutes.get(`${base}/ci/detect`, async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'admin', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const ref = await getRef(c.env, loaded.repo.id, loaded.repo.default_branch);
    if (!ref) return c.json({ empty: true, preset: 'node', commands: PRESETS.node });
    const cs = await getChangeset(c.env, loaded.repo.id, ref.head);
    const node = cs?.root_tree
      ? await resolvePath(c.env, loaded.repo.id, cs.root_tree, ['package.json'])
      : null;
    const docker = cs?.root_tree
      ? await resolvePath(c.env, loaded.repo.id, cs.root_tree, ['Dockerfile'])
      : null;
    let commands = [...PRESETS.node];
    if (node?.kind === 'blob') {
      const blob = await getBlob(c.env, loaded.repo.id, node.hash);
      if (blob && blob.content.length < 64 * 1024) {
        try {
          const pkg = JSON.parse(new TextDecoder().decode(blob.content)) as {
            workspaces?: unknown;
          };
          if (pkg.workspaces)
            commands = [
              'npm ci',
              'npm run lint --workspaces --if-present',
              'npm run typecheck --workspaces --if-present',
              'npm run build --workspaces --if-present',
              'npm test --workspaces --if-present',
            ];
        } catch {
          /* Preserve explicit defaults for malformed manifests. */
        }
      }
    }
    return c.json({
      empty: false,
      preset: node ? 'node' : docker ? 'docker' : 'custom',
      commands: node
        ? commands
        : docker
          ? PRESETS.docker
          : ['echo "Replace this with your build command" >&2; exit 1'],
      dockerfile: Boolean(docker),
      head_cs: ref.head,
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});
collaborationRoutes.put(`${base}/ci`, async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'admin', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const config = parsePolicy(await readJsonBody(c));
    const lock = c.env.REF_LOCK.get(
      c.env.REF_LOCK.idFromName(`${loaded.repo.id}:${loaded.repo.default_branch}`),
    );
    const saved = await lock.fetch('https://ref-lock/ci-config', {
      method: 'POST',
      body: JSON.stringify({ repo_id: loaded.repo.id, config }),
    });
    if (!saved.ok) return new Response(saved.body, saved);
    return c.json({ config, max_run_usd: reservation(config) / 1e6 });
  } catch (err) {
    return errorResponse(c, err);
  }
});
collaborationRoutes.post(`${base}/ci/runs`, async (c) => {
  try {
    const input = parse(
      z.object({
        head: z.string().min(1).optional(),
        publish: z.boolean().default(false),
      }),
      await readJsonBody(c),
    );
    const loaded = await loadWholeRepo(
      c,
      input.publish ? 'admin' : 'write',
      c.req.param('repo'),
    );
    if (!loaded.ok) return loaded.response;
    const cs = await resolveRevision(
      c.env,
      loaded.repo.id,
      input.head ?? `ref:${loaded.repo.default_branch}`,
    );
    return c.json(
      {
        run: await enqueueRun(
          c.env,
          loaded.repo.id,
          cs.id,
          c.get('principal')!.userId,
          input.publish,
        ),
      },
      202,
    );
  } catch (err) {
    return errorResponse(c, err);
  }
});
collaborationRoutes.get(`${base}/ci/runs/:id/log`, async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'read', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const job = await q1<CiRun>(
      c.env,
      'SELECT * FROM ci_runs WHERE id = ? AND repo_id = ?',
      [c.req.param('id'), loaded.repo.id],
    );
    if (!job) return apiError(c, 404, 'run_not_found', 'Run not found');
    if (!job.log_key)
      return c.text(
        job.state === 'running'
          ? 'Build is running. Logs are available when it finishes.'
          : 'No retained log.',
      );
    const object = await c.env.OBJECTS.get(job.log_key);
    return new Response(object?.body ?? 'Log expired.', {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});
collaborationRoutes.post(`${base}/ci/runs/:id/cancel`, async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'write', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const job = await q1<CiRun>(
      c.env,
      'SELECT * FROM ci_runs WHERE id = ? AND repo_id = ?',
      [c.req.param('id'), loaded.repo.id],
    );
    if (!job) return apiError(c, 404, 'run_not_found', 'Run not found');
    if (c.env.CI_RUNNER) {
      const response = await c.env.CI_RUNNER.get(
        c.env.CI_RUNNER.idFromName(job.id),
      ).fetch('https://runner/cancel', {
        method: 'POST',
        body: JSON.stringify({ run_id: job.id }),
      });
      if (!response.ok)
        throw new ApiError(
          503,
          'ci_cancel_failed',
          'The runner could not confirm cancellation. Check the run status and retry.',
        );
    } else {
      await run(
        c.env,
        "UPDATE ci_runs SET state = 'cancelled', finished_at = ? WHERE id = ? AND state = 'queued'",
        [Date.now(), job.id],
      );
      const current = await q1<CiRun>(c.env, 'SELECT * FROM ci_runs WHERE id = ?', [
        job.id,
      ]);
      if (current?.state === 'running')
        throw new ApiError(
          503,
          'ci_cancel_failed',
          'The runner is unavailable and cancellation could not be confirmed.',
        );
    }
    return c.json({ ok: true });
  } catch (err) {
    return errorResponse(c, err);
  }
});

async function autoCheck(
  env: AppEnv['Bindings'],
  pull: Pull,
  actor: string,
): Promise<{ status: string; message?: string }> {
  if (
    pull.state !== 'open' ||
    env.CI_ENABLED !== 'true' ||
    !(await settings(env, pull.repo_id))
  )
    return { status: 'not_started' };
  try {
    await enqueueRun(env, pull.repo_id, pull.head_cs, actor);
    return { status: 'queued' };
  } catch (err) {
    return {
      status: 'not_started',
      message:
        err instanceof ApiError
          ? err.message
          : 'Could not schedule checks. Run them from the CI page.',
    };
  }
}

/** Logs and scripts can expose any source path; partial readers cannot use these surfaces. */
async function loadWholeRepo(
  c: Context<AppEnv>,
  permission: 'read' | 'write' | 'admin',
  slug: string,
) {
  const loaded = await (
    permission === 'admin'
      ? loadAdminRepo
      : permission === 'write'
        ? loadWritableRepo
        : loadReadableRepo
  )(c, slug);
  if (!loaded.ok) return loaded;
  const principal = c.get('principal');
  if (principal?.kind === 'token') {
    if (principal.repoId && principal.repoId !== loaded.repo.id)
      return {
        ok: false as const,
        response: apiError(c, 404, 'repo_not_found', 'Repository not found'),
      };
    const scope = permission === 'read' ? 'repo:read' : 'repo:write';
    if (!principal.scopes.includes(scope))
      return {
        ok: false as const,
        response: apiError(c, 403, 'insufficient_scope', `Token requires ${scope}`),
      };
  }
  for (const rule of await listPathRules(c.env, loaded.repo.id)) {
    for (const perm of permission === 'read'
      ? (['read'] as const)
      : (['read', 'write'] as const)) {
      if (!(await can(c.env, loaded.repo, c.get('principal'), perm, rule.path_prefix))) {
        return {
          ok: false as const,
          response: apiError(
            c,
            403,
            'whole_repository_required',
            'Pull requests and CI require access to the whole repository, including paths covered by permission rules.',
          ),
        };
      }
    }
  }
  return loaded;
}
