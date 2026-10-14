import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  ApiError,
  InvalidTreeError,
  ObjectCorruptError,
  ObjectNotFoundError,
  ObjectWalkLimitError,
  RequestValidationError,
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
 * Parse a JSON request body at the edge: malformed bodies are a client error
 * (`400 invalid_json`) decided here — not by a blanket SyntaxError mapping,
 * which would misclassify server-side parse failures.
 */
export async function readJsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new RequestValidationError('malformed JSON body', {}, 'invalid_json');
  }
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
  console.error(err);
  return apiError(c, 500, 'internal_error', 'internal error');
}
