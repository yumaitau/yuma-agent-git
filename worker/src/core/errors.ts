/**
 * Typed errors with stable `code` strings for API responses.
 */

/** Base for errors carrying an HTTP status + stable machine-readable code. */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** 400 — request failed validation (zod, path rules, semantic checks). */
export class RequestValidationError extends ApiError {
  constructor(
    message: string,
    details: Record<string, unknown> = {},
    code = 'invalid_request',
  ) {
    super(400, code, message, details);
    this.name = 'RequestValidationError';
  }
}

/** 404 — resource does not exist (or must not be seen to exist). */
export class NotFoundError extends ApiError {
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(404, code, message, details);
    this.name = 'NotFoundError';
  }
}

/** 403 — principal lacks permission. */
export class ForbiddenError extends ApiError {
  constructor(message = 'forbidden', details: Record<string, unknown> = {}) {
    super(403, 'forbidden', message, details);
    this.name = 'ForbiddenError';
  }
}

/** 409 — state conflict (e.g. stale ref compare-and-swap). */
export class ConflictError extends ApiError {
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(409, code, message, details);
    this.name = 'ConflictError';
  }
}

/** 413 — payload too large. */
export class PayloadTooLargeError extends ApiError {
  constructor(
    message: string,
    code = 'payload_too_large',
    details: Record<string, unknown> = {},
  ) {
    super(413, code, message, details);
    this.name = 'PayloadTooLargeError';
  }
}

export class ObjectCorruptError extends Error {
  readonly code = 'object_corrupt';
  constructor(
    readonly kind: 'blob' | 'tree',
    readonly hash: string,
    message: string,
  ) {
    super(`corrupt ${kind} ${hash}: ${message}`);
    this.name = 'ObjectCorruptError';
  }
}

export class ObjectNotFoundError extends Error {
  readonly code = 'object_not_found';
  constructor(
    readonly kind: 'blob' | 'tree',
    readonly hash: string,
  ) {
    super(`${kind} ${hash} not found`);
    this.name = 'ObjectNotFoundError';
  }
}

export class InvalidTreeError extends Error {
  readonly code = 'invalid_tree';
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTreeError';
  }
}

export class ObjectWalkLimitError extends Error {
  readonly code = 'object_walk_limit';
  constructor(readonly maxObjects: number) {
    super(`object walk exceeded maxObjects=${maxObjects}`);
    this.name = 'ObjectWalkLimitError';
  }
}
