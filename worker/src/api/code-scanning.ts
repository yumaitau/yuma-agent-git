import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../auth/principal';
import type { Env } from '../env';
import { loadWholeRepo, requireAgentScope } from '../auth/guards';
import { actorOf, recordAudit, type AuditActor } from '../audit/record';
import { q, q1, type RepoRecord } from '../db/client';
import { getRef, getRepo } from '../db/repos';
import { getChangeset } from '../core/changesets';
import { ApiError } from '../core/errors';
import { changesetForSha1 } from '../git/mapping';
import { jobForRequest } from '../ci/oidc';
import { parsePolicy } from '../ci/config';
import { parseContext } from '../ci/context';
import { emitEvent } from '../webhooks/events';
import { getPull } from '../reviews/pulls';
import {
  ALERT_COLUMNS,
  alertRowSchema,
  analysesOf,
  decodeSarif,
  ingestAnalyses,
  normaliseRef,
  uploadSarifSchema,
  type CodeScanningAlert,
  type UploadSarif,
} from '../security/code-scanning';
import { OSV_ATTRIBUTION, SEVERITIES } from '../security/deps/osv';
import { pullSecurity } from '../security/pull-security';
import { apiError, errorResponse, readJsonBody } from './errors';

/**
 * Code scanning (issue #67):
 *   POST  /api/v1/repos/:repo/code-scanning/sarif         upload SARIF 2.1.0
 *   GET   /api/v1/repos/:repo/code-scanning/alerts        ?ref=&state=&severity=&tool=&cursor=
 *   PATCH /api/v1/repos/:repo/code-scanning/alerts/:id    dismiss or reopen
 *   GET   /api/v1/repos/:repo/pulls/:id/security          new findings on a pull request
 * Uploads need whole-repository write (agents also `security_events:write`);
 * CI jobs upload through `POST /ci/code-scanning/sarif` below. Agents cannot
 * dismiss or reopen alerts.
 */
export const codeScanningRoutes = new Hono<AppEnv>();

export const codeScanningAlertQuery = z.object({
  ref: z.string().max(255).optional(),
  state: z.enum(['open', 'fixed', 'dismissed']).optional(),
  severity: z.enum(SEVERITIES).optional(),
  tool: z.string().max(100).optional(),
  cursor: z.string().optional(),
});
export const DISMISS_REASONS = ['false_positive', 'wont_fix', 'used_in_tests'] as const;
export const updateCodeScanningAlert = z.union([
  z.object({ state: z.literal('dismissed'), reason: z.enum(DISMISS_REASONS) }),
  z.object({ state: z.literal('open') }),
]);

const PULL_REF = /^refs\/pull\/\d+\/(head|merge)$/;

/** The changeset a `commit_sha` (Git SHA-1 or changeset id) names, or 422. */
async function changesetOf(env: Env, repoId: string, sha: string): Promise<string> {
  const csId =
    sha.length === 40
      ? await changesetForSha1(env, repoId, sha)
      : (await getChangeset(env, repoId, sha))?.id;
  if (!csId) throw new ApiError(422, 'unknown_commit', `No commit ${sha} in this repository`);
  return csId;
}

/** Parse, store and audit one upload; the 202 body. */
async function ingest(
  c: Context<AppEnv>,
  repo: RepoRecord,
  at: { ref: string; csId: string },
  body: UploadSarif,
  actor: AuditActor,
): Promise<Response> {
  const sarif = await decodeSarif(body.sarif);
  const analyses = await analysesOf(sarif, body);
  const stored = await ingestAnalyses(
    c.env,
    repo,
    at,
    analyses,
    actor,
    new URL(c.req.url).origin,
  );
  await recordAudit(c, {
    action: 'code_scanning.upload',
    repo,
    actor,
    target: {
      ref: at.ref,
      changeset: at.csId,
      analyses: stored.map((a) => ({
        id: a.id,
        tool: a.tool,
        category: a.category,
        results: a.results,
      })),
    },
  });
  return c.json({ ref: at.ref, commit: at.csId, analyses: stored }, 202);
}

function parseUpload(value: unknown): UploadSarif {
  const parsed = uploadSarifSchema.safeParse(value);
  if (!parsed.success)
    throw new ApiError(400, 'invalid_request', 'Send sarif (gzip then base64), commit_sha and ref');
  return parsed.data;
}

codeScanningRoutes.post('/repos/:repo{.+}/code-scanning/sarif', async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'write', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const scope = requireAgentScope(c, 'security_events:write');
    if (scope) return scope;
    const repo = loaded.repo;
    const body = parseUpload(await readJsonBody(c));
    if (!body.commit_sha || !body.ref)
      return apiError(c, 400, 'invalid_request', 'commit_sha and ref are required');
    const csId = await changesetOf(c.env, repo.id, body.commit_sha);
    const ref = normaliseRef(body.ref);
    if (!PULL_REF.test(ref) && !(await getRef(c.env, repo.id, ref)))
      throw new ApiError(422, 'unknown_ref', `No ref ${body.ref} in this repository`);
    return await ingest(c, repo, { ref, csId }, body, actorOf(c.get('principal')));
  } catch (err) {
    return errorResponse(c, err);
  }
});

/**
 * `POST /ci/code-scanning/sarif` (outside `/api`, like the OIDC token
 * endpoint): a running CI job uploads with its request token
 * (`YAG_CODE_SCANNING_TOKEN`) when its pipeline grants
 * `permissions.security_events: write`. The job's repository, changeset and
 * ref are used; `commit_sha` and `ref` in the body are ignored.
 */
export const ciCodeScanningRoutes = new Hono<AppEnv>();

ciCodeScanningRoutes.post('/ci/code-scanning/sarif', async (c) => {
  try {
    const header = c.req.header('authorization') ?? '';
    const job = await jobForRequest(
      c.env,
      header.startsWith('Bearer ') ? header.slice(7).trim() : '',
      undefined,
    );
    let allowed = false;
    try {
      allowed =
        parsePolicy(JSON.parse(job.config)).permissions.security_events === 'write';
    } catch {
      allowed = false;
    }
    if (!allowed)
      throw new ApiError(
        403,
        'insufficient_scope',
        'The pipeline needs permissions.security_events: write to upload SARIF',
      );
    const repo = await getRepo(c.env, job.repo_id);
    const ref = parseContext(job.context)?.ref;
    if (!repo) throw new ApiError(404, 'repo_not_found', 'Repository not found');
    if (!ref) throw new ApiError(422, 'no_ref', 'The run has no ref to upload for');
    const body = parseUpload(await readJsonBody(c));
    return await ingest(c, repo, { ref: normaliseRef(ref), csId: job.head_cs }, body, {
      kind: 'system',
      id: `ci-run:${job.id}`,
      onBehalfOf: job.requested_by,
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

codeScanningRoutes.get('/repos/:repo{.+}/code-scanning/alerts', async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'write', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const query = codeScanningAlertQuery.safeParse(c.req.query());
    const before = Number(query.data?.cursor ?? Number.MAX_SAFE_INTEGER);
    if (!query.success || !Number.isSafeInteger(before))
      return apiError(c, 400, 'invalid_request', 'Invalid ref, state, severity or cursor');
    const { state, severity, tool } = query.data;
    const ref = normaliseRef(query.data.ref ?? loaded.repo.default_branch);
    const rows = await q(
      c.env,
      `SELECT ${ALERT_COLUMNS} FROM code_scanning_alerts
        WHERE repo_id = ? AND ref = ? AND id < ?
          ${state ? 'AND state = ?' : ''} ${severity ? 'AND severity = ?' : ''}
          ${tool ? 'AND tool = ?' : ''}
        ORDER BY id DESC LIMIT 101`,
      [
        loaded.repo.id,
        ref,
        before,
        ...(state ? [state] : []),
        ...(severity ? [severity] : []),
        ...(tool ? [tool] : []),
      ],
    );
    const alerts = rows.slice(0, 100).map((r) => alertRowSchema.parse(r));
    return c.json(
      {
        ref,
        alerts,
        next_cursor: rows.length > 100 ? String(alerts[alerts.length - 1]?.id) : null,
      },
      200,
      { 'cache-control': 'private, no-store' },
    );
  } catch (err) {
    return errorResponse(c, err);
  }
});

codeScanningRoutes.patch('/repos/:repo{.+}/code-scanning/alerts/:id', async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'write', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const principal = c.get('principal');
    if (principal?.kind === 'agent')
      return apiError(c, 403, 'forbidden', 'Agents cannot dismiss or reopen alerts');
    const repo = loaded.repo;
    const parsed = updateCodeScanningAlert.safeParse(await readJsonBody(c));
    if (!parsed.success)
      return apiError(
        c,
        400,
        'invalid_request',
        'Send state open, or dismissed with a reason',
      );
    const row = await q1(
      c.env,
      `SELECT ${ALERT_COLUMNS} FROM code_scanning_alerts WHERE repo_id = ? AND id = ?`,
      [repo.id, Number(c.req.param('id'))],
    );
    if (!row) return apiError(c, 404, 'alert_not_found', 'Alert not found');
    const before = alertRowSchema.parse(row);
    if (before.state === 'fixed')
      return apiError(c, 409, 'alert_fixed', 'A fixed alert cannot be dismissed or reopened');
    const dismissed = parsed.data.state === 'dismissed';
    const after: CodeScanningAlert = {
      ...before,
      state: parsed.data.state,
      dismissed_reason: parsed.data.state === 'dismissed' ? parsed.data.reason : null,
      dismissed_by: dismissed ? (principal?.userId ?? null) : null,
      updated_at: Date.now(),
    };
    await recordAudit(
      c,
      {
        action: 'code_scanning.alert.update',
        repo,
        target: {
          alert_id: before.id,
          rule_id: before.rule_id,
          tool: before.tool,
          path: before.path,
          state: after.state,
          reason: after.dismissed_reason,
          previous: { state: before.state, reason: before.dismissed_reason },
        },
      },
      [
        c.env.DB.prepare(
          'UPDATE code_scanning_alerts SET state = ?, dismissed_reason = ?, dismissed_by = ?, updated_at = ? WHERE id = ?',
        ).bind(
          after.state,
          after.dismissed_reason,
          after.dismissed_by,
          after.updated_at,
          before.id,
        ),
      ],
    );
    if (before.state !== after.state)
      await emitEvent(c.env, repo, {
        event: 'code_scanning_alert',
        action: dismissed ? 'dismissed' : 'reopened',
        actor: actorOf(principal),
        origin: new URL(c.req.url).origin,
        data: { alert: after },
      });
    return c.json({ alert: after });
  } catch (err) {
    return errorResponse(c, err);
  }
});

/**
 * Security findings on a pull request: code scanning results uploaded for
 * its head (each marked `new` when the target branch does not already have
 * it) and vulnerable dependencies the head adds over the merge base.
 */
codeScanningRoutes.get('/repos/:repo{.+}/pulls/:id/security', async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'write', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const pull = await getPull(c.env, loaded.repo.id, Number(c.req.param('id')));
    const found = await pullSecurity(c.env, pull);
    return c.json({ ...found, attribution: OSV_ATTRIBUTION }, 200, {
      'cache-control': 'private, no-store',
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});
