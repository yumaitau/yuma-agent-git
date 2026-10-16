import { Hono } from 'hono';
import { actorOf } from '../audit/record';
import { enforcePushRules } from '../policy/rulesets';
import { agentKey, changeFacts, enforceAgentAction } from '../policy/guardrails';
import { apiError, errorResponse, readJsonBody } from './errors';
import { commitChanges, commitRequestSchema } from '../core/commit';
import { firstParentHistory, getChangeset } from '../core/changesets';
import { lookupRev } from '../core/read';
import {
  guardPathsWrite,
  loadReadableRepo as loadReadable,
  loadWritableRepo,
  pathReadFilter,
  visibleChangeset,
} from '../auth/guards';
import type { AppEnv } from '../auth/principal';
import { changesetProvenance, recordAgentProvenance } from '../auth/agents';
import { bypassSchema, enforceSecretScan, recordBypass } from '../security/secrets/scan';

/**
 * Changeset routes (architecture §2):
 *   POST /api/v1/repos/:repo/changesets
 *   GET  /api/v1/repos/:repo/changesets/:id
 *   GET  /api/v1/repos/:repo/changesets?head=…&limit=…
 *
 * Path rules: a commit needs `write` on every path it touches; reads drop
 * `changed_files` entries the caller may not `read` (`omitted_paths_count`).
 * Push rulesets (#41) apply to the files a commit changes, and agent
 * guardrails (#62) to agent commits.
 *
 * Agent tokens (#57) always commit as `{agent: <agent id>}`, and the agent,
 * the human and the task are recorded as the changeset's `provenance`.
 *
 * Secret scanning (#66) refuses commits that add a secret unless a repository
 * admin sends `secret_scanning_bypass` with a reason.
 */
export const changesetsRoutes = new Hono<AppEnv>();

/** The commit request plus an optional push-protection bypass. */
export const createChangesetSchema = commitRequestSchema.extend({
  secret_scanning_bypass: bypassSchema.optional(),
});

/** Metadata routes are principal-dependent: never cache them (issue #21). */
const NO_STORE = 'private, no-store';

function intParam(raw: string | undefined, def: number, max: number): number {
  const n = Number(raw ?? def);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : def;
}

changesetsRoutes.post('/repos/:repo{.+}/changesets', async (c) => {
  try {
    const loaded = await loadWritableRepo(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const repo = loaded.repo;

    const body = await readJsonBody(c);
    const parsed = createChangesetSchema.safeParse(body);
    if (parsed.success) {
      // per-repo write burst guard (issue #21): huge commits get 429, not a
      // wedged D1 row / R2 write storm
      const changes = parsed.data.changes;
      const inlineBytes = changes.reduce((sum, change) => {
        const content = 'content_b64' in change ? change.content_b64 : undefined;
        return sum + (content ? Math.floor((content.length * 3) / 4) : 0);
      }, 0);
      if (changes.length > 1000 || inlineBytes > 64 * 1024 * 1024) {
        return apiError(c, 429, 'write_too_large', 'commit exceeds write burst limits', {
          max_files: 1000,
          max_inline_bytes: 64 * 1024 * 1024,
          files: changes.length,
          inline_bytes: inlineBytes,
        });
      }
    }
    if (!parsed.success) {
      return apiError(c, 400, 'invalid_request', 'invalid commit request', {
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }

    const denied = await guardPathsWrite(
      c,
      repo,
      parsed.data.changes.map((change) => change.path),
    );
    if (denied) return denied;
    const principal = c.get('principal');
    await enforcePushRules(
      c.env,
      repo,
      principal,
      actorOf(principal),
      parsed.data.changes,
      'commit',
    );
    const { secret_scanning_bypass: bypass, ...commit } = parsed.data;
    const secrets = await enforceSecretScan(
      c.env,
      repo,
      principal,
      commit.changes,
      commit.first_parent,
      bypass,
    );

    // agent guardrails (#62): the approval binds the whole request
    if (agentKey(principal) !== null) {
      await enforceAgentAction(
        c.env,
        principal,
        repo,
        {
          action: 'changeset.create',
          ...(await changeFacts(c.env, repo.id, parsed.data.changes)),
        },
        {
          exact: parsed.data,
          summary: {
            first_parent: parsed.data.first_parent,
            files: parsed.data.changes.slice(0, 100).map((ch) => ch.path),
            file_count: parsed.data.changes.length,
          },
        },
      );
    }

    const request =
      principal?.kind === 'agent'
        ? { ...commit, author: { agent: principal.agentId } }
        : commit;
    const result = await commitChanges(c.env, repo.id, request);
    await recordAgentProvenance(c.env, repo.id, [result.changeset.id], principal);
    if (secrets && bypass) {
      await recordBypass(
        c,
        repo,
        secrets.map((f) => ({ ...f, changeset: result.changeset.id })),
        bypass,
        { source: 'commit', via: 'api' },
      );
    }
    return c.json(
      { changeset: result.changeset, deduped: result.deduped },
      result.deduped ? 200 : 201,
    );
  } catch (err) {
    return errorResponse(c, err);
  }
});

changesetsRoutes.get('/repos/:repo{.+}/changesets/:id', async (c) => {
  try {
    const loaded = await loadReadable(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const cs = await getChangeset(c.env, loaded.repo.id, c.req.param('id'));
    if (!cs) {
      return apiError(c, 404, 'changeset_not_found', `no changeset ${c.req.param('id')}`);
    }
    const canRead = await pathReadFilter(c, loaded.repo);
    return c.json(
      {
        changeset: visibleChangeset(cs, canRead),
        provenance: await changesetProvenance(c.env, loaded.repo.id, cs.id),
      },
      200,
      { 'cache-control': NO_STORE },
    );
  } catch (err) {
    return errorResponse(c, err);
  }
});

changesetsRoutes.get('/repos/:repo{.+}/changesets', async (c) => {
  try {
    const loaded = await loadReadable(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;

    const headParam =
      c.req.query('cursor') ?? c.req.query('head') ?? `ref:${loaded.repo.default_branch}`;
    const limit = intParam(c.req.query('limit'), 50, 200);

    const head = await lookupRev(c.env, loaded.repo.id, headParam);
    if (!head) {
      // Default head on an empty repo: empty history. Explicit rev: 404.
      if (c.req.query('head') === undefined && c.req.query('cursor') === undefined) {
        return c.json({ changesets: [] }, 200, { 'cache-control': NO_STORE });
      }
      return apiError(c, 404, 'revision_not_found', `no revision ${headParam}`);
    }

    const changesets = await firstParentHistory(
      c.env,
      loaded.repo.id,
      head.id,
      limit + 1,
    );
    const canRead = await pathReadFilter(c, loaded.repo);
    return c.json(
      {
        changesets: changesets.slice(0, limit).map((cs) => visibleChangeset(cs, canRead)),
        next_cursor: changesets.length > limit ? changesets[limit].id : null,
      },
      200,
      { 'cache-control': NO_STORE },
    );
  } catch (err) {
    return errorResponse(c, err);
  }
});
