import { Hono } from 'hono';
import type { Env } from './env';
import { apiRouter } from './api/router';

/**
 * The Hono application. Exported separately from the Worker entry so tests can
 * drive routes through `app.fetch` with miniflare bindings.
 */
export const app = new Hono<{ Bindings: Env }>();

app.get('/healthz', (c) => c.json({ ok: true }));

app.route('/api/v1', apiRouter);
