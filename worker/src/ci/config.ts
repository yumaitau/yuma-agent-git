import { z } from 'zod';
import type { Env } from '../env';
import { q1 } from '../db/client';
import { ApiError } from '../core/errors';

export const MAX_LOG_BYTES = 512 * 1024;
export const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
export const MAX_SOURCE_FILES = 2000;
export const MAX_IMAGE_BYTES = 256 * 1024 * 1024;
/**
 * Cloudflare container instance types the built-in pool can start (issue
 * #52), priced at the published full-CPU rates and rounded up per second:
 * $0.00002 per vCPU-second, $0.0000025 per GiB-second and $0.00000007 per
 * GB-second of disk. standard-2 (the pilot's) is $0.00003584, so 36.
 * A run's two sequential phases never hold two VMs at once.
 */
export const INSTANCE_TYPES = {
  'standard-1': { vcpu: 0.5, memory_gib: 4, disk_gb: 8 },
  'standard-2': { vcpu: 1, memory_gib: 6, disk_gb: 12 },
  'standard-3': { vcpu: 2, memory_gib: 8, disk_gb: 16 },
  'standard-4': { vcpu: 4, memory_gib: 12, disk_gb: 20 },
} as const;
export type InstanceType = keyof typeof INSTANCE_TYPES;
export const INSTANCE_NAMES = Object.keys(INSTANCE_TYPES) as [
  InstanceType,
  ...InstanceType[],
];
export const DEFAULT_INSTANCE: InstanceType = 'standard-2';
export function microsPerSecond(type: InstanceType): number {
  const t = INSTANCE_TYPES[type];
  return Math.ceil(t.vcpu * 20 + t.memory_gib * 2.5 + t.disk_gb * 0.07);
}
/**
 * Deployment access (issue #50), for the settings pipeline and for each v2
 * pipeline job. Jobs get nothing unless they ask.
 */
export const accessFields = {
  environment: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/)
    .nullable()
    .default(null),
  secrets: z
    .array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,99}$/))
    .max(50)
    .default([]),
  permissions: z
    .object({
      id_token: z.enum(['none', 'write']).default('none'),
      packages: z.enum(['none', 'write']).default('none'),
    })
    .default({ id_token: 'none', packages: 'none' }),
  aws: z
    .object({
      role_arn: z.string().regex(/^arn:aws[a-z-]*:iam::\d{12}:role\/[\w+=,.@/-]{1,512}$/),
      region: z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d{1,2}$/),
      session_name: z
        .string()
        .regex(/^[\w+=,.@-]{2,64}$/)
        .optional(),
    })
    .nullable()
    .default(null),
};
export const AWS_NEEDS_ID_TOKEN = 'aws needs permissions.id_token: write';
const policyObject = z.object({
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
    ...accessFields,
  });
const awsNeedsIdToken = (p: { aws: unknown; permissions: { id_token: string } }) =>
  !p.aws || p.permissions.id_token === 'write';
/** The settings pipeline, which always runs on the built-in pool. */
export const policySchema = policyObject.refine(awsNeedsIdToken, AWS_NEEDS_ID_TOKEN);
/** Stored run configs: pipeline jobs may run up to 6 hours (issue #52), within their pool. */
export const MAX_TIMEOUT_S = 6 * 60 * 60;
const storedPolicySchema = policyObject
  .extend({ timeout_seconds: z.number().int().min(30).max(MAX_TIMEOUT_S).default(300) })
  .refine(awsNeedsIdToken, AWS_NEEDS_ID_TOKEN);
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
export function parsePolicy(
  input: unknown,
  schema: z.ZodType<CiPolicy, unknown> = storedPolicySchema,
): CiPolicy {
  const parsed = schema.safeParse(input);
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
export function reservation(
  policy: CiPolicy,
  instance: InstanceType = DEFAULT_INSTANCE,
): number {
  // The deadline covers startup, checks, build, export and publishing together.
  return (policy.timeout_seconds + 30) * microsPerSecond(instance);
}
