import { Hono } from 'hono';
import type { Env } from './env';
import { apiRouter } from './api/router';
import { apiError, errorResponse } from './api/errors';

/**
 * The Hono application. Exported separately from the Worker entry so tests can
 * drive routes through `app.fetch` with miniflare bindings.
 */
export const app = new Hono<{ Bindings: Env }>();

app.get('/healthz', (c) => c.json({ ok: true }));

app.route('/api/v1', apiRouter);

// Every response follows the error envelope — including unrouted URLs.
app.notFound((c) => apiError(c, 404, 'not_found', 'no such route'));
app.onError((err, c) => errorResponse(c, err));
