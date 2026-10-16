import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv, Principal } from '../auth/principal';
import { loadWholeRepo, requireAgentScope } from '../auth/guards';
import { can } from '../auth/rbac';
import { requireRecentMfa } from '../auth/session';
import { actorOf, recordAudit } from '../audit/record';
import { ApiError } from '../core/errors';
import { q, q1, run } from '../db/client';
import { ulid } from '../core/ids';
import {
  parsePgpPublicKey,
  parseSshPublicKey,
  signatureOf,
  sshFingerprint,
} from '../git/signatures';
import { envelopeSchema } from '../provenance/dsse';
import { provenanceKeys, verifyStatement } from '../provenance/keys';
import {
  createSession,
  createSessionSchema,
  getSession,
  linkChangesets,
  linkSessionSchema,
  sessionsFor,
  sessionView,
} from '../provenance/sessions';
import { apiError, errorResponse, readJsonBody } from './errors';

/**
 * Signed provenance (issue #58):
 *
 * GET  /.well-known/yag-provenance-keys               public keys (JWKS), no session
 * GET  /api/v1/repos/:repo/provenance?cs=&ref=        signed records, checked here
 * POST /api/v1/repos/:repo/sessions                    agent session + redacted transcript
 * GET  /api/v1/repos/:repo/sessions/:id                session metadata (readers)
 * GET  /api/v1/repos/:repo/sessions/:id/transcript     redacted transcript (writers)
 * POST /api/v1/repos/:repo/sessions/:id/link           link more changesets (its creator)
 * GET|POST /api/v1/me/signing-keys, DELETE /:id       SSH and OpenPGP commit signing keys
 *
 * Records are signed with the Ed25519 key ring in PROVENANCE_SIGNING_KEYS
 * (provenance/keys.ts); keys rotated out stay published for verification.
 */
export const provenanceRoutes = new Hono<AppEnv>();
export const provenanceKeysRoutes = new Hono<AppEnv>();

const REPO = '/repos/:repo{[^/]+/[^/]+}';

export const provenanceQuery = z.object({
  cs: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  ref: z.string().min(1).max(256).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const addSigningKeySchema = z.object({
  kind: z.enum(['ssh', 'gpg']),
  title: z.string().trim().min(1).max(100),
  public_key: z.string().trim().min(1).max(20_000),
});

interface ProvenanceRow {
  id: string;
  ref: string;
  old_cs: string | null;
  new_cs: string | null;
  via: string;
  bypass: number;
  statement: string;
  envelope: string;
  key_id: string;
  created_at: number;
}

interface KeyRow {
  id: string;
  kind: 'ssh' | 'gpg';
  title: string;
  fingerprint: string;
  key_ids: string;
  created_at: number;
}

function principalOf(c: Context<AppEnv>): Principal {
  return c.get('principal') as Principal; // `/api/*` refused anonymous callers
}

function actorKey(principal: Principal): string {
  const actor = actorOf(principal);
  return `${actor.kind}:${actor.id}`;
}

const statementShape = z.looseObject({
  subject: z.array(z.object({ digest: z.record(z.string(), z.string()) })).min(1),
});

/**
 * A stored record checked against the published keys: the signature holds,
 * and the signed statement is the stored one about the stored revision.
 */
async function checkRecord(
  c: Context<AppEnv>,
  row: ProvenanceRow,
): Promise<{ verified: boolean; reason: string | null }> {
  const envelope = envelopeSchema.safeParse(JSON.parse(row.envelope));
  if (!envelope.success) return { verified: false, reason: 'malformed envelope' };
  const check = await verifyStatement(c.env, envelope.data);
  if (!check.verified) return { verified: false, reason: check.reason };
  if (JSON.stringify(check.statement) !== row.statement)
    return { verified: false, reason: 'the signed statement differs from the record' };
  const subject = statementShape.safeParse(check.statement);
  if (
    !subject.success ||
    subject.data.subject[0]!.digest.yagChangeset !== (row.new_cs ?? row.old_cs)
  )
    return { verified: false, reason: 'the statement names another revision' };
  return { verified: true, reason: null };
}

provenanceKeysRoutes.get('/.well-known/yag-provenance-keys', async (c) => {
  try {
    return c.json({ keys: (await provenanceKeys(c.env)).published }, 200, {
      'cache-control': 'public, max-age=300',
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

provenanceRoutes.get(`${REPO}/provenance`, async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'read', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const repo = loaded.repo;
    const query = provenanceQuery.safeParse(c.req.query());
    if (!query.success)
      return apiError(c, 400, 'invalid_query', 'cs is a changeset id; limit 1 to 100');
    const { cs, ref, limit } = query.data;
    const where = ['repo_id = ?'];
    const args: (string | number)[] = [repo.id];
    // a record names its new head, and lists every changeset the move brought in
    if (cs) {
      where.push('(new_cs = ? OR instr(statement, ?) > 0)');
      args.push(cs, `"id":"${cs}"`);
    }
    if (ref) {
      where.push('ref = ?');
      args.push(ref);
    }
    const rows = await q<ProvenanceRow>(
      c.env,
      `SELECT id, ref, old_cs, new_cs, via, bypass, statement, envelope, key_id, created_at
         FROM provenance WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`,
      [...args, limit],
    );
    const records = [];
    for (const row of rows) {
      records.push({
        id: row.id,
        ref: row.ref,
        old_cs: row.old_cs,
        new_cs: row.new_cs,
        via: row.via,
        bypass: row.bypass === 1,
        key_id: row.key_id,
        created_at: row.created_at,
        ...(await checkRecord(c, row)),
        statement: JSON.parse(row.statement) as unknown,
        envelope: JSON.parse(row.envelope) as unknown,
      });
    }
    const body: Record<string, unknown> = { records };
    if (cs) {
      const writer = await can(c.env, repo, principalOf(c), 'write');
      body.signature = await signatureOf(c.env, repo.id, cs);
      body.sessions = (await sessionsFor(c.env, repo.id, cs)).map((s) => ({
        ...sessionView(s),
        // transcripts may hold customer data: writers only
        transcript_available: writer && s.transcript_key !== null,
      }));
    }
    return c.json(body, 200, { 'cache-control': 'private, no-store' });
  } catch (err) {
    return errorResponse(c, err);
  }
});

provenanceRoutes.post(`${REPO}/sessions`, async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'write', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const scoped = requireAgentScope(c, 'contents:write');
    if (scoped) return scoped;
    const repo = loaded.repo;
    const parsed = createSessionSchema.safeParse(await readJsonBody(c));
    if (!parsed.success)
      return apiError(c, 400, 'invalid_request', 'invalid session', {
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    const principal = principalOf(c);
    // the agent identity comes from the credential, never from the body
    const agent = principal.kind === 'agent' ? principal : null;
    const row = await createSession(c.env, {
      ...parsed.data,
      task_id: parsed.data.task_id ?? agent?.taskId ?? undefined,
      repo_id: repo.id,
      agent_id: agent?.agentId ?? null,
      on_behalf_of: principal.userId,
      created_by: actorKey(principal),
    });
    await recordAudit(c, {
      action: 'session.create',
      repo,
      target: {
        session_id: row.id,
        agent_id: row.agent_id,
        task_id: row.task_id,
        changesets: parsed.data.changesets,
        transcript_sha256: row.transcript_sha256,
        redactions: row.redactions,
      },
    });
    return c.json({ session: sessionView(row) }, 201);
  } catch (err) {
    return errorResponse(c, err);
  }
});

provenanceRoutes.get(`${REPO}/sessions/:id`, async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'read', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const row = await getSession(c.env, loaded.repo.id, c.req.param('id'));
    if (!row) return apiError(c, 404, 'session_not_found', 'No such session');
    const changesets = await q<{ cs_id: string }>(
      c.env,
      'SELECT cs_id FROM changeset_sessions WHERE session_id = ? ORDER BY created_at, cs_id',
      [row.id],
    );
    return c.json({
      session: sessionView(row),
      changesets: changesets.map((r) => r.cs_id),
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

provenanceRoutes.get(`${REPO}/sessions/:id/transcript`, async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'write', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const row = await getSession(c.env, loaded.repo.id, c.req.param('id'));
    if (!row) return apiError(c, 404, 'session_not_found', 'No such session');
    const object = row.transcript_key
      ? await c.env.OBJECTS.get(row.transcript_key)
      : null;
    if (!object)
      return apiError(c, 404, 'transcript_not_found', 'This session has no transcript');
    return new Response(object.body, {
      headers: {
        'content-type': 'application/jsonl; charset=utf-8',
        'x-yag-sha256': row.transcript_sha256 ?? '',
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, no-store',
      },
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

provenanceRoutes.post(`${REPO}/sessions/:id/link`, async (c) => {
  try {
    const loaded = await loadWholeRepo(c, 'write', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const scoped = requireAgentScope(c, 'contents:write');
    if (scoped) return scoped;
    const repo = loaded.repo;
    const row = await getSession(c.env, repo.id, c.req.param('id'));
    if (!row) return apiError(c, 404, 'session_not_found', 'No such session');
    const principal = principalOf(c);
    if (row.created_by !== actorKey(principal))
      return apiError(
        c,
        403,
        'not_session_owner',
        'Only the credential that recorded a session links changesets to it',
      );
    const parsed = linkSessionSchema.safeParse(await readJsonBody(c));
    if (!parsed.success)
      return apiError(c, 400, 'invalid_request', 'Send changesets: changeset ids');
    await linkChangesets(c.env, repo.id, row.id, parsed.data.changesets);
    await recordAudit(c, {
      action: 'session.link',
      repo,
      target: { session_id: row.id, changesets: parsed.data.changesets },
    });
    return c.json({ ok: true });
  } catch (err) {
    return errorResponse(c, err);
  }
});

// ---------------------------------------------------------------------------
// Commit signing keys
// ---------------------------------------------------------------------------

function keyView(row: KeyRow) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    fingerprint: row.fingerprint,
    key_ids: row.key_ids ? row.key_ids.split(' ') : [],
    created_at: row.created_at,
  };
}

/** Signing keys belong to people: managed from a signed-in session only. */
function sessionUser(c: Context<AppEnv>): string {
  const principal = principalOf(c);
  if (principal.kind !== 'user')
    throw new ApiError(
      403,
      'session_required',
      'Manage signing keys from a signed-in session',
    );
  return principal.userId;
}

provenanceRoutes.get('/me/signing-keys', async (c) => {
  try {
    const userId = sessionUser(c);
    const rows = await q<KeyRow>(
      c.env,
      `SELECT id, kind, title, fingerprint, key_ids, created_at FROM user_signing_keys
        WHERE user_id = ? ORDER BY created_at`,
      [userId],
    );
    return c.json({ keys: rows.map(keyView) }, 200, {
      'cache-control': 'private, no-store',
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

provenanceRoutes.post('/me/signing-keys', async (c) => {
  try {
    const userId = sessionUser(c);
    const mfa = await requireRecentMfa(c);
    if (mfa) return mfa;
    const parsed = addSigningKeySchema.safeParse(await readJsonBody(c));
    if (!parsed.success)
      return apiError(
        c,
        400,
        'invalid_request',
        'Send kind (ssh or gpg), title and public_key',
      );
    const input = parsed.data;
    let fingerprint: string;
    let keyIds: string[] = [];
    let publicKey = input.public_key;
    try {
      if (input.kind === 'ssh') {
        const { type, blob } = parseSshPublicKey(input.public_key);
        fingerprint = await sshFingerprint(blob);
        // the comment is the user's business; keep the key only
        publicKey = `${type} ${input.public_key.trim().split(/\s+/)[1]}`;
      } else {
        const keys = await parsePgpPublicKey(input.public_key);
        fingerprint = keys[0]!.fingerprint;
        keyIds = keys.map((k) => k.keyId);
      }
    } catch (err) {
      return apiError(
        c,
        400,
        'invalid_signing_key',
        err instanceof Error ? err.message : 'unreadable public key',
      );
    }
    const existing = await q1<{ user_id: string }>(
      c.env,
      'SELECT user_id FROM user_signing_keys WHERE kind = ? AND fingerprint = ?',
      [input.kind, fingerprint],
    );
    if (existing)
      return apiError(c, 409, 'signing_key_exists', 'This key is already registered');
    const row: KeyRow = {
      id: ulid(),
      kind: input.kind,
      title: input.title,
      fingerprint,
      key_ids: keyIds.join(' '),
      created_at: Date.now(),
    };
    await run(
      c.env,
      `INSERT INTO user_signing_keys (id, user_id, kind, title, fingerprint, key_ids,
         public_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        userId,
        row.kind,
        row.title,
        row.fingerprint,
        row.key_ids,
        publicKey,
        row.created_at,
      ],
    );
    await recordAudit(c, {
      action: 'signing_key.add',
      target: { user_id: userId, key_id: row.id, kind: row.kind, fingerprint },
    });
    return c.json({ key: keyView(row) }, 201);
  } catch (err) {
    return errorResponse(c, err);
  }
});

provenanceRoutes.delete('/me/signing-keys/:id', async (c) => {
  try {
    const userId = sessionUser(c);
    const removed = await q1<{ fingerprint: string }>(
      c.env,
      'DELETE FROM user_signing_keys WHERE id = ? AND user_id = ? RETURNING fingerprint',
      [c.req.param('id'), userId],
    );
    if (!removed) return apiError(c, 404, 'signing_key_not_found', 'No such signing key');
    await recordAudit(c, {
      action: 'signing_key.remove',
      target: {
        user_id: userId,
        key_id: c.req.param('id'),
        fingerprint: removed.fingerprint,
      },
    });
    return c.body(null, 204);
  } catch (err) {
    return errorResponse(c, err);
  }
});
