import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { apiError, errorResponse, readJsonBody } from './errors';
import { getChangeset } from '../core/changesets';
import { ConflictError } from '../core/errors';
import { lookupRevId } from '../core/read';
import {
  TAG_PREFIX,
  agentRefOwner,
  getRef,
  moveRefViaDO,
  validateRefName,
} from '../core/refs';
import { listRefsPage } from '../db/repos';
import { q, run } from '../db/client';
import {
  loadReadableRepo as loadReadable,
  loadWholeRepo,
  requireAgentScope,
} from '../auth/guards';
import { agentIdOf, type AppEnv } from '../auth/principal';
import { recordAudit } from '../audit/record';

/**
 * Ref routes (architecture §1.4, issue #33) — moves are compare-and-swap
 * through the per-ref Durable Object.
 *   GET  /api/v1/repos/:repo/refs?prefix=&cursor=&limit=
 *   GET  /api/v1/repos/:repo/refs/:name
 *   PUT  /api/v1/repos/:repo/refs/:name   {from, to, force?}
 *   GET  /api/v1/repos/:repo/tags?cursor=&limit=
 *   POST /api/v1/repos/:repo/tags         {name, target, message?, signature?}
 *
 * `:repo` is exactly `owner/name`, so ref names may contain `/refs/` too.
 */
export const refsRoutes = new Hono<AppEnv>();

const NO_STORE = 'private, no-store';
const REPO = ':repo{[^/]+/[^/]+}';

export const moveRefSchema = z.object({
  from: z.string().min(1).nullable(),
  to: z.string().min(1),
  force: z.boolean().optional(),
});

/** A `message` makes an annotated tag; a signature needs one to sign. */
export const createTagSchema = z
  .object({
    name: z.string().min(1).max(245),
    target: z.string().min(1),
    message: z.string().max(65536).optional(),
    signature: z.string().max(65536).optional(),
  })
  .refine((t) => t.signature === undefined || t.message !== undefined, {
    message: 'signed tags must be annotated',
    path: ['signature'],
  });

function invalid(c: Context, message: string, error: z.ZodError): Response {
  return apiError(c, 400, 'invalid_request', message, {
    issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  });
}

/** `?limit=&cursor=` for keyset pages over ref names. */
function pageQuery(c: Context): { limit: number; after: string } {
  const n = Number(c.req.query('limit') ?? 100);
  const limit = Number.isInteger(n) && n >= 1 ? Math.min(n, 1000) : 100;
  return { limit, after: c.req.query('cursor') ?? '' };
}

refsRoutes.get(`/repos/${REPO}/refs`, async (c) => {
  try {
    const loaded = await loadReadable(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const { limit, after } = pageQuery(c);
    const rows = await listRefsPage(c.env, loaded.repo.id, {
      prefix: c.req.query('prefix') ?? '',
      after,
      limit: limit + 1,
    });
    const page = rows.slice(0, limit);
    return c.json(
      {
        refs: page.map((r) => ({ name: r.name, head: r.head, updated_at: r.updated_at })),
        next_cursor: rows.length > limit ? (page[page.length - 1]?.name ?? null) : null,
      },
      200,
      { 'cache-control': NO_STORE },
    );
  } catch (err) {
    return errorResponse(c, err);
  }
});

refsRoutes.get(`/repos/${REPO}/refs/:name{.+}`, async (c) => {
  try {
    const loaded = await loadReadable(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const name = validateRefName(c.req.param('name'));
    const ref = await getRef(c.env, loaded.repo.id, name);
    if (!ref) {
      return apiError(c, 404, 'ref_not_found', `no ref ${name}`);
    }
    return c.json({ name: ref.name, head: ref.head, updated_at: ref.updated_at }, 200, {
      'cache-control': NO_STORE,
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

refsRoutes.put(`/repos/${REPO}/refs/:name{.+}`, async (c) => {
  try {
    // Pointing a ref at a changeset publishes every path in it (like a pull
    // request merge), so path-restricted writers cannot move refs directly.
    const loaded = await loadWholeRepo(c, 'write', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const repo = loaded.repo;
    const name = validateRefName(c.req.param('name'), repo.refs_mode ?? 'scion');

    // refs/agents/<id>/ belongs to the agent with that id (#57).
    const owner = agentRefOwner(name);
    const principal = c.get('principal');
    if (owner !== null && agentIdOf(principal) !== owner) {
      return apiError(c, 403, 'forbidden', `only agent ${owner} may write ${name}`);
    }
    // Agent tokens never move the default branch: they open a pull request.
    if (principal?.kind === 'agent' && name === repo.default_branch) {
      return apiError(
        c,
        403,
        'protected_branch',
        'agents cannot update the default branch; open a pull request',
      );
    }
    if (name.startsWith(TAG_PREFIX)) {
      const scoped = requireAgentScope(c, 'releases:write');
      if (scoped) return scoped;
    }

    const body = await readJsonBody(c);
    const parsed = moveRefSchema.safeParse(body);
    if (!parsed.success) return invalid(c, 'invalid ref move request', parsed.error);

    // Cheap 400 before the DO roundtrip: the target must exist.
    const target = await getChangeset(c.env, repo.id, parsed.data.to);
    if (!target) {
      return apiError(c, 400, 'unknown_target', `no changeset ${parsed.data.to}`, {
        to: parsed.data.to,
      });
    }

    const result = await moveRefViaDO(c.env, repo.id, name, {
      ...parsed.data,
      actor: principal,
      via: 'api',
    });
    await recordAudit(c, {
      action: 'ref.move',
      repo,
      target: {
        ref: name,
        from: result.from,
        to: result.to,
        force: parsed.data.force ?? false,
      },
    });
    return c.json(result, 200, { 'cache-control': NO_STORE });
  } catch (err) {
    return errorResponse(c, err);
  }
});

interface TagRow {
  name: string;
  tagger: string;
  message: string;
  signature: string | null;
  created_at: number;
}

refsRoutes.get(`/repos/${REPO}/tags`, async (c) => {
  try {
    const loaded = await loadReadable(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const { limit, after } = pageQuery(c);
    const rows = await listRefsPage(c.env, loaded.repo.id, {
      prefix: TAG_PREFIX,
      after: after === '' ? '' : `${TAG_PREFIX}${after}`,
      limit: limit + 1,
    });
    const page = rows
      .slice(0, limit)
      .map((r) => ({ ...r, name: r.name.slice(TAG_PREFIX.length) }));
    // Annotations for this page only: one range read on the tags primary key.
    const first = page[0]?.name;
    const last = page[page.length - 1]?.name;
    const annotated = new Map<string, TagRow>();
    if (first !== undefined && last !== undefined) {
      const tagRows = await q<TagRow>(
        c.env,
        `SELECT name, tagger, message, signature, created_at FROM tags
          WHERE repo_id = ? AND name >= ? AND name <= ?`,
        [loaded.repo.id, first, last],
      );
      for (const row of tagRows) annotated.set(row.name, row);
    }
    return c.json(
      {
        tags: page.map((r) => {
          const tag = annotated.get(r.name);
          return {
            name: r.name,
            target_cs: r.head,
            annotated: tag !== undefined,
            message: tag?.message ?? null,
            tagger: tag ? (JSON.parse(tag.tagger) as unknown) : null,
            signature: tag?.signature ?? null,
            updated_at: r.updated_at,
          };
        }),
        next_cursor: rows.length > limit ? (last ?? null) : null,
      },
      200,
      { 'cache-control': NO_STORE },
    );
  } catch (err) {
    return errorResponse(c, err);
  }
});

refsRoutes.post(`/repos/${REPO}/tags`, async (c) => {
  try {
    // A tag publishes every path in its target, like a ref move.
    const loaded = await loadWholeRepo(c, 'write', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const repo = loaded.repo;
    const scoped = requireAgentScope(c, 'releases:write');
    if (scoped) return scoped;
    const parsed = createTagSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) return invalid(c, 'invalid tag request', parsed.error);
    const input = parsed.data;
    const ref = validateRefName(`${TAG_PREFIX}${input.name}`, repo.refs_mode ?? 'scion');

    const target = await lookupRevId(c.env, repo.id, input.target);
    if (!target) {
      return apiError(c, 400, 'unknown_target', `no revision ${input.target}`, {
        target: input.target,
      });
    }
    try {
      // from: null makes the CAS the single arbiter of "tag already exists"
      await moveRefViaDO(c.env, repo.id, ref, {
        from: null,
        to: target,
        actor: c.get('principal'),
        via: 'api',
      });
    } catch (err) {
      if (err instanceof ConflictError) {
        return apiError(c, 409, 'tag_exists', `tag ${input.name} already exists`);
      }
      throw err;
    }

    const principal = c.get('principal');
    const tagger =
      principal?.kind === 'token'
        ? { agent: principal.tokenId }
        : principal?.kind === 'agent'
          ? { agent: principal.agentId }
          : { user: principal?.userId };
    const now = Date.now();
    if (input.message !== undefined) {
      await run(
        c.env,
        `INSERT OR REPLACE INTO tags (repo_id, name, target_cs, tagger, message, signature, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          repo.id,
          input.name,
          target,
          JSON.stringify(tagger),
          input.message,
          input.signature ?? null,
          now,
        ],
      );
    }
    await recordAudit(c, {
      action: 'tag.create',
      repo,
      target: {
        tag: input.name,
        target_cs: target,
        annotated: input.message !== undefined,
        signed: input.signature !== undefined,
      },
    });
    return c.json(
      {
        tag: {
          name: input.name,
          target_cs: target,
          annotated: input.message !== undefined,
          message: input.message ?? null,
          tagger: input.message !== undefined ? tagger : null,
          signature: input.signature ?? null,
          updated_at: now,
        },
      },
      201,
      { 'cache-control': NO_STORE },
    );
  } catch (err) {
    return errorResponse(c, err);
  }
});
