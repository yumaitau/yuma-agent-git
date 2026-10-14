/**
 * Typed errors with stable `code` strings for API responses.
 */

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
