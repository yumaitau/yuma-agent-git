import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../auth/principal';
import { C, T } from '../db/schema';
import {
  parsePathRuleRow,
  parseRepoMemberRow,
  parseRepoRow,
  parseUserRow,
  q,
  q1,
  run,
} from '../db/client';
import { apiError, errorResponse, readJsonBody } from './errors';
import { loadAdminRepo } from '../auth/guards';
import { parsePathRuleInput } from '../auth/rbac';
import { readMetrics } from '../observability/metrics';
import { can } from '../auth/rbac';

/**
 * Repo administration (issue #14): members and directory-level path rules.
 * Session-authenticated and repo-admin-only — this is where monorepo security
 * is configured (e.g. deny `history` on `secrets/`).
 */
export const adminRoutes = new Hono<AppEnv>();

function requireSession(c: Parameters<typeof apiError>[0]): Response | null {
  if (!c.get('user')) {
    return apiError(c, 401, 'unauthorized', 'session required');
  }
  return null;
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

adminRoutes.get('/api/v1/repos/:repo{.+}/members', async (c) => {
  try {
    const noSession = requireSession(c);
    if (noSession) return noSession;
    const loaded = await loadAdminRepo(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const rows = await q(
      c.env,
      `SELECT * FROM ${T.repoMembers} WHERE ${C.repoMembers.repoId} = ?`,
      [loaded.repo.id],
    );
    return c.json({
      members: rows.map((r) => {
        const m = parseRepoMemberRow(r);
        return { user_id: m.user_id, role: m.role };
      }),
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

const memberSchema = z.object({
  user_id: z.string().min(1).optional(),
  user_login: z.string().min(1).optional(),
  role: z.enum(['admin', 'write', 'read']),
});

adminRoutes.put('/api/v1/repos/:repo{.+}/members', async (c) => {
  try {
    const noSession = requireSession(c);
    if (noSession) return noSession;
    const loaded = await loadAdminRepo(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;

    const body = await readJsonBody(c);
    const parsed = memberSchema.safeParse(body);
    if (!parsed.success || (!parsed.data.user_id && !parsed.data.user_login)) {
      return apiError(
        c,
        400,
        'invalid_request',
        'user_id or user_login and role are required',
      );
    }
    let userId = parsed.data.user_id ?? null;
    if (userId === null) {
      const row = await q1(c.env, `SELECT * FROM ${T.users} WHERE ${C.users.login} = ?`, [
        parsed.data.user_login as string,
      ]);
      if (!row) {
        return apiError(c, 404, 'user_not_found', `no user ${parsed.data.user_login}`);
      }
      userId = parseUserRow(row).id;
    }
    await run(
      c.env,
      `INSERT INTO ${T.repoMembers} (${C.repoMembers.repoId}, ${C.repoMembers.userId}, ${C.repoMembers.role})
       VALUES (?, ?, ?)
       ON CONFLICT (${C.repoMembers.repoId}, ${C.repoMembers.userId})
       DO UPDATE SET ${C.repoMembers.role} = excluded.${C.repoMembers.role}`,
      [loaded.repo.id, userId, parsed.data.role],
    );
    return c.json({ ok: true, user_id: userId, role: parsed.data.role });
  } catch (err) {
    return errorResponse(c, err);
  }
});

adminRoutes.delete('/api/v1/repos/:repo{.+}/members/:userId', async (c) => {
  try {
    const noSession = requireSession(c);
    if (noSession) return noSession;
    const loaded = await loadAdminRepo(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    await run(
      c.env,
      `DELETE FROM ${T.repoMembers} WHERE ${C.repoMembers.repoId} = ? AND ${C.repoMembers.userId} = ?`,
      [loaded.repo.id, c.req.param('userId')],
    );
    return c.json({ ok: true });
  } catch (err) {
    return errorResponse(c, err);
  }
});

// ---------------------------------------------------------------------------
// Metrics (issue #21) — admin scope
// ---------------------------------------------------------------------------

adminRoutes.get('/api/v1/admin/metrics', async (c) => {
  try {
    const noSession = requireSession(c);
    if (noSession) return noSession;
    // admin scope: any repo where the caller is admin gates the panel
    const principal = c.get('principal');
    const repos = await q(c.env, `SELECT * FROM ${T.repos}`);
    const isAdmin = await Promise.all(
      repos.map((row) => can(c.env, parseRepoRow(row), principal ?? null, 'admin')),
    );
    if (!isAdmin.some(Boolean)) {
      return apiError(c, 403, 'forbidden', 'admin scope required');
    }
    const component = c.req.query('component');
    const windowRaw = Number(c.req.query('window') ?? '3600000');
    const windowMs = Number.isInteger(windowRaw) && windowRaw > 0 ? windowRaw : 3600_000;
    return c.json(await readMetrics(c.env, component, windowMs), 200, {
      'cache-control': 'private, no-store',
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

// ---------------------------------------------------------------------------
// Path rules
// ---------------------------------------------------------------------------

adminRoutes.get('/api/v1/repos/:repo{.+}/path-rules', async (c) => {
  try {
    const noSession = requireSession(c);
    if (noSession) return noSession;
    const loaded = await loadAdminRepo(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const rows = await q(
      c.env,
      `SELECT * FROM ${T.pathRules} WHERE ${C.pathRules.repoId} = ?`,
      [loaded.repo.id],
    );
    return c.json({ path_rules: rows.map(parsePathRuleRow) });
  } catch (err) {
    return errorResponse(c, err);
  }
});

adminRoutes.post('/api/v1/repos/:repo{.+}/path-rules', async (c) => {
  try {
    const noSession = requireSession(c);
    if (noSession) return noSession;
    const loaded = await loadAdminRepo(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;

    const body = await readJsonBody(c);
    let rule: ReturnType<typeof parsePathRuleInput>;
    try {
      rule = parsePathRuleInput(body);
    } catch (err) {
      return apiError(
        c,
        400,
        'invalid_request',
        err instanceof Error ? err.message : 'invalid rule',
      );
    }
    // id is INTEGER AUTOINCREMENT — let SQLite assign it
    const inserted = await q1(
      c.env,
      `INSERT INTO ${T.pathRules} (${C.pathRules.repoId}, ${C.pathRules.pathPrefix}, ${C.pathRules.effect}, ${C.pathRules.principal}, ${C.pathRules.perms})
       VALUES (?, ?, ?, ?, ?) RETURNING ${C.pathRules.id}`,
      [
        loaded.repo.id,
        rule.path_prefix,
        rule.effect,
        rule.principal,
        JSON.stringify(rule.perms),
      ],
    );
    const id = (inserted as { id: number }).id;
    return c.json({ ok: true, id, rule }, 201);
  } catch (err) {
    return errorResponse(c, err);
  }
});

adminRoutes.delete('/api/v1/repos/:repo{.+}/path-rules/:id', async (c) => {
  try {
    const noSession = requireSession(c);
    if (noSession) return noSession;
    const loaded = await loadAdminRepo(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const existing = await q1(
      c.env,
      `SELECT * FROM ${T.pathRules} WHERE ${C.pathRules.id} = ? AND ${C.pathRules.repoId} = ?`,
      [c.req.param('id'), loaded.repo.id],
    );
    if (!existing) {
      return apiError(c, 404, 'rule_not_found', `no path rule ${c.req.param('id')}`);
    }
    await run(c.env, `DELETE FROM ${T.pathRules} WHERE ${C.pathRules.id} = ?`, [
      c.req.param('id'),
    ]);
    return c.json({ ok: true });
  } catch (err) {
    return errorResponse(c, err);
  }
});
