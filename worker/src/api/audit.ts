import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv, Principal } from '../auth/principal';
import type { Env } from '../env';
import { q, q1 } from '../db/client';
import { apiError, errorResponse } from './errors';
import { configuredSink } from '../audit/stream';
import { getOrgBySlug, orgMembership } from './orgs';

/**
 * Audit search and export (issue #65), audit admins only:
 *   GET /api/v1/orgs/:org/audit?action=&actor=&repo=&from=&to=&cursor=&limit=
 *       JSON pages newest first; `format=ndjson|csv` exports every match
 *       oldest first (the order `yag audit verify` needs)
 *   GET /api/v1/audit/stream   SIEM delivery status
 *
 * Audit admins are the user ids in `AUDIT_ADMIN_USER_IDS` (every chain and
 * the stream), plus owners and admins of an org (#26) for that org's chain.
 * Tokens also need the `audit:read` scope and must not be bound to a repo.
 */
export const auditRoutes = new Hono<AppEnv>();

export async function canReadAudit(
  env: Env,
  principal: Principal,
  orgSlug?: string,
): Promise<boolean> {
  if (
    principal.kind === 'token' &&
    (principal.repoId !== null || !principal.scopes.includes('audit:read'))
  ) {
    return false;
  }
  const admins = (env.AUDIT_ADMIN_USER_IDS ?? '').split(',').map((id) => id.trim());
  if (admins.includes(principal.userId)) return true;
  if (orgSlug === undefined) return false;
  const org = await getOrgBySlug(env, orgSlug);
  const me = org ? await orgMembership(env, org.id, principal.userId) : null;
  return me?.role === 'owner' || me?.role === 'admin';
}

async function guard(c: Context<AppEnv>, orgSlug?: string): Promise<Response | null> {
  const principal = c.get('principal');
  if (!principal) return apiError(c, 401, 'unauthorized', 'authentication required');
  if (!(await canReadAudit(c.env, principal, orgSlug))) {
    return apiError(c, 403, 'forbidden', 'audit admin required');
  }
  return null;
}

const time = z.string().transform((raw, ctx) => {
  const ms = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  if (!Number.isFinite(ms)) {
    ctx.addIssue({ code: 'custom', message: 'from/to must be epoch ms or ISO 8601' });
    return z.NEVER;
  }
  return ms;
});

export const querySchema = z.object({
  action: z.string().max(64).optional(),
  actor: z.string().max(128).optional(),
  repo: z.string().max(128).optional(),
  from: time.optional(),
  to: time.optional(),
  cursor: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  format: z.enum(['json', 'ndjson', 'csv']).default('json'),
});

const rowSchema = z.object({
  id: z.number(),
  org_id: z.string(),
  repo_id: z.string().nullable(),
  actor_kind: z.string(),
  actor_id: z.string(),
  on_behalf_of: z.string().nullable(),
  action: z.string(),
  target: z.string().transform((text): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      return text; // a tampered row still exports; verify flags it
    }
  }),
  ip: z.string().nullable(),
  user_agent: z.string().nullable(),
  request_id: z.string().nullable(),
  at: z.number(),
  prev_hash: z.string(),
  hash: z.string(),
});
type AuditRecord = z.infer<typeof rowSchema>;

const CSV_COLUMNS = [
  'id',
  'at',
  'org_id',
  'repo_id',
  'actor_kind',
  'actor_id',
  'on_behalf_of',
  'action',
  'target',
  'ip',
  'user_agent',
  'request_id',
  'prev_hash',
  'hash',
] as const;

function csvCell(value: unknown): string {
  let text =
    value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  // spreadsheet formula injection guard
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvLine(row: AuditRecord): string {
  return CSV_COLUMNS.map((column) =>
    csvCell(column === 'at' ? new Date(row.at).toISOString() : row[column]),
  ).join(',');
}

auditRoutes.get('/orgs/:org/audit', async (c) => {
  try {
    const denied = await guard(c, c.req.param('org'));
    if (denied) return denied;
    const parsed = querySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return apiError(c, 400, 'invalid_request', 'invalid audit query', {
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }
    const query = parsed.data;
    const where = ['org_id = ?'];
    const params: unknown[] = [c.req.param('org')];
    const add = (sql: string, ...values: unknown[]): void => {
      where.push(sql);
      params.push(...values);
    };
    if (query.action) add('action = ?', query.action);
    if (query.actor) add('(actor_id = ? OR on_behalf_of = ?)', query.actor, query.actor);
    if (query.repo) add('repo_id = ?', query.repo);
    if (query.from !== undefined) add('at >= ?', query.from);
    if (query.to !== undefined) add('at < ?', query.to);
    const filter = where.join(' AND ');

    if (query.format === 'json') {
      const rows = await q(
        c.env,
        `SELECT * FROM audit_events WHERE ${filter} AND id < ? ORDER BY id DESC LIMIT ?`,
        [...params, query.cursor ?? Number.MAX_SAFE_INTEGER, query.limit + 1],
      );
      const events = rows.slice(0, query.limit).map((row) => rowSchema.parse(row));
      const last = events[events.length - 1];
      return c.json(
        { events, next_cursor: rows.length > query.limit && last ? last.id : null },
        200,
        { 'cache-control': 'private, no-store' },
      );
    }

    // Exports page through every match in id order without buffering it all.
    const env = c.env;
    const csv = query.format === 'csv';
    const encoder = new TextEncoder();
    let after = 0;
    let header = csv;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const rows = await q(
          env,
          `SELECT * FROM audit_events WHERE ${filter} AND id > ? ORDER BY id LIMIT 500`,
          [...params, after],
        );
        let chunk = header ? `${CSV_COLUMNS.join(',')}\n` : '';
        header = false;
        for (const raw of rows) {
          const row = rowSchema.parse(raw);
          chunk += csv ? `${csvLine(row)}\n` : `${JSON.stringify(row)}\n`;
          after = row.id;
        }
        if (chunk) controller.enqueue(encoder.encode(chunk));
        if (rows.length < 500) controller.close();
      },
    });
    return new Response(stream, {
      headers: {
        'content-type': csv ? 'text/csv; charset=utf-8' : 'application/x-ndjson',
        'content-disposition': `attachment; filename="audit.${query.format}"`,
        'cache-control': 'private, no-store',
      },
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

auditRoutes.get('/audit/stream', async (c) => {
  try {
    const denied = await guard(c);
    if (denied) return denied;
    const sink = configuredSink(c.env);
    const state = sink
      ? await q1<{
          last_id: number;
          last_attempt_at: number | null;
          last_success_at: number | null;
          last_status: string | null;
          failures: number;
        }>(c.env, 'SELECT * FROM audit_stream_state WHERE sink = ?', [sink.name])
      : null;
    const pending = sink
      ? await q1<{ n: number }>(
          c.env,
          'SELECT COUNT(*) AS n FROM audit_events WHERE id > ?',
          [state?.last_id ?? 0],
        )
      : null;
    return c.json(
      {
        configured: sink !== null,
        sink: sink?.name ?? null,
        delivered_through: state?.last_id ?? 0,
        pending: pending?.n ?? 0,
        last_attempt_at: state?.last_attempt_at ?? null,
        last_success_at: state?.last_success_at ?? null,
        last_status: state?.last_status ?? null,
        failures: state?.failures ?? 0,
      },
      200,
      { 'cache-control': 'private, no-store' },
    );
  } catch (err) {
    return errorResponse(c, err);
  }
});
