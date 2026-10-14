import { Hono } from 'hono';
import { apiRouter } from './api/router';
import { apiError, errorResponse } from './api/errors';
import { adminRoutes } from './api/admin';
import { authRoutes } from './auth/oauth';
import { githubRoutes } from './bridge/github';
import { authMiddleware } from './auth/session';
import { tokensRoutes } from './auth/tokens';
import { reposRoutes } from './api/repos';
import { webhooksRoutes } from './api/webhooks';
import type { AppEnv } from './auth/principal';

/**
 * The Hono application. Exported separately from the Worker entry so tests can
 * drive routes through `app.fetch` with miniflare bindings.
 */
export const app = new Hono<AppEnv>();

// Resolves `user` + `principal` on every request (never 401s by itself).
app.use('*', authMiddleware);

app.get('/healthz', (c) => c.json({ ok: true }));

// These modules declare absolute paths (outside /api/v1): OAuth, webhooks,
// the GitHub App handshake, and token management.
app.route('/', authRoutes);
app.route('/', tokensRoutes);
app.route('/', webhooksRoutes);
app.route('/', githubRoutes);
app.route('/', adminRoutes);
app.route('/', reposRoutes);
app.route('/api/v1', apiRouter);

// Every response follows the error envelope — including unrouted URLs.
app.notFound((c) => apiError(c, 404, 'not_found', 'no such route'));
app.onError((err, c) => errorResponse(c, err));
