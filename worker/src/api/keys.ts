import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Env } from '../env';
import type { AppEnv, Principal } from '../auth/principal';
import { loadWholeRepo } from '../auth/guards';
import { decide } from '../auth/rbac';
import { requireRecentMfa } from '../auth/session';
import { ssoMessage } from '../auth/sso';
import { actorOf, recordAudit } from '../audit/record';
import { ApiError } from '../core/errors';
import { sha256Hex } from '../core/hashing';
import { ulid } from '../core/ids';
import { q, q1, run } from '../db/client';
import { getRepoBySlug } from '../db/repos';
import type { RepoRecord } from '../db/client';
import { SshReader, sshFingerprint } from '../git/signatures';
import { emitEvent } from '../webhooks/events';
import { apiError, errorResponse, readJsonBody } from './errors';

/**
 * Git over SSH keys (issue #34, ADR 0007):
 *
 * GET|POST /api/v1/me/ssh-keys, DELETE /:id             your SSH sign-in keys
 * GET|POST /api/v1/repos/:repo/deploy-keys, DELETE /:id  a repo's deploy keys (admins)
 * POST     /internal/ssh/authorize                       the SSH gateway only
 *
 * The gateway checks the client's key signature, then asks for a token that
 * lasts 60 seconds and covers one repository and one Git service, and speaks
 * smart HTTP with it (git/http.ts takes it as the Basic password). Every use
 * of a token re-reads its key, so removing a key stops it at once. Keys are
 * managed from a signed-in session only, with a recent second factor to add.
 */
export const keysRoutes = new Hono<AppEnv>();
export const sshGatewayRoutes = new Hono<AppEnv>();

export const SSH_TOKEN_PREFIX = 'yag_ssh_';
const SSH_TOKEN_TTL_MS = 60_000;
const SERVICES = ['git-upload-pack', 'git-receive-pack'] as const;
type Service = (typeof SERVICES)[number];

// ---------------------------------------------------------------------------
// key parsing
// ---------------------------------------------------------------------------

const ECDSA_POINT_BYTES: Record<string, number> = {
  nistp256: 65,
  nistp384: 97,
  nistp521: 133,
};
const MIN_RSA_BITS = 3072;

/**
 * `<type> <base64> [comment]` → the key without its comment and its SHA256
 * fingerprint (as `ssh-keygen -l` prints it), or throws with the reason.
 * Accepts Ed25519, ECDSA, `sk-ssh-ed25519` security keys and RSA of 3072
 * bits or more; refuses DSA.
 */
export async function parseAuthKey(
  line: string,
): Promise<{ type: string; publicKey: string; fingerprint: string }> {
  const [type, data] = line.trim().split(/\s+/);
  if (type === 'ssh-dss') throw new Error('DSA keys are not accepted; use Ed25519');
  if (!type || !data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data))
    throw new Error('expected an OpenSSH public key such as ssh-ed25519 AAAA…');
  const blob = Uint8Array.from(atob(data), (ch) => ch.charCodeAt(0));
  const r = new SshReader(blob);
  try {
    if (r.text() !== type) throw new Error('the key data does not match its type');
    if (type === 'ssh-ed25519' || type === 'sk-ssh-ed25519@openssh.com') {
      if (r.string().length !== 32) throw new Error('malformed Ed25519 key');
      if (type !== 'ssh-ed25519' && r.string().length === 0)
        throw new Error('malformed security key');
    } else if (type.startsWith('ecdsa-sha2-')) {
      const curve = type.slice('ecdsa-sha2-'.length);
      const size = ECDSA_POINT_BYTES[curve];
      if (size === undefined) throw new Error(`unsupported ECDSA curve ${curve}`);
      const named = r.text();
      const point = r.string();
      if (named !== curve || point.length !== size || point[0] !== 4)
        throw new Error('malformed ECDSA key');
    } else if (type === 'ssh-rsa') {
      r.string(); // e
      const n = r.string();
      let start = 0;
      while (start < n.length && n[start] === 0) start++;
      const bits =
        n.length > start ? (n.length - start) * 8 - Math.clz32(n[start]!) + 24 : 0;
      if (bits < MIN_RSA_BITS)
        throw new Error(
          `RSA keys under ${MIN_RSA_BITS} bits are not accepted; use Ed25519`,
        );
    } else {
      throw new Error(
        'unsupported key type; use ssh-ed25519, ecdsa-sha2-nistp256/384/521, sk-ssh-ed25519@openssh.com or ssh-rsa (3072 bits or more)',
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message === 'truncated SSH data')
      throw new Error('malformed key data');
    throw err;
  }
  if (r.pos !== blob.length) throw new Error('malformed key data');
  return { type, publicKey: `${type} ${data}`, fingerprint: await sshFingerprint(blob) };
}

// ---------------------------------------------------------------------------
// management routes
// ---------------------------------------------------------------------------

export const addSshKeySchema = z.object({
  title: z.string().trim().min(1).max(100),
  public_key: z.string().trim().min(1).max(20_000),
});
export const addDeployKeySchema = addSshKeySchema.extend({
  read_only: z.boolean().default(true),
});

interface SshKeyRow {
  id: string;
  title: string;
  fingerprint: string;
  public_key: string;
  created_at: number;
  last_used_at: number | null;
}
interface DeployKeyRow extends SshKeyRow {
  read_only: number;
  created_by: string;
}

function keyView(row: SshKeyRow): Record<string, unknown> {
  return {
    id: row.id,
    title: row.title,
    key_type: row.public_key.split(' ')[0],
    fingerprint: row.fingerprint,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
  };
}

function deployKeyView(row: DeployKeyRow): Record<string, unknown> {
  return { ...keyView(row), read_only: row.read_only === 1, created_by: row.created_by };
}

/** Keys grant Git access: managed from a signed-in session, never a token. */
function sessionUser(c: Context<AppEnv>): { id: string; authMethod: string | null } {
  const principal = c.get('principal') as Principal; // `/api/*` refused anonymous callers
  if (principal.kind !== 'user')
    throw new ApiError(
      403,
      'session_required',
      'Manage SSH keys from a signed-in session',
    );
  return { id: principal.userId, authMethod: principal.authMethod ?? null };
}

/** The parsed key, refused when any user or repo already holds it. */
async function newKey(
  env: Env,
  publicKey: string,
): Promise<{ publicKey: string; fingerprint: string }> {
  let parsed: Awaited<ReturnType<typeof parseAuthKey>>;
  try {
    parsed = await parseAuthKey(publicKey);
  } catch (err) {
    throw new ApiError(
      400,
      'invalid_ssh_key',
      err instanceof Error ? err.message : 'unreadable public key',
    );
  }
  // one key names one holder, so the gateway's lookup by fingerprint is exact
  const taken = await q1(
    env,
    `SELECT 1 FROM ssh_keys WHERE fingerprint = ?1
      UNION ALL SELECT 1 FROM deploy_keys WHERE fingerprint = ?1`,
    [parsed.fingerprint],
  );
  if (taken) throw new ApiError(409, 'ssh_key_exists', 'This key is already in use');
  return parsed;
}

function parse<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError(400, 'invalid_request', message);
  return parsed.data;
}

keysRoutes.get('/me/ssh-keys', async (c) => {
  try {
    const user = sessionUser(c);
    const rows = await q<SshKeyRow>(
      c.env,
      'SELECT * FROM ssh_keys WHERE user_id = ? ORDER BY created_at, id',
      [user.id],
    );
    return c.json({ keys: rows.map(keyView) }, 200, {
      'cache-control': 'private, no-store',
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

keysRoutes.post('/me/ssh-keys', async (c) => {
  try {
    const user = sessionUser(c);
    const mfa = await requireRecentMfa(c);
    if (mfa) return mfa;
    const input = parse(
      addSshKeySchema,
      await readJsonBody(c),
      'Send title and public_key',
    );
    const key = await newKey(c.env, input.public_key);
    const row: SshKeyRow = {
      id: ulid(),
      title: input.title,
      fingerprint: key.fingerprint,
      public_key: key.publicKey,
      created_at: Date.now(),
      last_used_at: null,
    };
    await run(
      c.env,
      `INSERT INTO ssh_keys (id, user_id, title, public_key, fingerprint, auth_method, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        user.id,
        row.title,
        row.public_key,
        row.fingerprint,
        user.authMethod,
        row.created_at,
      ],
    );
    await recordAudit(c, {
      action: 'ssh_key.add',
      target: { user_id: user.id, key_id: row.id, fingerprint: row.fingerprint },
    });
    return c.json({ key: keyView(row) }, 201);
  } catch (err) {
    return errorResponse(c, err);
  }
});

keysRoutes.delete('/me/ssh-keys/:id', async (c) => {
  try {
    const user = sessionUser(c);
    const id = c.req.param('id');
    const removed = await q1<{ fingerprint: string }>(
      c.env,
      'DELETE FROM ssh_keys WHERE id = ? AND user_id = ? RETURNING fingerprint',
      [id, user.id],
    );
    if (!removed) return apiError(c, 404, 'ssh_key_not_found', 'No such SSH key');
    await run(c.env, "DELETE FROM ssh_tokens WHERE key_kind = 'user' AND key_id = ?", [
      id,
    ]);
    await recordAudit(c, {
      action: 'ssh_key.remove',
      target: { user_id: user.id, key_id: id, fingerprint: removed.fingerprint },
    });
    return c.body(null, 204);
  } catch (err) {
    return errorResponse(c, err);
  }
});

const DEPLOY = '/repos/:repo{.+}/deploy-keys';

keysRoutes.get(DEPLOY, async (c) => {
  try {
    sessionUser(c);
    const loaded = await loadWholeRepo(c, 'admin', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const rows = await q<DeployKeyRow>(
      c.env,
      'SELECT * FROM deploy_keys WHERE repo_id = ? ORDER BY created_at, id',
      [loaded.repo.id],
    );
    return c.json({ keys: rows.map(deployKeyView) }, 200, {
      'cache-control': 'private, no-store',
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

keysRoutes.post(DEPLOY, async (c) => {
  try {
    const user = sessionUser(c);
    const loaded = await loadWholeRepo(c, 'admin', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const mfa = await requireRecentMfa(c);
    if (mfa) return mfa;
    const input = parse(
      addDeployKeySchema,
      await readJsonBody(c),
      'Send title, public_key and optionally read_only',
    );
    const key = await newKey(c.env, input.public_key);
    const row: DeployKeyRow = {
      id: ulid(),
      title: input.title,
      fingerprint: key.fingerprint,
      public_key: key.publicKey,
      read_only: input.read_only ? 1 : 0,
      created_by: user.id,
      created_at: Date.now(),
      last_used_at: null,
    };
    await run(
      c.env,
      `INSERT INTO deploy_keys (id, repo_id, title, public_key, fingerprint, read_only, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        loaded.repo.id,
        row.title,
        row.public_key,
        row.fingerprint,
        row.read_only,
        row.created_by,
        row.created_at,
      ],
    );
    await recordAudit(c, {
      action: 'deploy_key.add',
      repo: loaded.repo,
      target: {
        key_id: row.id,
        fingerprint: row.fingerprint,
        read_only: input.read_only,
      },
    });
    const view = deployKeyView(row);
    await emitEvent(c.env, loaded.repo, {
      event: 'deploy_key',
      action: 'created',
      actor: actorOf(c.get('principal')),
      origin: new URL(c.req.url).origin,
      data: { key: view },
    });
    return c.json({ key: view }, 201);
  } catch (err) {
    return errorResponse(c, err);
  }
});

keysRoutes.delete(`${DEPLOY}/:id`, async (c) => {
  try {
    sessionUser(c);
    const loaded = await loadWholeRepo(c, 'admin', c.req.param('repo'));
    if (!loaded.ok) return loaded.response;
    const id = c.req.param('id');
    const removed = await q1<DeployKeyRow>(
      c.env,
      'DELETE FROM deploy_keys WHERE id = ? AND repo_id = ? RETURNING *',
      [id, loaded.repo.id],
    );
    if (!removed) return apiError(c, 404, 'deploy_key_not_found', 'No such deploy key');
    await run(c.env, "DELETE FROM ssh_tokens WHERE key_kind = 'deploy' AND key_id = ?", [
      id,
    ]);
    await recordAudit(c, {
      action: 'deploy_key.remove',
      repo: loaded.repo,
      target: { key_id: id, fingerprint: removed.fingerprint },
    });
    await emitEvent(c.env, loaded.repo, {
      event: 'deploy_key',
      action: 'deleted',
      actor: actorOf(c.get('principal')),
      origin: new URL(c.req.url).origin,
      data: { key: deployKeyView(removed) },
    });
    return c.body(null, 204);
  } catch (err) {
    return errorResponse(c, err);
  }
});

// ---------------------------------------------------------------------------
// the gateway's endpoint and its tokens
// ---------------------------------------------------------------------------

export const sshAuthorizeSchema = z.object({
  fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/),
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
  service: z.enum(SERVICES),
});

/** A registered key: a person's (active users only) or a repo's deploy key. */
type SshKey =
  | { kind: 'user'; id: string; userId: string; authMethod: string | null }
  | { kind: 'deploy'; id: string; repoId: string; readOnly: boolean };

const keyRowSchema = z.object({
  user_key: z.string().nullable(),
  user_id: z.string().nullable(),
  auth_method: z.string().nullable(),
  deploy_key: z.string().nullable(),
  deploy_repo: z.string().nullable(),
  read_only: z.number().nullable(),
});

function keyOf(row: unknown): SshKey | null {
  const k = keyRowSchema.parse(row);
  if (k.user_key && k.user_id)
    return { kind: 'user', id: k.user_key, userId: k.user_id, authMethod: k.auth_method };
  if (k.deploy_key && k.deploy_repo)
    return {
      kind: 'deploy',
      id: k.deploy_key,
      repoId: k.deploy_repo,
      readOnly: k.read_only !== 0,
    };
  return null;
}

/** Joins a person's key (`s`, active users only) and a deploy key (`d`). */
const KEY_COLUMNS = `s.id AS user_key, s.user_id, s.auth_method,
  d.id AS deploy_key, d.repo_id AS deploy_repo, d.read_only`;
const ACTIVE_USER =
  'EXISTS (SELECT 1 FROM users u WHERE u.id = s.user_id AND u.active = 1)';

/**
 * The caller a token stands for: a person's key acts as that person with the
 * service's scope, so their role, path rules and org SSO still apply; a
 * deploy key reads, and when not read-only writes, its one repo.
 */
function sshPrincipal(key: SshKey, repoId: string, service: Service): Principal {
  const write =
    service === 'git-receive-pack' && !(key.kind === 'deploy' && key.readOnly);
  const scopes = write ? ['repo:read', 'repo:write'] : ['repo:read'];
  if (key.kind === 'user')
    return {
      kind: 'token',
      userId: key.userId,
      tokenId: `ssh-key:${key.id}`,
      scopes,
      repoId,
      authMethod: key.authMethod,
    };
  return {
    kind: 'token',
    userId: `deploy-key:${key.id}`,
    tokenId: `deploy-key:${key.id}`,
    scopes,
    repoId,
    deployKeyId: key.id,
  };
}

/**
 * The principal behind an SSH token, for the Git `service` this request is
 * (null for anything else, such as LFS), or null when the token is expired,
 * for another service, or its key has been removed.
 */
export async function resolveSshToken(
  env: Env,
  raw: string,
  service: string | null,
  now: number = Date.now(),
): Promise<Principal | null> {
  if (!raw.startsWith(SSH_TOKEN_PREFIX) || service === null) return null;
  const row = await q1<Record<string, unknown>>(
    env,
    `SELECT t.repo_id, t.service, ${KEY_COLUMNS}
       FROM ssh_tokens t
       LEFT JOIN ssh_keys s ON t.key_kind = 'user' AND s.id = t.key_id AND ${ACTIVE_USER}
       LEFT JOIN deploy_keys d ON t.key_kind = 'deploy' AND d.id = t.key_id AND d.repo_id = t.repo_id
      WHERE t.token_hash = ? AND t.expires_at > ?`,
    [await sha256Hex(new TextEncoder().encode(raw)), now],
  );
  if (!row || row['service'] !== service) return null;
  const key = keyOf(row);
  return key && sshPrincipal(key, String(row['repo_id']), service as Service);
}

/** Only on the internal hostname, only with the gateway key; 404 elsewhere. */
async function gatewayRefusal(c: Context<AppEnv>): Promise<Response | null> {
  const { SSH_GATEWAY_HOST: host, SSH_GATEWAY_KEY: secret } = c.env;
  if (!host || !secret || new URL(c.req.url).hostname !== host)
    return apiError(c, 404, 'not_found', 'no such route');
  const given = c.req.header('x-ssh-gateway-key') ?? '';
  const hash = (s: string) => sha256Hex(new TextEncoder().encode(s));
  if ((await hash(given)) !== (await hash(secret)))
    return apiError(c, 401, 'unauthorized', 'gateway key required');
  return null;
}

sshGatewayRoutes.post('/internal/ssh/authorize', async (c) => {
  try {
    const refused = await gatewayRefusal(c);
    if (refused) return refused;
    const input = parse(
      sshAuthorizeSchema,
      await readJsonBody(c),
      'Send fingerprint (SHA256:…), repo (owner/name) and service',
    );
    const row = await q1(
      c.env,
      `SELECT ${KEY_COLUMNS} FROM (SELECT ?1 AS fp) f
         LEFT JOIN ssh_keys s ON s.fingerprint = f.fp AND ${ACTIVE_USER}
         LEFT JOIN deploy_keys d ON d.fingerprint = f.fp`,
      [input.fingerprint],
    );
    const key = row && keyOf(row);
    if (!key) return apiError(c, 403, 'unknown_key', 'this key is not registered');
    const repo: RepoRecord | null = await getRepoBySlug(c.env, input.repo);
    const notFound = () => apiError(c, 404, 'repo_not_found', `no repo ${input.repo}`);
    if (!repo || (key.kind === 'deploy' && key.repoId !== repo.id)) return notFound();
    const principal = sshPrincipal(key, repo.id, input.service);
    const origin = new URL(c.req.url).origin;
    const read = await decide(c.env, repo, principal, 'read');
    if (read.ssoRequired)
      return apiError(c, 403, 'sso_required', ssoMessage(read.ssoRequired, origin));
    if (!read.allowed) return notFound();
    if (input.service === 'git-receive-pack') {
      if (key.kind === 'deploy' && key.readOnly)
        return apiError(c, 403, 'deploy_key_read_only', 'this deploy key is read-only');
      const write = await decide(c.env, repo, principal, 'write');
      if (write.ssoRequired)
        return apiError(c, 403, 'sso_required', ssoMessage(write.ssoRequired, origin));
      if (!write.allowed)
        return apiError(c, 403, 'forbidden', 'insufficient permission', {
          ...(write.deniedBy ? { denied_by: write.deniedBy } : {}),
        });
    }
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const token =
      SSH_TOKEN_PREFIX + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    const now = Date.now();
    const expiresAt = now + SSH_TOKEN_TTL_MS;
    await run(c.env, 'DELETE FROM ssh_tokens WHERE expires_at <= ?', [now]);
    await run(
      c.env,
      `INSERT INTO ssh_tokens (token_hash, key_kind, key_id, repo_id, service, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        await sha256Hex(new TextEncoder().encode(token)),
        key.kind,
        key.id,
        repo.id,
        input.service,
        expiresAt,
      ],
    );
    await run(
      c.env,
      `UPDATE ${key.kind === 'user' ? 'ssh_keys' : 'deploy_keys'} SET last_used_at = ? WHERE id = ?`,
      [now, key.id],
    );
    return c.json({
      token,
      expires_at: expiresAt,
      repo: repo.slug,
      service: input.service,
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});
