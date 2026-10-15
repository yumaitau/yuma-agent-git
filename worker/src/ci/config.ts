import { z } from 'zod';
import type { Env } from '../env';
import { q1 } from '../db/client';
import { ApiError } from '../core/errors';

export const MAX_LOG_BYTES = 512 * 1024;
export const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
export const MAX_SOURCE_FILES = 2000;
export const MAX_IMAGE_BYTES = 256 * 1024 * 1024;
// standard-2: 1 vCPU + 6 GiB + 12 GB disk at published full CPU rates.
// Round up $0.00003584/sec. Includes two sequential phases, never two VMs at once.
export const MICROS_PER_SECOND = 36;
export const policySchema = z.object({
  preset: z.enum(['node', 'docker', 'custom']).default('node'),
  commands: z.array(z.string().trim().min(1).max(2000)).min(1).max(8),
  timeout_seconds: z.number().int().min(30).max(600).default(300),
  required_approvals: z.number().int().min(0).max(5).default(1),
  require_checks: z.boolean().default(true),
  protect_default: z.boolean().default(true),
  dockerfile: z
    .string()
    .regex(/^[a-zA-Z0-9_./-]+$/)
    .default('Dockerfile')
    .refine(
      (v) => !v.startsWith('/') && !v.split('/').some((s) => s === '..' || s === ''),
      'Use a relative Dockerfile path',
    ),
  image: z
    .string()
    .regex(/^[a-z0-9][a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9][a-z0-9._/-]+$/)
    .nullable()
    .default(null),
});
import type { CiPolicy } from '../../shared/collaboration';
export type { CiPolicy, CiRun } from '../../shared/collaboration';
export interface Settings {
  repo_id: string;
  version: number;
  config: string;
  updated_at: number;
}
export const PRESETS = {
  node: [
    'npm ci',
    'npm run lint --if-present',
    'npm test --if-present',
    'npm run build --if-present',
  ],
  docker: ['docker build --network=host -f Dockerfile -t yag-check .'],
};
export function parsePolicy(input: unknown): CiPolicy {
  const parsed = policySchema.safeParse(input);
  if (!parsed.success)
    throw new ApiError(
      400,
      'invalid_ci_config',
      parsed.error.issues.map((i) => i.message).join('; '),
    );
  return parsed.data;
}
export async function settings(
  env: Env,
  repoId: string,
): Promise<(Settings & { policy: CiPolicy }) | null> {
  const row = await q1<Settings>(env, 'SELECT * FROM ci_settings WHERE repo_id = ?', [
    repoId,
  ]);
  return row ? { ...row, policy: parsePolicy(JSON.parse(row.config)) } : null;
}
export function monthlyBudget(env: Env): number {
  const value = Number(env.CI_MONTHLY_BUDGET_USD ?? '5');
  if (!Number.isFinite(value) || value <= 0 || value > 1000) return 0;
  return Math.floor(value * 1_000_000);
}
export function reservation(policy: CiPolicy): number {
  // The deadline covers startup, checks, build, export and publishing together.
  return (policy.timeout_seconds + 30) * MICROS_PER_SECOND;
}
