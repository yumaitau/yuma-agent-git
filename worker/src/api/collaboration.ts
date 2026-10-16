import { Hono, type Context } from 'hono';
import { can } from '../auth/rbac';
import { z } from 'zod';
import type { AppEnv } from '../auth/principal';
import { loadWholeRepo, requireAgentScope } from '../auth/guards';
import type { RepoWithCreator } from '../auth/rbac';
import { apiError, errorResponse, readJsonBody } from './errors';
import { q, q1, run } from '../db/client';
import { getRef } from '../db/repos';
import { getChangeset } from '../core/changesets';
import { threeWay } from '../core/merge';
import { resolveRevision } from '../core/read';
import { getBlob } from '../core/blobs';
import { resolvePath } from '../core/trees';
import { ApiError } from '../core/errors';
import { getPull, pullGate, type Pull, type Review } from '../reviews/pulls';
import {
  monthlyBudget,
  parsePolicy,
  policySchema,
  PRESETS,
  reservation,
  settings,
  type CiRun,
} from '../ci/config';
import { pullPipelines, pushPipelines } from '../ci/triggers';
import { requestRun } from '../ci/environments';
import { advancePipelines } from '../ci/planner';
import { stopSelfHosted } from '../ci/runners';
import {
  actorKindOf,
  agentIdOf,
  contextFor,
  parseContext,
  runRef,
  triggerOf,
} from '../ci/context';
import { actorOf, recordAudit } from '../audit/record';
import { emitEvent, emitRefUpdate } from '../webhooks/events';
import { enforceAgentAction } from '../policy/guardrails';
import { nextNumber } from '../collab/issues';
import { linkLanded, linkReferences } from '../collab/references';
import { requestCodeOwners } from '../reviews/codeowners';
import { requestPushMirrors } from '../mirrors/queue';

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
export const createPull = z.object({
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
    const scoped = requireAgentScope(c, 'pulls:write');
    if (scoped) return scoped;
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
    const number = await nextNumber(c.env, loaded.repo.id);
    const result = await c.env.DB.prepare(
      `INSERT INTO pull_requests (repo_id,number,title,body,author_id,base_ref,base_cs,head_cs,state,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
      .bind(
        loaded.repo.id,
        number,
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
    await recordAudit(c, {
      action: 'pull.create',
      repo: loaded.repo,
      target: { pull_id: pull.id, base_ref: pull.base_ref, head_cs: pull.head_cs },
    });
    await emitEvent(c.env, loaded.repo, {
      event: 'pull_request',
      action: 'opened',
      actor: actorOf(c.get('principal')),
      origin: new URL(c.req.url).origin,
      data: { pull_request: pull },
    });
    const source = { kind: 'pull' as const, repo: loaded.repo.slug, ref: pull.number };
    await linkReferences(c, loaded.repo, source, pull.body);
    await requestCodeOwners(c, loaded.repo, pull);
    const ci = await autoCheck(c, loaded.repo, pull);
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
/**
 * Would the pull request merge cleanly into its target's current head (#42)?
 * Lists the conflicting paths and hunks; agents resolve them by committing a
 * resolution changeset and updating the pull request.
 */
collaborationRoutes.get(`${base}/pulls/:id/conflicts`, async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'read', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const pull = await getPull(c.env, loaded.repo.id, Number(c.req.param('id')));
    const ref = await getRef(c.env, loaded.repo.id, pull.base_ref);
    const target = ref ? await getChangeset(c.env, loaded.repo.id, ref.head) : null;
    const head = await getChangeset(c.env, loaded.repo.id, pull.head_cs);
    if (!target || !head)
      throw new ApiError(
        404,
        'changeset_not_found',
        'Target or proposed revision not found',
      );
    const merged = await threeWay(c.env, loaded.repo.id, target, head, { store: false });
    return c.json({
      mergeable: merged.conflicts.length === 0,
      target_cs: target.id,
      head_cs: head.id,
      merge_base: merged.base,
      conflicts: merged.conflicts,
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});
// Serialize reviews, revisions and merges with the same target ref DO.
for (const action of ['update', 'review', 'merge', 'update-branch'] as const) {
  collaborationRoutes.post(`${base}/pulls/:id/${action}`, async (c) => {
    try {
      const loaded = await loadWholeRepo(c, 'write', c.req.param('repo'));
      if (!loaded.ok) return loaded.response;
      const scoped = requireAgentScope(c, 'pulls:write');
      if (scoped) return scoped;
      // Merging moves the default branch, which agent tokens never do (#57).
      if (action === 'merge' && c.get('principal')?.kind === 'agent') {
        return apiError(c, 403, 'protected_branch', 'agents cannot merge pull requests');
      }
      const pull = await getPull(c.env, loaded.repo.id, Number(c.req.param('id')));
      const body = await readJsonBody(c);
      if (action === 'update-branch') {
        // agent guardrails (#62): an agent merging or rebasing the target in
        const how = (body as { method?: unknown } | null)?.method ?? 'merge';
        const update = { pull: pull.number, head_cs: pull.head_cs, method: how };
        await enforceAgentAction(
          c.env,
          c.get('principal'),
          loaded.repo,
          { action: 'pr.merge', ref: pull.base_ref },
          { exact: update, summary: { ...update, base_ref: pull.base_ref } },
        );
      }
      const stub = c.env.REF_LOCK.get(
        c.env.REF_LOCK.idFromName(`${loaded.repo.id}:${pull.base_ref}`),
      );
      const response = await stub.fetch(`https://ref-lock/pull/${action}`, {
        method: 'POST',
        body: JSON.stringify({
          repo_id: loaded.repo.id,
          id: pull.id,
          actor: c.get('principal')!.userId,
          principal: c.get('principal'),
          body,
        }),
      });
      const after = response.ok ? await getPull(c.env, loaded.repo.id, pull.id) : pull;
      if (response.ok) {
        const decision = (body as { decision?: unknown } | null)?.decision;
        await recordAudit(c, {
          action: action === 'update-branch' ? 'pull.update_branch' : `pull.${action}`,
          repo: loaded.repo,
          target: {
            pull_id: pull.id,
            base_ref: pull.base_ref,
            ...(action === 'review' && typeof decision === 'string' ? { decision } : {}),
            ...(action === 'merge'
              ? { method: after.merge_method, merged_cs: after.merged_cs }
              : {}),
            ...(action === 'update-branch' ? { head_cs: after.head_cs } : {}),
          },
        });
        await emitPull(
          c,
          loaded.repo,
          action === 'update-branch' ? 'update' : action,
          pull,
        );
      }
      if (response.ok && action === 'merge') {
        // push mirrors (#36) follow the merge like any other move of the branch
        await requestPushMirrors(c.env, loaded.repo.id);
        // A merge moves the target branch like a push does, so it starts `on: push` pipelines.
        try {
          await pushPipelines(c.env, loaded.repo.id, triggerOf(c), [
            {
              name: after.base_ref,
              from: after.base_cs,
              to: after.merged_cs ?? after.head_cs,
            },
          ]);
        } catch (err) {
          // The branch already moved; a CI failure must not report the merge as failed.
          console.error('merge: pipeline trigger failed', err);
        }
      }
      const source = { kind: 'pull' as const, repo: loaded.repo.slug, ref: pull.number };
      if (response.ok && action === 'review') {
        // inline comments (#39) link the issues they mention, as thread comments do
        const comments = (body as { comments?: unknown } | null)?.comments;
        for (const comment of Array.isArray(comments) ? (comments as unknown[]) : []) {
          const text = (comment as { body?: unknown } | null)?.body;
          if (typeof text === 'string')
            await linkReferences(c, loaded.repo, source, text);
        }
      }
      // `Closes #N` closes issues only once the pull lands on the default branch.
      if (
        response.ok &&
        action === 'merge' &&
        pull.base_ref === loaded.repo.default_branch
      ) {
        await linkLanded(
          c,
          loaded.repo,
          after.base_cs,
          after.merged_cs ?? after.head_cs,
          {
            source,
            body: after.body,
          },
        );
      }
      if (response.ok && (action === 'update' || action === 'update-branch')) {
        const data = (await response.json()) as { pull: Pull };
        if (data.pull.body !== pull.body)
          await linkReferences(c, loaded.repo, source, data.pull.body);
        const moved =
          data.pull.head_cs !== pull.head_cs ||
          (pull.state === 'draft' && data.pull.state === 'open');
        if (moved) await requestCodeOwners(c, loaded.repo, data.pull);
        const ci = moved
          ? await autoCheck(c, loaded.repo, data.pull)
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
      'SELECT * FROM ci_runs WHERE repo_id = ? AND pipeline_run_id IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 30',
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
    const config = parsePolicy(await readJsonBody(c), policySchema);
    const lock = c.env.REF_LOCK.get(
      c.env.REF_LOCK.idFromName(`${loaded.repo.id}:${loaded.repo.default_branch}`),
    );
    const saved = await lock.fetch('https://ref-lock/ci-config', {
      method: 'POST',
      body: JSON.stringify({ repo_id: loaded.repo.id, config }),
    });
    if (!saved.ok) return new Response(saved.body, saved);
    // commands are left out: build scripts may carry inline credentials
    await recordAudit(c, {
      action: 'ci.settings.update',
      repo: loaded.repo,
      target: {
        preset: config.preset,
        required_approvals: config.required_approvals,
        require_checks: config.require_checks,
        protect_default: config.protect_default,
        image: config.image,
        environment: config.environment,
        secrets: config.secrets,
        id_token: config.permissions.id_token,
        packages: config.permissions.packages ?? 'none',
        aws_role_arn: config.aws?.role_arn ?? null,
      },
    });
    return c.json({ config, max_run_usd: reservation(config) / 1e6 });
  } catch (err) {
    return errorResponse(c, err);
  }
});
export const createRunSchema = z.object({
  head: z.string().min(1).optional(),
  publish: z.boolean().default(false),
});
collaborationRoutes.post(`${base}/ci/runs`, async (c) => {
  try {
    const input = parse(createRunSchema, await readJsonBody(c));
    const loaded = await loadWholeRepo(
      c,
      input.publish ? 'admin' : 'write',
      c.req.param('repo'),
    );
    if (!loaded.ok) return loaded.response;
    const scoped = requireAgentScope(c, 'ci:run');
    if (scoped) return scoped;
    const rev = input.head ?? `ref:${loaded.repo.default_branch}`;
    const cs = await resolveRevision(c.env, loaded.repo.id, rev);
    const ref = await runRef(c.env, loaded.repo.id, rev, cs.id);
    // agent guardrails (#62): a run can deploy and read secrets
    const dispatch = { head_cs: cs.id, ref, publish: input.publish };
    await enforceAgentAction(
      c.env,
      c.get('principal'),
      loaded.repo,
      { action: 'pipeline.run', ...(ref ? { ref } : {}) },
      { exact: dispatch, summary: dispatch },
    );
    const started = await requestRun(
      c.env,
      loaded.repo,
      cs.id,
      c.get('principal')!.userId,
      input.publish,
      {
        event: 'workflow_dispatch',
        ref,
        pull_id: null,
        fork: false,
        actor_kind: actorKindOf(c.get('principal')),
        origin: new URL(c.req.url).origin,
        approval_id: null,
        agent_id: agentIdOf(c.get('principal')),
      },
    );
    if (started.approval) {
      // the run waits for its environment's reviewers or wait timer
      await recordAudit(c, {
        action: 'environment.approval.request',
        repo: loaded.repo,
        target: {
          approval_id: started.approval.id,
          environment: started.approval.environment,
          head_cs: cs.id,
          publish: input.publish,
        },
      });
      return c.json({ approval: started.approval }, 202);
    }
    await recordAudit(c, {
      action: 'ci.run.create',
      repo: loaded.repo,
      target: { run_id: started.run.id, head_cs: cs.id, publish: input.publish },
    });
    return c.json({ run: started.run }, 202);
  } catch (err) {
    return errorResponse(c, err);
  }
});
/**
 * Run a finished settings run again with its original trigger (event, ref,
 * pull request), so branch rules, environment approval and OIDC subjects
 * apply as they did the first time. The caller becomes the new actor.
 */
collaborationRoutes.post(`${base}/ci/runs/:id/retry`, async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'write', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const scoped = requireAgentScope(c, 'ci:run');
    if (scoped) return scoped;
    const job = await q1<CiRun>(
      c.env,
      'SELECT * FROM ci_runs WHERE id = ? AND repo_id = ? AND pipeline_run_id IS NULL',
      [c.req.param('id'), loaded.repo.id],
    );
    if (!job) return apiError(c, 404, 'run_not_found', 'Run not found');
    if (job.publish) {
      // publishing needs admin, as when the run was first started
      const admin = await loadWholeRepo(c, 'admin', c.req.param('repo'));
      if (!admin.ok) return admin.response;
    }
    const trigger = triggerOf(c);
    const previous = parseContext(job.context);
    // runs from before trigger contexts count as a dispatch of the default branch tip
    const context = previous
      ? {
          ...previous,
          actor_kind: trigger.actor_kind,
          origin: trigger.origin,
          approval_id: null,
          agent_id: trigger.agent_id ?? null,
        }
      : contextFor(
          trigger,
          'workflow_dispatch',
          await runRef(
            c.env,
            loaded.repo.id,
            `ref:${loaded.repo.default_branch}`,
            job.head_cs,
          ),
        );
    const retry = { retry_of: job.id, head_cs: job.head_cs, ref: context.ref };
    await enforceAgentAction(
      c.env,
      c.get('principal'),
      loaded.repo,
      { action: 'pipeline.run', ...(context.ref ? { ref: context.ref } : {}) },
      { exact: retry, summary: retry },
    );
    const started = await requestRun(
      c.env,
      loaded.repo,
      job.head_cs,
      trigger.actor,
      Boolean(job.publish),
      context,
    );
    if (started.approval) {
      await recordAudit(c, {
        action: 'environment.approval.request',
        repo: loaded.repo,
        target: {
          approval_id: started.approval.id,
          environment: started.approval.environment,
          head_cs: job.head_cs,
          retry_of: job.id,
        },
      });
      return c.json({ approval: started.approval }, 202);
    }
    await recordAudit(c, {
      action: 'ci.run.create',
      repo: loaded.repo,
      target: { run_id: started.run.id, head_cs: job.head_cs, retry_of: job.id },
    });
    return c.json({ run: started.run }, 202);
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
    const scoped = requireAgentScope(c, 'ci:run');
    if (scoped) return scoped;
    const job = await q1<CiRun>(
      c.env,
      'SELECT * FROM ci_runs WHERE id = ? AND repo_id = ?',
      [c.req.param('id'), loaded.repo.id],
    );
    if (!job) return apiError(c, 404, 'run_not_found', 'Run not found');
    // a self-hosted runner sees the cancellation on its next heartbeat
    if (await stopSelfHosted(c.env, job.id)) await advancePipelines(c.env);
    else if (c.env.CI_RUNNER) {
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
    await recordAudit(c, {
      action: 'ci.run.cancel',
      repo: loaded.repo,
      target: { run_id: job.id },
    });
    return c.json({ ok: true });
  } catch (err) {
    return errorResponse(c, err);
  }
});

/** Webhook events for a pull request action that succeeded (#75). */
async function emitPull(
  c: Context<AppEnv>,
  repo: RepoWithCreator,
  action: 'update' | 'review' | 'merge',
  before: Pull,
): Promise<void> {
  const after = await getPull(c.env, repo.id, before.id);
  const actor = actorOf(c.get('principal'));
  const origin = new URL(c.req.url).origin;
  if (action === 'review') {
    const review = await q1<Review>(
      c.env,
      'SELECT * FROM pull_reviews WHERE pull_id = ? AND author_id = ? ORDER BY id DESC LIMIT 1',
      [after.id, c.get('principal')!.userId],
    );
    await emitEvent(c.env, repo, {
      event: 'pull_request_review',
      action: 'submitted',
      actor,
      origin,
      data: { pull_request: after, review },
    });
    return;
  }
  const changed = (from: string, to: string): boolean =>
    before.state === from && after.state === to;
  const kind =
    action === 'merge' || (after.state === 'closed' && before.state !== 'closed')
      ? 'closed'
      : before.state === 'closed'
        ? 'reopened'
        : changed('draft', 'open')
          ? 'ready_for_review'
          : changed('open', 'draft')
            ? 'converted_to_draft'
            : after.head_cs !== before.head_cs
              ? 'synchronize'
              : 'edited';
  await emitEvent(c.env, repo, {
    event: 'pull_request',
    action: kind,
    actor,
    origin,
    data: { pull_request: after },
  });
  if (action === 'merge')
    await emitRefUpdate(
      c.env,
      repo,
      {
        name: after.base_ref,
        from: after.base_cs,
        to: after.merged_cs ?? after.head_cs,
        commits: [after.merged_cs ?? after.head_cs],
        forced: false,
      },
      actor,
      origin,
    );
}

export async function autoCheck(
  c: Context<AppEnv>,
  repo: RepoWithCreator,
  pull: Pull,
): Promise<{ status: string; message?: string }> {
  const env = c.env;
  if (pull.state !== 'open' || env.CI_ENABLED !== 'true')
    return { status: 'not_started' };
  try {
    // Pipeline files in the proposed revision run as well as the settings
    // pipeline: the author writes them, so they never replace the CI policy.
    const trigger = triggerOf(c);
    const config = await settings(env, pull.repo_id);
    const started = config
      ? await requestRun(env, repo, pull.head_cs, trigger.actor, false, {
          event: 'pull_request',
          ref: `refs/pull/${pull.id}/merge`,
          pull_id: pull.id,
          // pull requests always come from this repository; forks do not exist yet
          fork: false,
          actor_kind: trigger.actor_kind,
          origin: trigger.origin,
          approval_id: null,
          agent_id: trigger.agent_id ?? null,
        })
      : null;
    const pipelines = await pullPipelines(env, pull, trigger);
    if (started) return { status: started.approval ? 'waiting_for_approval' : 'queued' };
    return pipelines ?? { status: 'not_started' };
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
