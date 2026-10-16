import { z } from 'zod';
import type { Env } from '../env';
import type { RefRecord } from '../db/client';
import { getRef, listRefs } from '../db/repos';
import { run } from '../db/client';
import { ApiError, ConflictError, RequestValidationError } from './errors';
import { timePhase } from '../observability/phase';
import { recordRefMove } from '../observability/metrics';

export { getRef, listRefs };
export type { RefRecord };

/**
 * Ref naming (issue #33). Branches use short names (`main`, `feature/x`);
 * tags and agent work refs use full names under `refs/tags/` and
 * `refs/agents/<agent>/`. Any other `refs/...` name is rejected so a branch
 * can never alias another namespace.
 *
 * `scion` repos (the pilot, architecture §1.4) keep the old rule: `main`,
 * `release/*` and short-lived agent refs. `git` repos accept any name Git's
 * `check-ref-format` accepts.
 */
export type RefsMode = 'scion' | 'git';

export const SCION_REF_RE = /^(main|release\/[a-z0-9._-]+)$/;
export const TAG_PREFIX = 'refs/tags/';
export const AGENT_PREFIX = 'refs/agents/';
const AGENT_REF_RE = /^refs\/agents\/([A-Za-z0-9_-]+)\/./;
/** Agent work refs untouched for this long are deleted by the cron sweep. */
export const AGENT_REF_TTL_MS = 7 * 86400_000;

/** Git `check-ref-format` rules, plus `git branch`'s no `HEAD` and no leading `-`. */
export function checkRefFormat(name: string): boolean {
  if (name === '' || name === '@' || name === 'HEAD' || name.startsWith('-'))
    return false;
  if (name.length > 255 || name.endsWith('.')) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return false;
  if (name.includes('..') || name.includes('@{')) return false;
  // empty components cover leading, trailing and doubled slashes
  return name
    .split('/')
    .every((part) => part !== '' && !part.startsWith('.') && !part.endsWith('.lock'));
}

/** The agent id that owns a `refs/agents/<id>/...` ref, else null. */
export function agentRefOwner(name: string): string | null {
  return AGENT_REF_RE.exec(name)?.[1] ?? null;
}

export function validateRefName(name: string, mode: RefsMode = 'git'): string {
  let ok = checkRefFormat(name);
  if (ok && name.startsWith('refs/')) {
    ok = agentRefOwner(name) !== null || (mode === 'git' && name.startsWith(TAG_PREFIX));
  } else if (ok && mode === 'scion') {
    ok = SCION_REF_RE.test(name);
  }
  if (!ok) {
    throw new RequestValidationError(
      mode === 'scion'
        ? `invalid ref name ${JSON.stringify(name)}: this repository only allows "main", "release/*" and agent refs`
        : `invalid ref name ${JSON.stringify(name)}: not a valid Git ref name`,
      { name },
      'invalid_ref_name',
    );
  }
  return name;
}

/** Branch names (default branch, PR bases) are short names outside `refs/`. */
export function validateBranchName(name: string, mode: RefsMode = 'git'): string {
  if (name.startsWith('refs/')) {
    throw new RequestValidationError(
      `invalid branch name ${JSON.stringify(name)}`,
      { name },
      'invalid_ref_name',
    );
  }
  return validateRefName(name, mode);
}

/** Cron sweep: drop agent work refs idle longer than `AGENT_REF_TTL_MS`. */
export async function expireAgentRefs(env: Env, now: number = Date.now()): Promise<void> {
  await run(env, `DELETE FROM refs WHERE name LIKE 'refs/agents/%' AND updated_at < ?`, [
    now - AGENT_REF_TTL_MS,
  ]);
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
  /** null deletes the ref. */
  to: string | null;
  force?: boolean;
  /** Allow a non-fast-forward move, still compare-and-swap on `from`. */
  non_ff?: boolean;
}

export interface MoveRefResult {
  ok: true;
  from: string | null;
  to: string | null;
}

interface MoveRefErrorBody {
  error?: {
    code?: string;
    message?: string;
    expected?: string | null;
    actual?: string | null;
  };
}

const moveResultSchema = z.object({
  ok: z.literal(true),
  from: z.string().min(1).nullable(),
  to: z.string().min(1).nullable(),
});

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
  const res = await timePhase('do', () =>
    stub.fetch('https://ref-lock/move', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repo_id: repoId,
        name,
        from: input.from,
        to: input.to,
        force: input.force ?? false,
        non_ff: input.non_ff ?? false,
      }),
    }),
  );

  const body = (await res.json()) as MoveRefErrorBody & MoveRefResult;
  if (res.ok) {
    // Never trust an unvalidated DO response shape.
    const parsed = moveResultSchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(
        502,
        'ref_lock_bad_response',
        'ref lock returned an invalid response',
      );
    }
    await recordRefMove(env, false);
    return parsed.data;
  }

  const error = body.error ?? {};
  const code = error.code ?? 'internal_error';
  const message = error.message ?? 'ref move failed';
  if (res.status === 409) {
    await recordRefMove(env, true);
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
