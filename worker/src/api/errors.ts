import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  ApiError,
  InvalidTreeError,
  ObjectCorruptError,
  ObjectNotFoundError,
  ObjectWalkLimitError,
} from '../core/errors';

/** The `{ error: { code, message } }` response envelope. */
export function apiError(
  c: Context,
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  return c.json({ error: { code, message, ...extra } }, status as ContentfulStatusCode);
}

/**
 * Map thrown errors to the envelope. Typed `ApiError`s carry their own
 * status/code; known core errors get stable mappings; anything else is a
 * logged 500 (never leaking internals).
 */
export function errorResponse(c: Context, err: unknown): Response {
  if (err instanceof ApiError) {
    return apiError(c, err.status, err.code, err.message, err.details);
  }
  if (err instanceof ObjectNotFoundError) {
    return apiError(c, 404, err.code, err.message);
  }
  if (err instanceof InvalidTreeError) {
    return apiError(c, 400, err.code, err.message);
  }
  if (err instanceof ObjectWalkLimitError) {
    return apiError(c, 413, err.code, err.message);
  }
  if (err instanceof ObjectCorruptError) {
    console.error('corrupt object', err);
    return apiError(c, 500, err.code, err.message);
  }
  if (err instanceof SyntaxError) {
    return apiError(c, 400, 'invalid_json', 'malformed JSON body');
  }
  console.error(err);
  return apiError(c, 500, 'internal_error', 'internal error');
}
