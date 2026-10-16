import { Hono } from 'hono';
import { apiRouter } from './api/router';
import { apiError, errorResponse } from './api/errors';
import { adminRoutes } from './api/admin';
import { cacheTierMiddleware, cacheTokenRoutes } from './middleware/cachetier';
import { observeMiddleware } from './middleware/observe';
import { rateLimitMiddleware } from './middleware/ratelimit';
import { authRoutes } from './auth/oauth';
import { githubRoutes } from './bridge/github';
import { authMiddleware } from './auth/session';
import { identityRoutes } from './auth/security';
import { tokensRoutes } from './auth/tokens';
import { reposRoutes } from './api/repos';
import { webhooksRoutes } from './api/webhooks';
import type { AppEnv } from './auth/principal';

/**
 * The Hono application. Exported separately from the Worker entry so tests can
 * drive routes through `app.fetch` with miniflare bindings.
 */
export const app = new Hono<AppEnv>();

// Observability is outermost so the request id and phase timer cover auth.
app.use('*', observeMiddleware);
// Resolves `user` + `principal` on every request (never 401s by itself).
app.use('*', authMiddleware);
// Sign-in is required to see anything: the whole /api surface rejects
// anonymous callers, public repos included. OAuth, webhooks (signature
// verified) and /healthz stay reachable. Every API response is therefore
// per-user, so `public` cache policies are narrowed to `private`: browsers
// may still keep immutable reads, shared caches never do.
app.use('/api/*', async (c, next) => {
  if (!c.get('principal')) {
    return apiError(c, 401, 'unauthorized', 'authentication required');
  }
  await next();
  const cacheControl = c.res.headers.get('cache-control');
  if (cacheControl?.includes('public')) {
    c.res.headers.set('cache-control', cacheControl.replace('public', 'private'));
  }
});
// Rate limiting (429 + Retry-After) reads the principal auth just resolved.
app.use('*', rateLimitMiddleware);
// …then the cache tier (public immutable only; nothing auth'd is cached).
app.use('*', cacheTierMiddleware);

app.get('/healthz', (c) => c.json({ ok: true }));

// These modules declare absolute paths (outside /api/v1): OAuth, OIDC,
// passkeys, SCIM, webhooks, the GitHub App handshake, and token management.
app.route('/', authRoutes);
app.route('/', identityRoutes);
app.route('/', tokensRoutes);
app.route('/', webhooksRoutes);
app.route('/', githubRoutes);
app.route('/', adminRoutes);
app.route('/', cacheTokenRoutes);
app.route('/', reposRoutes);
app.route('/api/v1', apiRouter);

// Unrouted API/worker paths follow the error envelope; anything else falls
// through to the SPA (assets binding serves dashboard/dist, issue #20).
app.notFound((c) => {
  const path = new URL(c.req.url).pathname;
  const isApiSurface =
    path.startsWith('/api/') ||
    path.startsWith('/auth/') ||
    path.startsWith('/webhooks/') ||
    path.startsWith('/scim/') ||
    path.startsWith('/healthz');
  if (!isApiSurface && c.env.ASSETS) {
    return c.env.ASSETS.fetch(c.req.raw);
  }
  return apiError(c, 404, 'not_found', 'no such route');
});
app.onError((err, c) => errorResponse(c, err));
