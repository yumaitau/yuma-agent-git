import { z } from 'zod';
import type { Context, Next } from 'hono';
import type { Env } from '../env';
import { C, T } from '../db/schema';
import { parseUserRow, q1, run, tx, type UserRecord } from '../db/client';
import { apiError } from '../api/errors';
import { sha256Hex } from '../core/hashing';
import { ulid } from '../core/ids';
import { resolveTokenPrincipal } from './tokens';
import type { AppEnv, Principal } from './principal';

/**
 * Sessions (issues #12, #27): every sign-in method lands here. The session
 * token is 32 random bytes; D1 stores only its SHA-256. 30-day expiry with
 * sliding renewal once the session is past halfway. Each session records how
 * the user signed in and when they last passed a second factor.
 */

export const SESSION_COOKIE = 'yag_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_RENEW_AFTER_MS = SESSION_TTL_MS / 2;
/** Sensitive actions need a second factor this recent. */
export const MFA_MAX_AGE_MS = 12 * 60 * 60 * 1000;

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function createSession(
  env: Env,
  userId: string,
  now: number = Date.now(),
  opts: { method?: string; mfaAt?: number | null } = {},
): Promise<{ token: string; expiresAt: number }> {
  const token = randomHex(32);
  const expiresAt = now + SESSION_TTL_MS;
  await run(
    env,
    `INSERT INTO ${T.sessions} (${C.sessions.tokenHash}, ${C.sessions.userId}, ${C.sessions.createdAt}, ${C.sessions.expiresAt}, auth_method, mfa_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      await sha256Hex(new TextEncoder().encode(token)),
      userId,
      now,
      expiresAt,
      opts.method ?? 'github',
      opts.mfaAt ?? null,
    ],
  );
  return { token, expiresAt };
}

/** `Set-Cookie` value for a new session (Secure on https origins). */
export function sessionCookie(reqUrl: string, token: string): string {
  const secure = reqUrl.startsWith('https://') ? '; Secure' : '';
  return `${SESSION_COOKIE}=${token}; HttpOnly${secure}; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE}`;
}

/**
 * Binds an OAuth/OIDC sign-in to the browser that started it: the start sets
 * this cookie to the state, and the callback requires the two to match, so a
 * callback URL lured from another browser cannot sign the victim in as the
 * attacker (login CSRF).
 */
export const LOGIN_STATE_COOKIE = 'yag_login_state';

/** Set (`state`) or clear (`null`) the login-state cookie. */
export function loginStateCookie(reqUrl: string, state: string | null): string {
  const secure = reqUrl.startsWith('https://') ? '; Secure' : '';
  return `${LOGIN_STATE_COOKIE}=${state ?? ''}; HttpOnly${secure}; SameSite=Lax; Path=/auth; Max-Age=${state === null ? 0 : 600}`;
}

/** Whether the request's login-state cookie holds `state`. */
export function loginStateMatches(
  cookieHeader: string | undefined,
  state: string,
): boolean {
  const match = /(?:^|;\s*)yag_login_state=([^;]+)/.exec(cookieHeader ?? '');
  return match?.[1] === state;
}

/** Resolve a session cookie header to its user (with sliding renewal). */
export async function readSession(
  env: Env,
  cookieHeader: string | undefined,
  now: number = Date.now(),
): Promise<UserRecord | null> {
  return (await loadSession(env, cookieHeader, now))?.user ?? null;
}

/** `readSession` plus how that session signed in. */
async function loadSession(
  env: Env,
  cookieHeader: string | undefined,
  now: number = Date.now(),
): Promise<{ user: UserRecord; authMethod: string } | null> {
  const match = /(?:^|;\s*)yag_session=([^;]+)/.exec(cookieHeader ?? '');
  if (!match) return null;
  const tokenHash = await sha256Hex(new TextEncoder().encode(match[1] as string));
  const row = await q1(
    env,
    `SELECT * FROM ${T.sessions} WHERE ${C.sessions.tokenHash} = ?`,
    [tokenHash],
  );
  if (!row) return null;
  const session = row as Record<string, number>;
  if ((session[C.sessions.expiresAt] as number) < now) {
    await revokeSession(env, tokenHash);
    return null;
  }
  // sliding renewal past halfway
  if (now - (session[C.sessions.createdAt] as number) > SESSION_RENEW_AFTER_MS) {
    await run(
      env,
      `UPDATE ${T.sessions} SET ${C.sessions.expiresAt} = ? WHERE ${C.sessions.tokenHash} = ?`,
      [now + SESSION_TTL_MS, tokenHash],
    );
  }
  const user = await q1(env, `SELECT * FROM ${T.users} WHERE ${C.users.id} = ?`, [
    String(session[C.sessions.userId]),
  ]);
  if (!user) return null;
  const parsed = parseUserRow(user);
  return parsed.active === 0
    ? null
    : { user: parsed, authMethod: z.string().parse(row['auth_method']) };
}

const sessionInfoSchema = z.object({
  token_hash: z.string(),
  user_id: z.string(),
  auth_method: z.string(),
  mfa_at: z.number().nullable(),
});
export type SessionInfo = z.infer<typeof sessionInfoSchema>;

/** The session row behind a cookie: how the user signed in and MFA time. */
export async function currentSession(
  env: Env,
  cookieHeader: string | undefined,
): Promise<SessionInfo | null> {
  const token = sessionTokenFrom(cookieHeader);
  if (!token) return null;
  const row = await q1(
    env,
    `SELECT token_hash, user_id, auth_method, mfa_at FROM ${T.sessions} WHERE ${C.sessions.tokenHash} = ?`,
    [await sha256Hex(new TextEncoder().encode(token))],
  );
  return row ? sessionInfoSchema.parse(row) : null;
}

/** Record a passed second factor on the caller's session. */
export async function markSessionMfa(
  env: Env,
  cookieHeader: string | undefined,
  now: number = Date.now(),
): Promise<void> {
  const token = sessionTokenFrom(cookieHeader);
  if (!token) return;
  await run(
    env,
    `UPDATE ${T.sessions} SET mfa_at = ? WHERE ${C.sessions.tokenHash} = ?`,
    [now, await sha256Hex(new TextEncoder().encode(token))],
  );
}

/** True when the user has a passkey or a confirmed TOTP authenticator. */
export async function hasMfa(env: Env, userId: string): Promise<boolean> {
  const row = await q1<{ n: number }>(
    env,
    `SELECT (SELECT COUNT(*) FROM webauthn_credentials WHERE user_id = ?)
          + (SELECT COUNT(*) FROM totp_secrets WHERE user_id = ? AND confirmed_at IS NOT NULL) AS n`,
    [userId, userId],
  );
  return (row?.n ?? 0) > 0;
}

/**
 * Gate for sensitive actions: `403 mfa_required` unless the session passed a
 * second factor in the last 12 hours. Users with no factor enrolled pass,
 * unless `strict` (then they must enrol one first). Returns null when allowed.
 */
export async function requireRecentMfa(
  c: Context<AppEnv>,
  opts: { strict?: boolean; now?: number } = {},
): Promise<Response | null> {
  const user = c.get('user');
  if (!user) return apiError(c, 401, 'unauthorized', 'session required');
  const now = opts.now ?? Date.now();
  const session = await currentSession(c.env, c.req.header('cookie'));
  if (session?.mfa_at != null && now - session.mfa_at <= MFA_MAX_AGE_MS) return null;
  const enrolled = await hasMfa(c.env, user.id);
  if (!enrolled && !opts.strict) return null;
  return apiError(
    c,
    403,
    'mfa_required',
    enrolled
      ? 'verify a passkey or authenticator code first (needed every 12 hours)'
      : 'enrol a passkey or authenticator app first',
    { mfa_enrolled: enrolled },
  );
}

/**
 * Deprovision a user in one D1 batch: mark inactive and revoke every session
 * and API token, so nothing they hold keeps working after this request.
 */
export async function deactivateUser(env: Env, userId: string): Promise<void> {
  await tx(env, (t) => {
    t.q(`UPDATE ${T.users} SET active = 0 WHERE ${C.users.id} = ?`, [userId]);
    t.q(`DELETE FROM ${T.sessions} WHERE ${C.sessions.userId} = ?`, [userId]);
    t.q(`DELETE FROM ${T.apiTokens} WHERE ${C.apiTokens.userId} = ?`, [userId]);
  });
}

export async function revokeSession(env: Env, tokenHash: string): Promise<void> {
  await run(env, `DELETE FROM ${T.sessions} WHERE ${C.sessions.tokenHash} = ?`, [
    tokenHash,
  ]);
}

export async function revokeSessionToken(env: Env, token: string): Promise<void> {
  await revokeSession(env, await sha256Hex(new TextEncoder().encode(token)));
}

/** Extract the raw session token from a cookie header (for logout). */
export function sessionTokenFrom(cookieHeader: string | undefined): string | null {
  const match = /(?:^|;\s*)yag_session=([^;]+)/.exec(cookieHeader ?? '');
  return match ? (match[1] as string) : null;
}

// ---------------------------------------------------------------------------
// Principal middleware
// ---------------------------------------------------------------------------

/**
 * Resolves the caller on every request and sets `user` + `principal`. Session
 * cookie → user principal; `Authorization: Bearer yag_…` → token principal.
 * Never 401s by itself — route guards decide.
 */
export async function authMiddleware(c: Context<AppEnv>, next: Next): Promise<void> {
  let user: UserRecord | null = null;
  let principal: Principal | null = null;

  const cookie = c.req.header('cookie');
  if (cookie) {
    const session = await loadSession(c.env, cookie);
    if (session) {
      user = session.user;
      principal = { kind: 'user', userId: user.id, authMethod: session.authMethod };
    }
  }

  if (principal === null) {
    const authorization = c.req.header('authorization');
    if (authorization?.startsWith('Bearer ')) {
      const resolved = await resolveTokenPrincipal(c.env, authorization.slice(7));
      if (resolved) {
        principal = resolved;
        // `user` denotes a browser session. A bearer must never gain access to
        // session-only endpoints (especially minting a broader API token).
        // best-effort usage tracking (spec: async via waitUntil)
        try {
          c.executionCtx.waitUntil(touchToken(c.env, resolved));
        } catch {
          await touchToken(c.env, resolved);
        }
      }
    }
  }

  c.set('user', user);
  c.set('principal', principal);
  await next();
}

async function touchToken(env: Env, principal: Principal): Promise<void> {
  if (principal.kind !== 'token') return;
  await run(
    env,
    `UPDATE ${T.apiTokens} SET ${C.apiTokens.lastUsedAt} = ? WHERE ${C.apiTokens.id} = ?`,
    [Date.now(), principal.tokenId],
  );
}

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------

const githubUserSchema = z.object({
  id: z.number(),
  login: z.string(),
  avatar_url: z.string().nullable().optional(),
});

const githubEmailsSchema = z.array(
  z.object({
    email: z.string(),
    primary: z.boolean().optional(),
    verified: z.boolean().optional(),
  }),
);

/** Whether another user holds `login` (logins are unique, case-insensitively). */
async function loginTaken(env: Env, login: string, selfId?: string): Promise<boolean> {
  const row = await q1<{ id: string }>(
    env,
    `SELECT ${C.users.id} AS id FROM ${T.users} WHERE ${C.users.login} = ? COLLATE NOCASE`,
    [login],
  );
  return row !== null && row.id !== selfId;
}

/**
 * Upsert by GitHub id — idempotent across repeated logins. A GitHub login
 * another user already holds is never taken over: a rename into it keeps the
 * old login, a new user gets a short suffix.
 */
export async function upsertUser(
  env: Env,
  github: { id: number; login: string; avatar_url?: string | null; email?: string },
  now: number = Date.now(),
): Promise<UserRecord> {
  const existing = await q1(
    env,
    `SELECT * FROM ${T.users} WHERE ${C.users.githubId} = ?`,
    [github.id],
  );
  if (existing) {
    const current = parseUserRow(existing);
    const login = (await loginTaken(env, github.login, current.id))
      ? current.login
      : github.login;
    await run(
      env,
      `UPDATE ${T.users} SET ${C.users.login} = ?, ${C.users.avatarUrl} = ? WHERE ${C.users.githubId} = ?`,
      [login, github.avatar_url ?? null, github.id],
    );
    const updated = await q1(
      env,
      `SELECT * FROM ${T.users} WHERE ${C.users.githubId} = ?`,
      [github.id],
    );
    return parseUserRow(updated);
  }
  const row = {
    id: ulid(now),
    github_id: github.id,
    login: (await loginTaken(env, github.login))
      ? `${github.login}-${randomHex(3)}`
      : github.login,
    avatar_url: github.avatar_url ?? null,
    created_at: now,
  };
  await run(
    env,
    `INSERT INTO ${T.users} (${C.users.id}, ${C.users.githubId}, ${C.users.login}, ${C.users.avatarUrl}, ${C.users.createdAt})
     VALUES (?, ?, ?, ?, ?)`,
    [row.id, row.github_id, row.login, row.avatar_url, row.created_at],
  );
  await linkIdentity(env, row.id, 'github', String(github.id), null, now);
  return parseUserRow(row);
}

/**
 * Create a user with no GitHub account (OIDC, SCIM). The login comes from the
 * hint (email local part, username) and gets a short suffix if already taken.
 */
export async function createUser(
  env: Env,
  loginHint: string,
  now: number = Date.now(),
): Promise<UserRecord> {
  const base =
    (loginHint.split('@')[0] ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 39) || 'user';
  const row = {
    id: ulid(now),
    github_id: null,
    login: (await loginTaken(env, base)) ? `${base}-${randomHex(3)}` : base,
    avatar_url: null,
    created_at: now,
  };
  await run(
    env,
    `INSERT INTO ${T.users} (${C.users.id}, ${C.users.login}, ${C.users.createdAt}) VALUES (?, ?, ?)`,
    [row.id, row.login, row.created_at],
  );
  return parseUserRow(row);
}

/** Attach a sign-in identity to a user (no-op when already linked). */
export async function linkIdentity(
  env: Env,
  userId: string,
  provider: string,
  subject: string,
  email: string | null,
  now: number = Date.now(),
): Promise<void> {
  await run(
    env,
    `INSERT OR IGNORE INTO user_identities (provider, subject, user_id, email, linked_at)
     VALUES (?, ?, ?, ?, ?)`,
    [provider, subject, userId, email?.toLowerCase() ?? null, now],
  );
}

/** The user an identity belongs to, or null. */
export async function findIdentityUser(
  env: Env,
  provider: string,
  subject: string,
): Promise<string | null> {
  const row = await q1<{ user_id: string }>(
    env,
    'SELECT user_id FROM user_identities WHERE provider = ? AND subject = ?',
    [provider, subject],
  );
  return row?.user_id ?? null;
}

export { githubUserSchema, githubEmailsSchema, randomHex };

// re-exported for tests that build cookie headers
export const SESSION_MAX_AGE = SESSION_TTL_MS / 1000;
