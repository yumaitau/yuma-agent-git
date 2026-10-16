import { Hono } from 'hono';
import type { Env } from '../env';
import document from '../../../docs/openapi.json';

/**
 * `GET /api/v1/openapi.json` (issue #28): the committed, CI-checked document
 * from `npm run docs:openapi`. Like the rest of /api it needs a signed-in
 * caller; the body is the same for everyone, so clients may cache it briefly.
 */
export const openapiRoutes = new Hono<{ Bindings: Env }>();

openapiRoutes.get('/openapi.json', (c) =>
  c.json(document, 200, { 'cache-control': 'private, max-age=300' }),
);
