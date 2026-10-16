import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../auth/principal';
import { loadWholeRepo } from '../auth/guards';
import { requireRecentMfa } from '../auth/session';
import { canManageOwner, parseBody, requireOrgSso, sessionUser } from '../auth/owners';
import { q, q1 } from '../db/client';
import { getRepo } from '../db/repos';
import { ApiError } from '../core/errors';
import { ulid } from '../core/ids';
import { randomB64url } from '../auth/encoding';
import { recordAudit } from '../audit/record';
import { encryptSecret } from '../secrets/crypto';
import { keyOwnerOf } from '../secrets/store';
import { WEBHOOK_EVENTS, parseEvents } from '../webhooks/events';
import { GITHUB_EVENTS } from '../webhooks/payloads';
import {
  deliveryRowSchema,
  hookAad,
  hookRowSchema,
  redeliver,
  webhookUrlProblem,
  type HookRow,
} from '../webhooks/deliver';
import { apiError, errorResponse, readJsonBody } from './errors';
import { getOrgBySlug, orgMembership } from './orgs';

/**
 * Outbound webhooks (issue #75).
 *
 *   GET|POST /repos/:repo/hooks       repo admins (whole repository)
 *   GET|POST /orgs/:org/hooks         org owners, with the org's SSO
 *   GET|PATCH|DELETE /hooks/:id       whoever manages its repo, org or app
 *   GET  /hooks/:id/deliveries        the delivery log, newest first
 *   POST /hooks/:id/deliveries/:delivery/redeliver
 *
 * Every route needs a browser session, so API, agent and app tokens can never
 * read or redirect a hook; creating or changing one also needs a recent MFA
 * step-up when the user has a factor. Secrets are encrypted with the #50
 * envelope keys and never returned, except a generated one, once, at creation.
 * A hook that cannot be managed is a 404, like a missing one.
 */
export const hooksRoutes = new Hono<AppEnv>();

export const hookInputSchema = z.object({
  url: z.string().min(1).max(2048),
  /** Omit to have one generated and returned once. */
  secret: z.string().min(16).max(256).optional(),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).max(WEBHOOK_EVENTS.length),
  format: z.enum(['yag', 'github']).default('yag'),
  active: z.boolean().default(true),
});
export type HookInput = z.infer<typeof hookInputSchema>;
export const hookPatchSchema = z.object({
  url: z.string().min(1).max(2048).optional(),
  secret: z.string().min(16).max(256).optional(),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).max(WEBHOOK_EVENTS.length).optional(),
  format: z.enum(['yag', 'github']).optional(),
  active: z.boolean().optional(),
});

function checkHook(
  c: Context<AppEnv>,
  url: string,
  events: string[],
  format: string,
): void {
  const problem = webhookUrlProblem(c.env, url);
  if (problem) throw new ApiError(400, 'invalid_webhook_url', problem);
  const unsupported =
    format === 'github' ? events.find((e) => !GITHUB_EVENTS.has(e)) : undefined;
  if (unsupported)
    throw new ApiError(
      400,
      'unsupported_event',
      `${unsupported} has no GitHub format; use the yag format`,
    );
}

/** Audit targets name the host only: hook URLs often carry a token in the path. */
const hostOf = (url: string): string => new URL(url).host;

export function publicHook(hook: HookRow) {
  return {
    id: hook.id,
    scope: hook.scope,
    owner_id: hook.owner_id,
    url: hook.url,
    events: parseEvents(hook.events),
    format: hook.format,
    active: hook.active === 1,
    created_by: hook.created_by,
    created_at: hook.created_at,
    updated_at: hook.updated_at,
  };
}

/** Where a hook's audit events go. */
type AuditWhere = { repo?: { id: string; slug: string }; orgId?: string };

/** Create a hook with an encrypted secret; returns it and a generated secret. */
export async function createHook(
  c: Context<AppEnv>,
  owner: { scope: HookRow['scope']; id: string; keyOwner: string },
  input: HookInput,
  where: AuditWhere,
): Promise<{ hook: ReturnType<typeof publicHook>; secret?: string }> {
  checkHook(c, input.url, input.events, input.format);
  const now = Date.now();
  const id = `hook_${ulid(now)}`;
  const secret = input.secret ?? randomB64url(32);
  const sealed = await encryptSecret(c.env, owner.keyOwner, hookAad(id), secret);
  const row: HookRow = {
    id,
    scope: owner.scope,
    owner_id: owner.id,
    url: input.url,
    secret_ciphertext: sealed.ciphertext,
    key_owner: owner.keyOwner,
    key_version: sealed.keyVersion,
    events: JSON.stringify(input.events),
    format: input.format,
    active: input.active ? 1 : 0,
    created_by: sessionUser(c),
    created_at: now,
    updated_at: now,
  };
  await recordAudit(
    c,
    {
      action: 'webhook.create',
      ...where,
      target: {
        hook_id: id,
        scope: row.scope,
        host: hostOf(row.url),
        events: input.events,
      },
    },
    [
      c.env.DB.prepare(
        `INSERT INTO webhooks (id, scope, owner_id, url, secret_ciphertext, key_owner, key_version,
                               events, format, active, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        row.id,
        row.scope,
        row.owner_id,
        row.url,
        row.secret_ciphertext,
        row.key_owner,
        row.key_version,
        row.events,
        row.format,
        row.active,
        row.created_by,
        row.created_at,
        row.updated_at,
      ),
    ],
  );
  return {
    hook: publicHook(row),
    ...(input.secret === undefined ? { secret } : {}),
  };
}

/** The org named in the path, for its owners only (404 for non-members). */
async function loadOwnedOrg(c: Context<AppEnv>) {
  const userId = sessionUser(c);
  const org = await getOrgBySlug(c.env, c.req.param('org') ?? '');
  const me = org ? await orgMembership(c.env, org.id, userId) : null;
  if (!org || !me) throw new ApiError(404, 'org_not_found', 'Organisation not found');
  if (me.role !== 'owner')
    throw new ApiError(403, 'forbidden', 'org owner role required');
  await requireOrgSso(c, org.id);
  return org;
}

/** The hook in the path when the caller manages its owner, else a 404. */
async function loadHook(
  c: Context<AppEnv>,
): Promise<
  { ok: true; hook: HookRow; where: AuditWhere } | { ok: false; response: Response }
> {
  const userId = sessionUser(c);
  const notFound = {
    ok: false as const,
    response: apiError(c, 404, 'hook_not_found', 'Webhook not found'),
  };
  const row = await q1(c.env, 'SELECT * FROM webhooks WHERE id = ?', [c.req.param('id')]);
  if (!row) return notFound;
  const hook = hookRowSchema.parse(row);
  if (hook.scope === 'repo') {
    const repo = await getRepo(c.env, hook.owner_id);
    if (!repo) return notFound;
    const loaded = await loadWholeRepo(c, 'admin', repo.slug);
    if (!loaded.ok) return loaded;
    return { ok: true, hook, where: { repo } };
  }
  if (hook.scope === 'org') {
    const org = await q1<{ id: string; slug: string }>(
      c.env,
      'SELECT id, slug FROM orgs WHERE id = ?',
      [hook.owner_id],
    );
    const me = org ? await orgMembership(c.env, org.id, userId) : null;
    if (!org || me?.role !== 'owner') return notFound;
    await requireOrgSso(c, org.id);
    return { ok: true, hook, where: { orgId: org.slug } };
  }
  const app = await q1<{ owner_kind: 'user' | 'org'; owner_id: string }>(
    c.env,
    'SELECT owner_kind, owner_id FROM apps WHERE id = ?',
    [hook.owner_id],
  );
  const managed = app ? await canManageOwner(c.env, app, userId) : null;
  if (!app || !managed) return notFound;
  if (app.owner_kind === 'org') await requireOrgSso(c, app.owner_id);
  return { ok: true, hook, where: { orgId: managed.auditOrg } };
}

async function hooksOf(c: Context<AppEnv>, scope: string, ownerId: string) {
  const rows = await q(
    c.env,
    'SELECT * FROM webhooks WHERE scope = ? AND owner_id = ? ORDER BY created_at',
    [scope, ownerId],
  );
  return c.json({ hooks: rows.map((r) => publicHook(hookRowSchema.parse(r))) }, 200, {
    'cache-control': 'private, no-store',
  });
}

hooksRoutes.get('/repos/:repo{.+}/hooks', async (c) => {
  try {
    sessionUser(c);
    const loaded = await loadWholeRepo(c, 'admin', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    return await hooksOf(c, 'repo', loaded.repo.id);
  } catch (err) {
    return errorResponse(c, err);
  }
});

hooksRoutes.post('/repos/:repo{.+}/hooks', async (c) => {
  try {
    sessionUser(c);
    const loaded = await loadWholeRepo(c, 'admin', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const mfa = await requireRecentMfa(c);
    if (mfa) return mfa;
    const input = parseBody(hookInputSchema, await readJsonBody(c));
    const repo = loaded.repo;
    return c.json(
      await createHook(
        c,
        { scope: 'repo', id: repo.id, keyOwner: keyOwnerOf(repo) },
        input,
        {
          repo,
        },
      ),
      201,
    );
  } catch (err) {
    return errorResponse(c, err);
  }
});

hooksRoutes.get('/orgs/:org/hooks', async (c) => {
  try {
    const org = await loadOwnedOrg(c);
    return await hooksOf(c, 'org', org.id);
  } catch (err) {
    return errorResponse(c, err);
  }
});

hooksRoutes.post('/orgs/:org/hooks', async (c) => {
  try {
    const org = await loadOwnedOrg(c);
    const mfa = await requireRecentMfa(c);
    if (mfa) return mfa;
    const input = parseBody(hookInputSchema, await readJsonBody(c));
    return c.json(
      await createHook(
        c,
        { scope: 'org', id: org.id, keyOwner: `org:${org.id}` },
        input,
        {
          orgId: org.slug,
        },
      ),
      201,
    );
  } catch (err) {
    return errorResponse(c, err);
  }
});

hooksRoutes.get('/hooks/:id', async (c) => {
  try {
    const loaded = await loadHook(c);
    if (!loaded.ok) return loaded.response;
    return c.json({ hook: publicHook(loaded.hook) }, 200, {
      'cache-control': 'private, no-store',
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

hooksRoutes.patch('/hooks/:id', async (c) => {
  try {
    const loaded = await loadHook(c);
    if (!loaded.ok) return loaded.response;
    const mfa = await requireRecentMfa(c);
    if (mfa) return mfa;
    const input = parseBody(hookPatchSchema, await readJsonBody(c));
    const hook = { ...loaded.hook };
    if (input.url !== undefined) hook.url = input.url;
    if (input.events !== undefined) hook.events = JSON.stringify(input.events);
    if (input.format !== undefined) hook.format = input.format;
    if (input.active !== undefined) hook.active = input.active ? 1 : 0;
    checkHook(c, hook.url, parseEvents(hook.events), hook.format);
    if (input.secret !== undefined) {
      const sealed = await encryptSecret(
        c.env,
        hook.key_owner,
        hookAad(hook.id),
        input.secret,
      );
      hook.secret_ciphertext = sealed.ciphertext;
      hook.key_version = sealed.keyVersion;
    }
    hook.updated_at = Date.now();
    await recordAudit(
      c,
      {
        action: 'webhook.update',
        ...loaded.where,
        target: { hook_id: hook.id, fields: Object.keys(input), host: hostOf(hook.url) },
      },
      [
        c.env.DB.prepare(
          `UPDATE webhooks SET url = ?, secret_ciphertext = ?, key_version = ?, events = ?,
                  format = ?, active = ?, updated_at = ? WHERE id = ?`,
        ).bind(
          hook.url,
          hook.secret_ciphertext,
          hook.key_version,
          hook.events,
          hook.format,
          hook.active,
          hook.updated_at,
          hook.id,
        ),
      ],
    );
    return c.json({ hook: publicHook(hook) });
  } catch (err) {
    return errorResponse(c, err);
  }
});

hooksRoutes.delete('/hooks/:id', async (c) => {
  try {
    const loaded = await loadHook(c);
    if (!loaded.ok) return loaded.response;
    const { hook } = loaded;
    await recordAudit(
      c,
      {
        action: 'webhook.delete',
        ...loaded.where,
        target: { hook_id: hook.id, host: hostOf(hook.url) },
      },
      [
        c.env.DB.prepare('DELETE FROM webhooks WHERE id = ?').bind(hook.id),
        c.env.DB.prepare('DELETE FROM webhook_deliveries_out WHERE webhook_id = ?').bind(
          hook.id,
        ),
      ],
    );
    return c.json({ ok: true });
  } catch (err) {
    return errorResponse(c, err);
  }
});

hooksRoutes.get('/hooks/:id/deliveries', async (c) => {
  try {
    const loaded = await loadHook(c);
    if (!loaded.ok) return loaded.response;
    const rows = await q(
      c.env,
      `SELECT * FROM webhook_deliveries_out WHERE webhook_id = ?
        ORDER BY created_at DESC, id DESC LIMIT 50`,
      [loaded.hook.id],
    );
    return c.json(
      {
        deliveries: rows.map((r) => {
          const { payload: _, ...rest } = deliveryRowSchema.parse(r);
          return rest;
        }),
      },
      200,
      { 'cache-control': 'private, no-store' },
    );
  } catch (err) {
    return errorResponse(c, err);
  }
});

hooksRoutes.post('/hooks/:id/deliveries/:delivery/redeliver', async (c) => {
  try {
    const loaded = await loadHook(c);
    if (!loaded.ok) return loaded.response;
    const row = await q1(
      c.env,
      'SELECT * FROM webhook_deliveries_out WHERE id = ? AND webhook_id = ?',
      [c.req.param('delivery'), loaded.hook.id],
    );
    if (!row) return apiError(c, 404, 'delivery_not_found', 'Delivery not found');
    const { payload: _, ...delivery } = await redeliver(
      c.env,
      deliveryRowSchema.parse(row),
    );
    await recordAudit(c, {
      action: 'webhook.redeliver',
      ...loaded.where,
      target: {
        hook_id: loaded.hook.id,
        delivery_id: delivery.id,
        redelivery_of: row['id'],
      },
    });
    return c.json({ delivery }, 202);
  } catch (err) {
    return errorResponse(c, err);
  }
});
