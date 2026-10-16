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
import { agentIdentityRoutes } from './auth/agents';
import { appsRoutes } from './auth/apps';
import { oauthAppsRoutes } from './auth/oauth-apps';
import { reposRoutes } from './api/repos';
import { webhooksRoutes } from './api/webhooks';
import { gitBasicAuth, gitRoutes } from './git/http';
import { oidcRoutes } from './ci/oidc';
import { runnerRoutes } from './ci/runners';
import { jobStorageRoutes } from './ci/job-routes';
import { mcpOAuthRoutes } from './mcp/oauth';
import { mcpServerRoutes } from './mcp/server';
import { npmRoutes } from './registry/npm';
import { ociRoutes } from './registry/oci';
import { provenanceKeysRoutes } from './api/provenance';
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
// Git smart HTTP also takes a token as the HTTP Basic password (git/http.ts).
app.use('*', gitBasicAuth);
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

// Git clients (issues #31, #32): `/:owner/:repo.git/…`, before the SPA fallback.
app.route('/', gitRoutes);

// CI workload identity (issue #50): public discovery + JWKS for cloud IAM,
// and the token endpoint, which authenticates with a per-run request token.
app.route('/', oidcRoutes);

// Self-hosted runners (issue #48): a one-time registration token, then the
// runner's own credential. Outside /api: runners are not users.
app.route('/', runnerRoutes);
// Job artifacts and caches (issue #51): the runner credential or the job token.
app.route('/', jobStorageRoutes);

// Package registry (issue #53): OCI images at /v2/ and npm at /npm/, each
// with its own credential handling (registry/auth.ts).
app.route('/', ociRoutes);
app.route('/', npmRoutes);

// Signed provenance (issue #58): the public keys records verify against.
app.route('/', provenanceKeysRoutes);

// These modules declare absolute paths (outside /api/v1): OAuth, OIDC,
// passkeys, SCIM, webhooks, the GitHub App handshake, token management,
// agent identities with their token exchange, and apps and OAuth apps (#75).
app.route('/', authRoutes);
app.route('/', identityRoutes);
app.route('/', tokensRoutes);
// MCP (issue #56): OAuth metadata, consent and code/refresh grants (before
// the token exchange, which shares POST /oauth/token), and `/mcp` itself.
// MCP reads a clone of the token request, so it goes before OAuth apps.
app.route('/', mcpOAuthRoutes);
app.route('/', mcpServerRoutes);
// before agent identities: it takes the app and OAuth app grants at /oauth/token
app.route('/', oauthAppsRoutes);
app.route('/', appsRoutes);
app.route('/', agentIdentityRoutes);
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
    path.startsWith('/healthz') ||
    path.startsWith('/ci/oidc/') ||
    path.startsWith('/runner/') ||
    path.startsWith('/v2/') ||
    path.startsWith('/npm/') ||
    path === '/mcp' ||
    path.startsWith('/oauth/') ||
    path.startsWith('/.well-known/oauth-') ||
    path === '/.well-known/yag-provenance-keys' ||
    /^\/[^/]+\/[^/]+\.git\//.test(path);
  if (!isApiSurface && c.env.ASSETS) {
    return c.env.ASSETS.fetch(c.req.raw);
  }
  return apiError(c, 404, 'not_found', 'no such route');
});
app.onError((err, c) => errorResponse(c, err));
