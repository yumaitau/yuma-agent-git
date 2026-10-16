import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../auth/principal';
import { loadWholeRepo, requireAgentScope } from '../auth/guards';
import { getAgent } from '../auth/agents';
import { ApiError } from '../core/errors';
import { actorOf, recordAudit } from '../audit/record';
import { requestIdOf } from '../middleware/observe';
import { pauseFor, pauseMessage } from '../policy/pause';
import { rulesetsFor } from '../policy/rulesets';
import { getPull } from '../reviews/pulls';
import { agentCanReview, pullCodeowners } from '../reviews/codeowners';
import {
  listReviewers,
  recordVerdict,
  reviewerInput,
  reviewLoop,
  verdictInput,
} from '../reviews/agentLoop';
import { pullRisk, sensitivePaths } from '../reviews/risk';
import { apiError, errorResponse, readJsonBody } from './errors';

/**
 * Agent review loops (issue #60):
 *   GET    /api/v1/repos/:repo/agent-reviewers           registered reviewers
 *   PUT    /api/v1/repos/:repo/agent-reviewers/:agent    register or change (admin)
 *   DELETE /api/v1/repos/:repo/agent-reviewers/:agent    remove (admin)
 *   GET    /api/v1/repos/:repo/pulls/:id/agent-review    rounds, verdicts and risk
 *   POST   /api/v1/repos/:repo/pulls/:id/agent-review    a reviewer agent's verdict
 */
export const agentReviewRoutes = new Hono<AppEnv>();
const base = '/repos/:repo{.+}';

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new ApiError(
      400,
      'invalid_request',
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  return parsed.data;
}

agentReviewRoutes.get(`${base}/agent-reviewers`, async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'read', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    return c.json({ reviewers: await listReviewers(c.env, loaded.repo.id) });
  } catch (err) {
    return errorResponse(c, err);
  }
});

agentReviewRoutes.put(`${base}/agent-reviewers/:agent`, async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'admin', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const input = parse(reviewerInput, await readJsonBody(c));
    const agent = await getAgent(c.env, c.req.param('agent'));
    if (
      !agent ||
      agent.disabled ||
      !(await agentCanReview(c.env, loaded.repo, {
        owner_kind: agent.owner_kind,
        owner_id: agent.owner_id,
        allowed_repos: agent.allowed_repos ? JSON.stringify(agent.allowed_repos) : null,
      }))
    )
      throw new ApiError(
        404,
        'agent_not_found',
        'No enabled agent that can review this repository has that id.',
      );
    const now = Date.now();
    await recordAudit(
      c,
      {
        action: 'agent_reviewer.set',
        repo: loaded.repo,
        target: { agent_id: agent.id, ...input },
      },
      [
        c.env.DB.prepare(
          `INSERT INTO agent_reviewers (repo_id, agent_id, trigger_on, required, min_confidence,
             created_by, created_at) VALUES (?,?,?,?,?,?,?)
           ON CONFLICT (repo_id, agent_id) DO UPDATE SET trigger_on = excluded.trigger_on,
             required = excluded.required, min_confidence = excluded.min_confidence`,
        ).bind(
          loaded.repo.id,
          agent.id,
          input.trigger,
          input.required ? 1 : 0,
          input.min_confidence,
          c.get('principal')!.userId,
          now,
        ),
      ],
    );
    const reviewer = (await listReviewers(c.env, loaded.repo.id)).find(
      (r) => r.agent_id === agent.id,
    );
    return c.json({ reviewer });
  } catch (err) {
    return errorResponse(c, err);
  }
});

agentReviewRoutes.delete(`${base}/agent-reviewers/:agent`, async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'admin', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const agentId = c.req.param('agent');
    const exists = (await listReviewers(c.env, loaded.repo.id)).some(
      (r) => r.agent_id === agentId,
    );
    if (!exists)
      return apiError(c, 404, 'reviewer_not_found', 'That agent is not a reviewer here.');
    await recordAudit(
      c,
      {
        action: 'agent_reviewer.delete',
        repo: loaded.repo,
        target: { agent_id: agentId },
      },
      [
        c.env.DB.prepare(
          'DELETE FROM agent_reviewers WHERE repo_id = ? AND agent_id = ?',
        ).bind(loaded.repo.id, agentId),
      ],
    );
    return c.json({ ok: true });
  } catch (err) {
    return errorResponse(c, err);
  }
});

agentReviewRoutes.get(`${base}/pulls/:id/agent-review`, async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'read', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const pull = await getPull(c.env, loaded.repo.id, Number(c.req.param('id')));
    const rulesets = await rulesetsFor(c.env, loaded.repo);
    const owned = await pullCodeowners(c.env, loaded.repo, pull);
    c.header('cache-control', 'private, no-store');
    return c.json({
      ...(await reviewLoop(c.env, pull)),
      risk: await pullRisk(c.env, loaded.repo, pull, owned, sensitivePaths(rulesets)),
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

function auditMeta(c: Context<AppEnv>) {
  return {
    ip: c.req.header('cf-connecting-ip') ?? null,
    userAgent: c.req.header('user-agent') ?? null,
    requestId: requestIdOf(c.req.raw),
  };
}

agentReviewRoutes.post(`${base}/pulls/:id/agent-review`, async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'read', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const principal = c.get('principal');
    // verdicts come from agent identities; people review through /review
    if (principal?.kind !== 'agent')
      return apiError(c, 403, 'agent_only', 'Only an agent token can submit a verdict.');
    const scoped = requireAgentScope(c, 'pulls:write');
    if (scoped) return scoped;
    const pause = await pauseFor(c.env, loaded.repo);
    if (pause) return apiError(c, 403, 'agents_paused', pauseMessage(pause));
    const pull = await getPull(c.env, loaded.repo.id, Number(c.req.param('id')));
    // an agent acting for the author is the author (#60)
    if (principal.userId === pull.author_id)
      return apiError(
        c,
        403,
        'self_review',
        'An agent acting for the author cannot review their pull request.',
      );
    const input = parse(verdictInput, await readJsonBody(c));
    const result = await recordVerdict(
      c.env,
      loaded.repo,
      pull,
      principal.agentId,
      input,
      actorOf(principal),
      new URL(c.req.url).origin,
      auditMeta(c),
    );
    return c.json(result, 201);
  } catch (err) {
    return errorResponse(c, err);
  }
});
