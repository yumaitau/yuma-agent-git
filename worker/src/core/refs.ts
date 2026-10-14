import type { Env } from '../env';
import type { RefRecord } from '../db/client';
import { getRef, listRefs } from '../db/repos';
import { ApiError, ConflictError, RequestValidationError } from './errors';

export { getRef, listRefs };
export type { RefRecord };

/**
 * Refs are discouraged global state (architecture §1.4): exactly `main` per
 * repo plus optional release refs. Everything else is a changeset id.
 */
export const REF_NAME_RE = /^(main|release\/[a-z0-9._-]+)$/;

export function validateRefName(name: string): string {
  if (name.length > 64 || !REF_NAME_RE.test(name)) {
    throw new RequestValidationError(
      `invalid ref name ${JSON.stringify(name)}: only "main" and "release/*" exist (refs are discouraged)`,
      { name },
      'invalid_ref_name',
    );
  }
  return name;
}

/** Direct D1 read of a ref head (stale reads acceptable for `ref:` resolution). */
export async function readRefHead(
  env: Env,
  repoId: string,
  name: string,
): Promise<string | null> {
  const ref = await getRef(env, repoId, name);
  return ref ? ref.head : null;
}

export interface MoveRefInput {
  from: string | null;
  to: string;
  force?: boolean;
}

export interface MoveRefResult {
  ok: true;
  from: string | null;
  to: string;
}

interface MoveRefErrorBody {
  error?: {
    code?: string;
    message?: string;
    expected?: string | null;
    actual?: string | null;
  };
}

/**
 * Move a ref through its `RefLockDO` — one DO per (repo, ref), so the
 * compare-and-swap is race-free even under parallel land attempts.
 */
export async function moveRefViaDO(
  env: Env,
  repoId: string,
  name: string,
  input: MoveRefInput,
): Promise<MoveRefResult> {
  const id = env.REF_LOCK.idFromName(`${repoId}:${name}`);
  const stub = env.REF_LOCK.get(id);
  const res = await stub.fetch('https://ref-lock/move', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      repo_id: repoId,
      name,
      from: input.from,
      to: input.to,
      force: input.force ?? false,
    }),
  });

  const body = (await res.json()) as MoveRefErrorBody & MoveRefResult;
  if (res.ok) return body;

  const error = body.error ?? {};
  const code = error.code ?? 'internal_error';
  const message = error.message ?? 'ref move failed';
  if (res.status === 409) {
    throw new ConflictError(code, message, {
      expected: error.expected ?? input.from,
      actual: error.actual ?? null,
    });
  }
  if (res.status === 400) {
    throw new RequestValidationError(message, {}, code);
  }
  throw new ApiError(res.status, code, message);
}
