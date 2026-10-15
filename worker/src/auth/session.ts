import { z } from 'zod';
import type { Context, Next } from 'hono';
import type { Env } from '../env';
import { C, T } from '../db/schema';
import { parseUserRow, q1, run, type UserRecord } from '../db/client';
import { sha256Hex } from '../core/hashing';
import { ulid } from '../core/ids';
import { resolveTokenPrincipal } from './tokens';
import type { AppEnv, Principal } from './principal';

/**
 * Sessions (issue #12): GitHub OAuth logins land here. The session token is 32
 * random bytes; D1 stores only its SHA-256. 30-day expiry with sliding
 * renewal once the session is past halfway.
 */

export const SESSION_COOKIE = 'yag_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_RENEW_AFTER_MS = SESSION_TTL_MS / 2;

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function createSession(
  env: Env,
  userId: string,
  now: number = Date.now(),
): Promise<{ token: string; expiresAt: number }> {
  const token = randomHex(32);
  const expiresAt = now + SESSION_TTL_MS;
  await run(
    env,
    `INSERT INTO ${T.sessions} (${C.sessions.tokenHash}, ${C.sessions.userId}, ${C.sessions.createdAt}, ${C.sessions.expiresAt})
     VALUES (?, ?, ?, ?)`,
    [await sha256Hex(new TextEncoder().encode(token)), userId, now, expiresAt],
  );
  return { token, expiresAt };
}

/** Resolve a session cookie header to its user (with sliding renewal). */
export async function readSession(
  env: Env,
  cookieHeader: string | undefined,
  now: number = Date.now(),
): Promise<UserRecord | null> {
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
  return user ? parseUserRow(user) : null;
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
    user = await readSession(c.env, cookie);
    if (user) principal = { kind: 'user', userId: user.id };
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

/** Upsert by GitHub id — idempotent across repeated logins. */
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
    await run(
      env,
      `UPDATE ${T.users} SET ${C.users.login} = ?, ${C.users.avatarUrl} = ? WHERE ${C.users.githubId} = ?`,
      [github.login, github.avatar_url ?? null, github.id],
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
    login: github.login,
    avatar_url: github.avatar_url ?? null,
    created_at: now,
  };
  await run(
    env,
    `INSERT INTO ${T.users} (${C.users.id}, ${C.users.githubId}, ${C.users.login}, ${C.users.avatarUrl}, ${C.users.createdAt})
     VALUES (?, ?, ?, ?, ?)`,
    [row.id, row.github_id, row.login, row.avatar_url, row.created_at],
  );
  return parseUserRow(row);
}

export { githubUserSchema, githubEmailsSchema, randomHex };

// re-exported for tests that build cookie headers
export const SESSION_MAX_AGE = SESSION_TTL_MS / 1000;
