import { Hono, type Context } from 'hono';
import type { AppEnv } from '../auth/principal';
import { loadWholeRepo } from '../auth/guards';
import { q, q1, run, type RepoRecord } from '../db/client';
import { ulid } from '../core/ids';
import { ApiError } from '../core/errors';
import { recordAudit, type AuditInput } from '../audit/record';
import {
  appliesToRepo,
  parseRulesetRow,
  rulesetInputSchema,
  type Ruleset,
  type RulesetInput,
} from '../policy/rulesets';
import { errorResponse, readJsonBody } from './errors';
import { loadOrg } from './orgs';

/**
 * Ruleset administration (issue #41). Repo admins manage repo rulesets; org
 * owners and admins manage org rulesets, which reach every org repo their
 * `repository_name` condition matches. Every change is audited
 * (`ruleset.create|update|delete`), so the audit log is the change history.
 *   GET    /api/v1/repos/:repo/rulesets              (+ inherited org rulesets)
 *   POST   /api/v1/repos/:repo/rulesets
 *   PUT    /api/v1/repos/:repo/rulesets/:id
 *   DELETE /api/v1/repos/:repo/rulesets/:id
 *   GET    /api/v1/repos/:repo/rulesets/evaluations  (evaluate-mode report)
 * and the same five under /api/v1/orgs/:org/rulesets.
 */
export const rulesetsRoutes = new Hono<AppEnv>();

interface Owner {
  scope: 'org' | 'repo';
  id: string;
  /** Repo or org the audit event belongs to. */
  audit: Pick<AuditInput, 'repo' | 'orgId'>;
  repo?: RepoRecord;
}

function parseInput(owner: Owner, body: unknown): RulesetInput {
  const parsed = rulesetInputSchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(
      400,
      'invalid_ruleset',
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  }
  // repository_name only means something on an org ruleset
  return owner.scope === 'repo'
    ? { ...parsed.data, conditions: { ref_name: parsed.data.conditions.ref_name } }
    : parsed.data;
}

async function loadRuleset(c: Context<AppEnv>, owner: Owner): Promise<Ruleset> {
  const row = await q1(
    c.env,
    'SELECT * FROM rulesets WHERE id = ? AND scope = ? AND owner_id = ?',
    [c.req.param('id'), owner.scope, owner.id],
  );
  if (!row) throw new ApiError(404, 'ruleset_not_found', 'Ruleset not found');
  return parseRulesetRow(row);
}

/** What an audit event says about a ruleset: its whole definition. */
function auditTarget(r: Ruleset): Record<string, unknown> {
  return {
    ruleset_id: r.id,
    scope: r.scope,
    name: r.name,
    target: r.target,
    enforcement: r.enforcement,
    conditions: r.conditions,
    rules: r.rules,
    bypass: r.bypass,
  };
}

function nameTaken(err: unknown): boolean {
  return String(err).includes('UNIQUE constraint failed: rulesets');
}

/** Rulesets the owner holds; a repo also sees the org rulesets that reach it. */
async function list(c: Context<AppEnv>, owner: Owner): Promise<Response> {
  const rows = await q(
    c.env,
    'SELECT * FROM rulesets WHERE scope = ? AND owner_id = ? ORDER BY name',
    [owner.scope, owner.id],
  );
  const repo = owner.repo;
  // org rulesets that reach this repo, shown read-only beside its own
  const inherited =
    repo?.owner_kind === 'org'
      ? (
          await q(
            c.env,
            "SELECT * FROM rulesets WHERE scope = 'org' AND owner_id = ? ORDER BY name",
            [repo.owner_id],
          )
        )
          .map(parseRulesetRow)
          .filter((r) => appliesToRepo(r, repo.slug))
      : [];
  return c.json({ rulesets: rows.map(parseRulesetRow), inherited });
}

async function create(c: Context<AppEnv>, owner: Owner): Promise<Response> {
  const input = parseInput(owner, await readJsonBody(c));
  const now = Date.now();
  const ruleset: Ruleset = {
    ...input,
    id: ulid(now),
    scope: owner.scope,
    owner_id: owner.id,
    created_by: c.get('principal')?.userId ?? '',
    created_at: now,
    updated_at: now,
  };
  try {
    await run(
      c.env,
      `INSERT INTO rulesets (id, scope, owner_id, name, target, enforcement, conditions, rules, bypass, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ruleset.id,
        ruleset.scope,
        ruleset.owner_id,
        ruleset.name,
        ruleset.target,
        ruleset.enforcement,
        JSON.stringify(ruleset.conditions),
        JSON.stringify(ruleset.rules),
        JSON.stringify(ruleset.bypass),
        ruleset.created_by,
        now,
        now,
      ],
    );
  } catch (err) {
    if (nameTaken(err))
      throw new ApiError(409, 'ruleset_exists', `a ruleset named ${input.name} exists`);
    throw err;
  }
  await recordAudit(c, {
    action: 'ruleset.create',
    ...owner.audit,
    target: auditTarget(ruleset),
  });
  return c.json({ ruleset }, 201);
}

async function replace(c: Context<AppEnv>, owner: Owner): Promise<Response> {
  const before = await loadRuleset(c, owner);
  const input = parseInput(owner, await readJsonBody(c));
  const ruleset: Ruleset = { ...before, ...input, updated_at: Date.now() };
  try {
    await run(
      c.env,
      `UPDATE rulesets SET name = ?, target = ?, enforcement = ?, conditions = ?, rules = ?, bypass = ?, updated_at = ?
         WHERE id = ?`,
      [
        ruleset.name,
        ruleset.target,
        ruleset.enforcement,
        JSON.stringify(ruleset.conditions),
        JSON.stringify(ruleset.rules),
        JSON.stringify(ruleset.bypass),
        ruleset.updated_at,
        ruleset.id,
      ],
    );
  } catch (err) {
    if (nameTaken(err))
      throw new ApiError(409, 'ruleset_exists', `a ruleset named ${input.name} exists`);
    throw err;
  }
  await recordAudit(c, {
    action: 'ruleset.update',
    ...owner.audit,
    target: { ...auditTarget(ruleset), previous: auditTarget(before) },
  });
  return c.json({ ruleset });
}

async function remove(c: Context<AppEnv>, owner: Owner): Promise<Response> {
  const ruleset = await loadRuleset(c, owner);
  await run(c.env, 'DELETE FROM rulesets WHERE id = ?', [ruleset.id]);
  await recordAudit(c, {
    action: 'ruleset.delete',
    ...owner.audit,
    target: auditTarget(ruleset),
  });
  return c.json({ ok: true });
}

/** The evaluate-mode log, newest first (`?before=` pages). */
async function report(c: Context<AppEnv>, owner: Owner): Promise<Response> {
  const before = Number(c.req.query('before') ?? Number.MAX_SAFE_INTEGER);
  if (!Number.isSafeInteger(before) || before < 1)
    throw new ApiError(400, 'invalid_cursor', 'Invalid evaluation cursor');
  // a repo sees every ruleset's hits on it; an org sees its rulesets' hits
  const rows = await q<Record<string, unknown> & { id: number; violations: string }>(
    c.env,
    `SELECT e.*, r.name AS ruleset, p.slug AS repo FROM ruleset_evaluations e
         JOIN rulesets r ON r.id = e.ruleset_id
         LEFT JOIN repos p ON p.id = e.repo_id
        WHERE ${owner.scope === 'repo' ? 'e.repo_id = ?' : "r.scope = 'org' AND r.owner_id = ?"}
          AND e.id < ?
        ORDER BY e.id DESC LIMIT 101`,
    [owner.id, before],
  );
  const page = rows.slice(0, 100);
  return c.json({
    evaluations: page.map((r) => ({
      ...r,
      violations: JSON.parse(r.violations) as unknown,
    })),
    next_cursor: rows.length > 100 ? (page[page.length - 1]?.id ?? null) : null,
  });
}

type Handler = (c: Context<AppEnv>, owner: Owner) => Promise<Response>;

/** One route per prefix, each naming its guard (scripts/gen-api-docs.ts reads it). */
function mount(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  tail: string,
  handler: Handler,
): void {
  rulesetsRoutes.on(method, `/repos/:repo{.+}/rulesets${tail}`, async (c) => {
    try {
      // rulesets cover every path, like the CI policy: whole-repo admins only
      const loaded = await loadWholeRepo(c, 'admin', c.req.param('repo') ?? '');
      if (!loaded.ok) return loaded.response;
      const repo = loaded.repo;
      return await handler(c, { scope: 'repo', id: repo.id, audit: { repo }, repo });
    } catch (err) {
      return errorResponse(c, err);
    }
  });
  rulesetsRoutes.on(method, `/orgs/:org/rulesets${tail}`, async (c) => {
    try {
      const { org } = await loadOrg(c, 'manage');
      return await handler(c, { scope: 'org', id: org.id, audit: { orgId: org.slug } });
    } catch (err) {
      return errorResponse(c, err);
    }
  });
}

mount('GET', '', list);
mount('POST', '', create);
mount('PUT', '/:id', replace);
mount('DELETE', '/:id', remove);
mount('GET', '/evaluations', report);
