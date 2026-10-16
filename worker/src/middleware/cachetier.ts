import { Hono, type Context, type Next } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../auth/principal';
import { apiError, errorResponse, readJsonBody } from '../api/errors';
import { recordAudit } from '../audit/record';

/**
 * Cache tier (issue #21) — Workers Cache API for content-addressed GETs.
 * Everything here is safe by construction because objects are immutable and
 * the routes mark them so; the middleware's job is **correctness over speed**:
 *
 *   - cache only `public` responses from content-addressed routes
 *     (object/blob/tree, file raw, tree, tarball, fast-import, diff)
 *   - OR requests carrying a valid signed `?cache_token=` (HMAC of
 *     URL+expiry+user, minted by POST /api/v1/cache-token for authenticated
 *     callers who want CDN caching of private reads). The user is bound in so
 *     a shared URL can never replay one user's cached body to another whose
 *     path rules filter the same route differently
 *   - everything else — especially anything auth'd — gets
 *     `Cache-Control: private, no-store` enforced here regardless of what a
 *     route said
 */

const CACHEABLE_PATTERNS = [
  /\/object\/(tree|blob)\//,
  /\/fetch-objects$/,
  /\/file$/,
  /\/tree$/,
  /\/diff$/,
  /\/export\/(tarball|fast-import)$/,
];

const TOKEN_TTL_MS = 60 * 60 * 1000;

export function isCacheablePath(path: string): boolean {
  return CACHEABLE_PATTERNS.some((pattern) => pattern.test(path));
}

/** HMAC of `url|expiry|subject` — proves this user's private read may be cached. */
export async function mintCacheToken(
  signingKey: string,
  url: string,
  subject: string,
  now: number = Date.now(),
): Promise<{ token: string; expires_at: number }> {
  if (signingKey === '') throw new Error('cache signing key not configured');
  const expiresAt = now + TOKEN_TTL_MS;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(signingKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${url}|${expiresAt}|${subject}`),
  );
  const token = `${expiresAt}.${[...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  return { token, expires_at: expiresAt };
}

export async function verifyCacheToken(
  signingKey: string,
  url: string,
  token: string,
  subject: string,
  now: number = Date.now(),
): Promise<boolean> {
  if (signingKey === '') return false; // fail closed: no key, no trust
  const [expiryRaw, mac] = token.split('.') as [string, string | undefined];
  const expiry = Number(expiryRaw);
  if (!mac || !Number.isFinite(expiry) || expiry < now) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(signingKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const provided = new Uint8Array(
    (mac.match(/.{2}/g) ?? []).map((byte) => parseInt(byte, 16)),
  );
  return crypto.subtle.verify(
    'HMAC',
    key,
    provided as BufferSource,
    new TextEncoder().encode(`${url}|${expiry}|${subject}`),
  );
}

const MAX_CACHE_BYTES = 8 * 1024 * 1024;

export async function cacheTierMiddleware(
  c: Context<AppEnv>,
  next: Next,
): Promise<Response | void> {
  const request = c.req.raw;
  const url = new URL(request.url);
  if (request.method !== 'GET' || !isCacheablePath(url.pathname)) {
    await next();
    return;
  }

  // auth-varying query params must not fragment the cache key
  const cacheUrl = new URL(url);
  cacheUrl.searchParams.delete('cache_token');
  // Recheck route authorization even on hits: permissions can change.
  await next();
  const response = c.res;
  const cacheControl = response.headers.get('cache-control') ?? '';
  const token = url.searchParams.get('cache_token');
  const subject = c.get('principal')?.userId;
  const tokenOk =
    token !== null &&
    subject !== undefined &&
    (await verifyCacheToken(
      c.env.CACHE_SIGNING_KEY ?? '',
      cacheUrl.toString(),
      token,
      subject,
    ));

  if (
    response.status !== 200 ||
    ((!cacheControl.includes('public') || c.get('principal')) && !tokenOk)
  ) {
    // correctness over speed: nothing auth'd or private is ever cacheable
    response.headers.set('cache-control', 'private, no-store');
    response.headers.set('x-yag-cache', 'bypass');
    return response;
  }

  // Signed private entries must never share the unsigned public cache key.
  const cacheKey = new Request(tokenOk ? url.toString() : cacheUrl.toString());
  const hit = await caches.default.match(cacheKey);
  if (hit) {
    void response.body?.cancel().catch(() => {});
    const cachedResponse = new Response(hit.body, response);
    cachedResponse.headers.set('x-yag-cache', 'hit');
    c.res = cachedResponse;
    return cachedResponse;
  }

  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (
    response.status === 200 &&
    (contentLength === 0 || contentLength <= MAX_CACHE_BYTES)
  ) {
    // fire-and-forget via waitUntil; a failing body stream must never fail
    // the request (raw reads abort mid-stream on corruption by design)
    const entry = response.clone();
    if (tokenOk) {
      const expires = Number(token!.split('.')[0]);
      const ttl = Math.max(1, Math.min(10, Math.floor((expires - Date.now()) / 1000)));
      entry.headers.set('cache-control', `public, max-age=${ttl}`);
      response.headers.set('cache-control', 'private, no-store');
    }
    const cached = caches.default.put(cacheKey, entry).catch(() => {});
    c.executionCtx.waitUntil(cached);
    response.headers.set('x-yag-cache', 'miss');
  }
  return response;
}

/**
 * Mint endpoint: session-authed callers get a signed URL token so CDNs may
 * cache their private reads for a bounded window.
 */
export const cacheTokenRoutes = new Hono<AppEnv>();

export const mintSchema = z.object({ url: z.string().min(1) });

cacheTokenRoutes.post('/api/v1/cache-token', async (c) => {
  try {
    if (!c.get('user')) return apiError(c, 401, 'unauthorized', 'session required');
    const body = await readJsonBody(c);
    const parsed = mintSchema.safeParse(body);
    if (!parsed.success) {
      return apiError(c, 400, 'invalid_request', 'url is required');
    }
    const target = new URL(parsed.data.url, 'https://placeholder.invalid');
    const minted = await mintCacheToken(
      c.env.CACHE_SIGNING_KEY ?? '',
      target.toString(),
      c.get('user')!.id,
    );
    await recordAudit(c, {
      action: 'cache_token.create',
      target: { path: target.pathname },
    });
    return c.json(minted, 200, { 'cache-control': 'private, no-store' });
  } catch (err) {
    return errorResponse(c, err);
  }
});
