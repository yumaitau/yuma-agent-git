import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../auth/principal';
import type { Env } from '../env';
import { loadAdminRepo, loadReadableRepo } from '../auth/guards';
import { decide } from '../auth/rbac';
import { recordAudit } from '../audit/record';
import { apiError, errorResponse } from '../api/errors';
import { storageId } from '../core/network';
import { ulid } from '../core/ids';
import { q, q1, run, type RepoRecord } from '../db/client';
import { getRepoBySlug } from '../db/repos';
import { guardAgentAction } from '../policy/guardrails';
import { loadGitRepo, type GitRefusal } from './http';

/**
 * Git LFS (issue #35), next to Git smart HTTP and with the same credentials:
 *   POST /:owner/:repo.git/info/lfs/objects/batch      download / upload, `basic`
 *   PUT  /:owner/:repo.git/info/lfs/objects/:oid       upload (signed action)
 *   GET  /:owner/:repo.git/info/lfs/objects/:oid       download (signed action)
 *   POST /:owner/:repo.git/info/lfs/verify             verify (signed action)
 *   POST|GET /:owner/:repo.git/info/lfs/locks, …/locks/verify, …/locks/:id/unlock
 *
 * Objects live in R2 at `lfs/<repo id>/<oid>`, the layout the GitHub importer
 * (#72) already writes; a fork uses its network root's id (core/network.ts),
 * so forks share objects as they share Git content. `lfs_objects` links an
 * object to each repository that uploaded (or imported) it: that row is what
 * downloads, storage accounting and quotas read.
 *
 * Transfers go through the Worker: the batch answer carries a short-lived
 * HMAC token (15 minutes, bound to the repo, operation, oid and size) in the
 * action's `Authorization` header. An upload streams into R2 with the oid as
 * its SHA-256 checksum and a fixed length, so a wrong hash or size fails the
 * write and the object is never linked.
 */
export const lfsRoutes = new Hono<AppEnv>();
/** `/api/v1` routes: storage usage and object removal. */
export const lfsApiRoutes = new Hono<AppEnv>();

const REPO = '/:owner/:repo{[^/]+\\.git}';
const LFS_JSON = 'application/vnd.git-lfs+json';
/** Signed transfer actions expire within the 15 minutes #35 allows. */
export const LFS_ACTION_TTL_S = 900;
const MAX_BATCH_OBJECTS = 1000;
const DEFAULT_REPO_QUOTA = 10 * 1024 ** 3;
const DEFAULT_ORG_QUOTA = 100 * 1024 ** 3;

const oidSchema = z.string().regex(/^[0-9a-f]{64}$/, 'oid must be a SHA-256 hex digest');

export const lfsBatchSchema = z.object({
  operation: z.enum(['download', 'upload']),
  transfers: z.array(z.string()).optional(),
  ref: z.object({ name: z.string().max(1024) }).optional(),
  objects: z
    .array(z.object({ oid: oidSchema, size: z.number().int().nonnegative() }))
    .max(MAX_BATCH_OBJECTS),
  hash_algo: z.string().optional(),
});
export const lfsVerifySchema = z.object({
  oid: oidSchema,
  size: z.number().int().nonnegative(),
});
export const lockCreateSchema = z.object({
  path: z.string().min(1).max(4096),
  ref: z.object({ name: z.string().max(1024) }).optional(),
});
export const lockVerifySchema = z.object({
  cursor: z.string().optional(),
  limit: z.int().min(1).optional(),
  ref: z.object({ name: z.string().max(1024) }).optional(),
});
export const unlockSchema = z.object({ force: z.boolean().optional() });

function lfsJson(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': LFS_JSON, 'cache-control': 'no-store', ...headers },
  });
}

/** LFS clients print `message`; the API envelope rides along for tools. */
function lfsError(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response {
  return lfsJson({ message, error: { code, message, ...extra } }, status, headers);
}

function lfsRefuser(r: GitRefusal): Response {
  switch (r.kind) {
    case 'unauthorized':
      return lfsError(
        401,
        'unauthorized',
        r.message,
        {},
        {
          'www-authenticate': 'Basic realm="yuma-agent-git", charset="UTF-8"',
          'lfs-authenticate': 'Basic realm="yuma-agent-git", charset="UTF-8"',
        },
      );
    case 'not_found':
      return lfsError(404, 'repo_not_found', r.message);
    case 'forbidden':
      return lfsError(403, 'forbidden', r.message, {
        ...(r.deniedBy ? { denied_by: r.deniedBy } : {}),
      });
    default:
      return lfsError(403, r.kind, r.message);
  }
}

async function readJson(c: Context<AppEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// signed transfer actions

type Op = 'upload' | 'download' | 'verify';

async function hmacKey(env: Env, usage: 'sign' | 'verify'): Promise<CryptoKey | null> {
  if (!env.CACHE_SIGNING_KEY) return null;
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`lfs-actions:${env.CACHE_SIGNING_KEY}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage],
  );
}

function claim(
  op: Op,
  repoId: string,
  oid: string,
  size: number,
  exp: number,
): Uint8Array {
  return new TextEncoder().encode(`${op}\n${repoId}\n${oid}\n${size}\n${exp}`);
}

const hex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function signAction(
  env: Env,
  op: Op,
  repoId: string,
  oid: string,
  size: number,
  now = Date.now(),
): Promise<string | null> {
  const key = await hmacKey(env, 'sign');
  if (!key) return null;
  const exp = Math.floor(now / 1000) + LFS_ACTION_TTL_S;
  const mac = await crypto.subtle.sign('HMAC', key, claim(op, repoId, oid, size, exp));
  return `${exp}.${size}.${hex(mac)}`;
}

/** The size the token was signed for, or null when it is invalid or expired. */
async function verifyAction(
  c: Context<AppEnv>,
  op: Op,
  repoId: string,
  oid: string,
): Promise<number | null> {
  const header = c.req.header('authorization') ?? '';
  const m = /^RemoteAuth (\d+)\.(\d+)\.([0-9a-f]{64})$/.exec(header);
  if (!m) return null;
  const exp = Number(m[1]);
  const size = Number(m[2]);
  if (exp * 1000 < Date.now()) return null;
  const key = await hmacKey(c.env, 'verify');
  if (!key) return null;
  const mac = Uint8Array.from((m[3] as string).match(/../g) ?? [], (b) =>
    parseInt(b, 16),
  );
  const ok = await crypto.subtle.verify(
    'HMAC',
    key,
    mac,
    claim(op, repoId, oid, size, exp),
  );
  return ok ? size : null;
}

function action(c: Context<AppEnv>, path: string, token: string) {
  const base = `${new URL(c.req.url).origin}/${c.req.param('owner')}/${c.req.param('repo')}`;
  return {
    href: `${base}/info/lfs/${path}`,
    header: { Authorization: `RemoteAuth ${token}` },
    expires_in: LFS_ACTION_TTL_S,
  };
}

// ---------------------------------------------------------------------------
// storage

export function lfsKey(repoId: string, oid: string): string {
  return `lfs/${storageId(repoId)}/${oid}`;
}

/** Repos in `repoId`'s fork network, as a WHERE fragment binding the root id. */
const IN_NETWORK = "(repo_id = ? OR repo_id LIKE ? || '~%')";

async function networkObjects(
  env: Env,
  repoId: string,
  oids: string[],
): Promise<Map<string, { size: number; here: boolean }>> {
  const root = storageId(repoId);
  const rows = await q<{ oid: string; size: number; repo_id: string }>(
    env,
    `SELECT oid, size, repo_id FROM lfs_objects
      WHERE status = 'stored' AND ${IN_NETWORK}
        AND oid IN (SELECT value FROM json_each(?))`,
    [root, root, JSON.stringify(oids)],
  );
  const found = new Map<string, { size: number; here: boolean }>();
  for (const row of rows) {
    const here = row.repo_id === repoId || found.get(row.oid)?.here === true;
    found.set(row.oid, { size: row.size, here });
  }
  return found;
}

async function link(env: Env, repoId: string, oid: string, size: number): Promise<void> {
  await run(
    env,
    `INSERT INTO lfs_objects (repo_id, oid, size, status, updated_at)
     VALUES (?, ?, ?, 'stored', ?)
     ON CONFLICT (repo_id, oid) DO UPDATE SET size = excluded.size,
       status = 'stored', updated_at = excluded.updated_at`,
    [repoId, oid, size, Date.now()],
  );
}

function quotaOf(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return raw && Number.isFinite(n) && n >= 0 ? n : fallback;
}

export interface LfsUsage {
  objects: number;
  bytes: number;
  quota_bytes: number;
  org: { bytes: number; quota_bytes: number } | null;
}

/** Stored LFS bytes for a repo, and for its org when org-owned. */
export async function lfsUsage(env: Env, repo: RepoRecord): Promise<LfsUsage> {
  const own = await q1<{ objects: number; bytes: number | null }>(
    env,
    `SELECT COUNT(*) AS objects, SUM(size) AS bytes FROM lfs_objects
      WHERE repo_id = ? AND status = 'stored'`,
    [repo.id],
  );
  let org: LfsUsage['org'] = null;
  if (repo.owner_kind === 'org' && repo.owner_id) {
    const row = await q1<{ bytes: number | null }>(
      env,
      `SELECT SUM(l.size) AS bytes FROM lfs_objects l JOIN repos r ON r.id = l.repo_id
        WHERE r.owner_kind = 'org' AND r.owner_id = ? AND l.status = 'stored'`,
      [repo.owner_id],
    );
    org = {
      bytes: row?.bytes ?? 0,
      quota_bytes: quotaOf(env.LFS_ORG_QUOTA_BYTES, DEFAULT_ORG_QUOTA),
    };
  }
  return {
    objects: own?.objects ?? 0,
    bytes: own?.bytes ?? 0,
    quota_bytes: quotaOf(env.LFS_REPO_QUOTA_BYTES, DEFAULT_REPO_QUOTA),
    org,
  };
}

// ---------------------------------------------------------------------------
// batch API

lfsRoutes.post(`${REPO}/info/lfs/objects/batch`, async (c) => {
  try {
    const parsed = lfsBatchSchema.safeParse(await readJson(c));
    if (!parsed.success)
      return lfsError(422, 'invalid_request', 'invalid LFS batch request', {
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    const body = parsed.data;
    const upload = body.operation === 'upload';
    const loaded = await loadGitRepo(c, upload ? 'write' : 'read', lfsRefuser);
    if (!loaded.ok) return loaded.response;
    const { repo, principal } = loaded;
    if (body.hash_algo !== undefined && body.hash_algo !== 'sha256')
      return lfsError(409, 'unsupported_hash', 'only sha256 objects are supported');
    if (body.transfers && !body.transfers.includes('basic'))
      return lfsError(
        422,
        'unsupported_transfer',
        'only the basic transfer is supported',
      );
    if (!c.env.CACHE_SIGNING_KEY)
      return lfsError(503, 'lfs_unavailable', 'Git LFS is not configured on this server');

    const oids = [...new Set(body.objects.map((o) => o.oid))];
    const known = await networkObjects(c.env, repo.id, oids);
    if (upload) {
      // agent guardrails (#62): the kill switch and policy judge uploads as pushes
      const guard = await guardAgentAction(
        c.env,
        principal,
        repo,
        { action: 'push', ...(body.ref ? { ref: body.ref.name } : {}) },
        {
          exact: { lfs_upload: oids },
          summary: { lfs_objects: oids.length },
        },
      );
      if (guard.outcome !== 'allow') return lfsError(403, guard.code, guard.message);
      const adding = body.objects
        .filter((o) => !known.get(o.oid)?.here)
        .reduce((sum, o) => sum + o.size, 0);
      const usage = await lfsUsage(c.env, repo);
      if (
        adding > 0 &&
        (usage.bytes + adding > usage.quota_bytes ||
          (usage.org !== null && usage.org.bytes + adding > usage.org.quota_bytes))
      )
        return lfsError(
          507,
          'lfs_quota_exceeded',
          'This upload would exceed the Git LFS storage quota.',
          { usage, requested_bytes: adding },
        );
    }

    const objects = [];
    for (const { oid, size } of body.objects) {
      const stored = known.get(oid);
      if (stored && stored.size !== size) {
        objects.push({
          oid,
          size,
          error: { code: 422, message: 'size does not match the stored object' },
        });
        continue;
      }
      if (!upload) {
        const token = stored && (await signAction(c.env, 'download', repo.id, oid, size));
        objects.push(
          token
            ? {
                oid,
                size,
                authenticated: true,
                actions: { download: action(c, `objects/${oid}`, token) },
              }
            : { oid, size, error: { code: 404, message: 'object not found' } },
        );
        continue;
      }
      if (stored) {
        // already in this network's storage: link it, nothing to send
        if (!stored.here) await link(c.env, repo.id, oid, size);
        objects.push({ oid, size, authenticated: true });
        continue;
      }
      const put = await signAction(c.env, 'upload', repo.id, oid, size);
      const verify = await signAction(c.env, 'verify', repo.id, oid, size);
      objects.push({
        oid,
        size,
        authenticated: true,
        actions: {
          upload: action(c, `objects/${oid}`, put as string),
          verify: action(c, 'verify', verify as string),
        },
      });
    }
    return lfsJson({ transfer: 'basic', objects, hash_algo: 'sha256' });
  } catch (err) {
    return errorResponse(c, err);
  }
});

// ---------------------------------------------------------------------------
// transfers (signed; no session or token)

async function repoOf(c: Context<AppEnv>): Promise<RepoRecord | null> {
  const slug = `${c.req.param('owner')}/${(c.req.param('repo') ?? '').slice(0, -'.git'.length)}`;
  return getRepoBySlug(c.env, slug);
}

const badAction = (): Response =>
  lfsError(401, 'invalid_action', 'the transfer action is invalid or expired; retry');

lfsRoutes.put(`${REPO}/info/lfs/objects/:oid`, async (c) => {
  try {
    const oid = c.req.param('oid');
    const repo = await repoOf(c);
    const size =
      repo && oidSchema.safeParse(oid).success
        ? await verifyAction(c, 'upload', repo.id, oid)
        : null;
    if (!repo || size === null) return badAction();
    const length = c.req.header('content-length');
    if (length !== undefined && Number(length) !== size)
      return lfsError(422, 'size_mismatch', `expected ${size} bytes`);
    const body = (c.req.raw.body ?? new Blob([]).stream()).pipeThrough(
      new FixedLengthStream(size),
    );
    try {
      // R2 checks the SHA-256 and the fixed length: a mismatch writes nothing
      await c.env.OBJECTS.put(lfsKey(repo.id, oid), body, { sha256: oid });
    } catch {
      return lfsError(
        422,
        'object_mismatch',
        'the uploaded bytes do not match the object id and size',
      );
    }
    await link(c.env, repo.id, oid, size);
    return new Response(null, { status: 200 });
  } catch (err) {
    return errorResponse(c, err);
  }
});

lfsRoutes.get(`${REPO}/info/lfs/objects/:oid`, async (c) => {
  try {
    const oid = c.req.param('oid');
    const repo = await repoOf(c);
    const size =
      repo && oidSchema.safeParse(oid).success
        ? await verifyAction(c, 'download', repo.id, oid)
        : null;
    if (!repo || size === null) return badAction();
    const object = await c.env.OBJECTS.get(lfsKey(repo.id, oid));
    if (!object) return lfsError(404, 'object_not_found', 'object not found');
    return new Response(object.body, {
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(object.size),
        'cache-control': 'private, no-store',
      },
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

lfsRoutes.post(`${REPO}/info/lfs/verify`, async (c) => {
  try {
    const parsed = lfsVerifySchema.safeParse(await readJson(c));
    const repo = await repoOf(c);
    if (!parsed.success || !repo) return badAction();
    const size = await verifyAction(c, 'verify', repo.id, parsed.data.oid);
    if (size === null || size !== parsed.data.size) return badAction();
    const row = await q1<{ size: number }>(
      c.env,
      "SELECT size FROM lfs_objects WHERE repo_id = ? AND oid = ? AND status = 'stored'",
      [repo.id, parsed.data.oid],
    );
    if (!row || row.size !== size)
      return lfsError(422, 'object_not_stored', 'the object was not stored');
    return lfsJson({});
  } catch (err) {
    return errorResponse(c, err);
  }
});

// ---------------------------------------------------------------------------
// locks (git lfs lock / unlock / locks)

interface LockRow {
  id: string;
  path: string;
  owner_id: string;
  login: string | null;
  created_at: number;
}

const LOCK_SELECT = `SELECT l.id, l.path, l.owner_id, u.login, l.created_at
  FROM lfs_locks l LEFT JOIN users u ON u.id = l.owner_id`;

function lockOf(row: LockRow) {
  return {
    id: row.id,
    path: row.path,
    locked_at: new Date(row.created_at).toISOString(),
    owner: { name: row.login ?? row.owner_id },
  };
}

lfsRoutes.post(`${REPO}/info/lfs/locks`, async (c) => {
  try {
    const loaded = await loadGitRepo(c, 'write', lfsRefuser);
    if (!loaded.ok) return loaded.response;
    const parsed = lockCreateSchema.safeParse(await readJson(c));
    if (!parsed.success) return lfsError(422, 'invalid_request', 'path is required');
    const { repo, principal } = loaded;
    const existing = await q1<LockRow>(
      c.env,
      `${LOCK_SELECT} WHERE l.repo_id = ? AND l.path = ?`,
      [repo.id, parsed.data.path],
    );
    if (existing)
      return lfsJson({ lock: lockOf(existing), message: 'already created lock' }, 409);
    const id = ulid();
    await run(
      c.env,
      `INSERT INTO lfs_locks (id, repo_id, path, owner_id, ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        id,
        repo.id,
        parsed.data.path,
        principal.userId,
        parsed.data.ref?.name ?? null,
        Date.now(),
      ],
    );
    const row = await q1<LockRow>(c.env, `${LOCK_SELECT} WHERE l.id = ?`, [id]);
    await recordAudit(c, {
      action: 'lfs.lock',
      repo,
      target: { lock_id: id, path: parsed.data.path },
    });
    return lfsJson({ lock: lockOf(row as LockRow) }, 201);
  } catch (err) {
    return errorResponse(c, err);
  }
});

function pageOf(raw: unknown): number {
  const n = Number(raw ?? 100);
  return Number.isInteger(n) && n > 0 ? Math.min(n, 1000) : 100;
}

lfsRoutes.get(`${REPO}/info/lfs/locks`, async (c) => {
  try {
    const loaded = await loadGitRepo(c, 'read', lfsRefuser);
    if (!loaded.ok) return loaded.response;
    const limit = pageOf(c.req.query('limit'));
    const path = c.req.query('path');
    const id = c.req.query('id');
    const rows = await q<LockRow>(
      c.env,
      `${LOCK_SELECT} WHERE l.repo_id = ? AND l.id > ?
         AND (? IS NULL OR l.path = ?) AND (? IS NULL OR l.id = ?)
       ORDER BY l.id LIMIT ?`,
      [
        loaded.repo.id,
        c.req.query('cursor') ?? '',
        path ?? null,
        path ?? null,
        id ?? null,
        id ?? null,
        limit + 1,
      ],
    );
    const page = rows.slice(0, limit);
    return lfsJson({
      locks: page.map(lockOf),
      ...(rows.length > limit ? { next_cursor: page[page.length - 1]?.id } : {}),
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

lfsRoutes.post(`${REPO}/info/lfs/locks/verify`, async (c) => {
  try {
    const loaded = await loadGitRepo(c, 'write', lfsRefuser);
    if (!loaded.ok) return loaded.response;
    const parsed = lockVerifySchema.safeParse((await readJson(c)) ?? {});
    if (!parsed.success) return lfsError(422, 'invalid_request', 'invalid lock query');
    const body = parsed.data;
    const limit = pageOf(body.limit);
    const rows = await q<LockRow>(
      c.env,
      `${LOCK_SELECT} WHERE l.repo_id = ? AND l.id > ? ORDER BY l.id LIMIT ?`,
      [loaded.repo.id, body.cursor ?? '', limit + 1],
    );
    const page = rows.slice(0, limit);
    const me = loaded.principal.userId;
    return lfsJson({
      ours: page.filter((r) => r.owner_id === me).map(lockOf),
      theirs: page.filter((r) => r.owner_id !== me).map(lockOf),
      ...(rows.length > limit ? { next_cursor: page[page.length - 1]?.id } : {}),
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

lfsRoutes.post(`${REPO}/info/lfs/locks/:id/unlock`, async (c) => {
  try {
    const loaded = await loadGitRepo(c, 'write', lfsRefuser);
    if (!loaded.ok) return loaded.response;
    const { repo, principal } = loaded;
    const parsed = unlockSchema.safeParse((await readJson(c)) ?? {});
    if (!parsed.success)
      return lfsError(422, 'invalid_request', 'force must be a boolean');
    const row = await q1<LockRow>(
      c.env,
      `${LOCK_SELECT} WHERE l.repo_id = ? AND l.id = ?`,
      [repo.id, c.req.param('id')],
    );
    if (!row) return lfsError(404, 'lock_not_found', 'lock not found');
    const forced = row.owner_id !== principal.userId;
    if (forced) {
      // someone else's lock: only an admin, and only when asked to force
      const admin = await decide(c.env, repo, principal, 'admin');
      if (parsed.data.force !== true || !admin.allowed)
        return lfsError(403, 'forbidden', 'the lock belongs to someone else', {
          ...(admin.deniedBy ? { denied_by: admin.deniedBy } : {}),
        });
    }
    await run(c.env, 'DELETE FROM lfs_locks WHERE id = ?', [row.id]);
    await recordAudit(c, {
      action: 'lfs.unlock',
      repo,
      target: { lock_id: row.id, path: row.path, forced },
    });
    return lfsJson({ lock: lockOf(row) });
  } catch (err) {
    return errorResponse(c, err);
  }
});

// ---------------------------------------------------------------------------
// REST: usage and removal

lfsApiRoutes.get('/repos/:repo{.+}/lfs', async (c) => {
  try {
    const loaded = await loadReadableRepo(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    return c.json(await lfsUsage(c.env, loaded.repo));
  } catch (err) {
    return errorResponse(c, err);
  }
});

/**
 * Unlink an object from the repo. Storage is freed once no repository in the
 * fork network links it; pointers in history then fail to download.
 */
lfsApiRoutes.delete('/repos/:repo{.+}/lfs/objects/:oid', async (c) => {
  try {
    const loaded = await loadAdminRepo(c, c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const repo = loaded.repo;
    const oid = c.req.param('oid');
    const row = await q1<{ size: number }>(
      c.env,
      "SELECT size FROM lfs_objects WHERE repo_id = ? AND oid = ? AND status = 'stored'",
      [repo.id, oid],
    );
    if (!row) return apiError(c, 404, 'object_not_found', 'no such LFS object');
    await run(c.env, 'DELETE FROM lfs_objects WHERE repo_id = ? AND oid = ?', [
      repo.id,
      oid,
    ]);
    const root = storageId(repo.id);
    const elsewhere = await q1(
      c.env,
      `SELECT 1 FROM lfs_objects WHERE ${IN_NETWORK} AND oid = ? AND status = 'stored' LIMIT 1`,
      [root, root, oid],
    );
    if (!elsewhere) await c.env.OBJECTS.delete(lfsKey(repo.id, oid));
    await recordAudit(c, {
      action: 'lfs.object.delete',
      repo,
      target: { oid, size: row.size, freed: !elsewhere },
    });
    return c.json({ deleted: true, freed: !elsewhere });
  } catch (err) {
    return errorResponse(c, err);
  }
});
