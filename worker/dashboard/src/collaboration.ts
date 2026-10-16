import { ApiError, apiFetch } from './api';
import type {
  CiPolicy,
  CiRun,
  MergeConflict,
  MergeMethod,
  PipelineJob,
  PipelineRun,
  Pull,
  Review,
} from '../../shared/collaboration';
export type {
  CiPolicy,
  CiRun,
  MergeConflict,
  MergeMethod,
  PipelineJob,
  PipelineRun,
  Pull,
  Review,
};
export interface CiOverview {
  can_admin: boolean;
  can_write: boolean;
  config: CiPolicy | null;
  version: number | null;
  runs: CiRun[];
  enabled: boolean;
  monthly_budget_usd: number;
  reserved_usd: number;
  max_run_usd: number | null;
  registry: string | null;
}
export interface PullDetail {
  pull: Pull;
  reviews: Review[];
  gate: {
    mergeable: boolean;
    reasons: string[];
    /** Methods the repo and rulesets allow, and the one to offer first (#42). */
    methods: MergeMethod[];
    method: MergeMethod;
  };
}
/** `GET …/pulls/:id/conflicts` (#42). */
export interface PullConflicts {
  mergeable: boolean;
  target_cs: string;
  head_cs: string;
  merge_base: string | null;
  conflicts: MergeConflict[];
}
export interface Detection {
  empty: boolean;
  preset: CiPolicy['preset'];
  commands: string[];
  dockerfile?: boolean;
  head_cs?: string;
}
export async function call<T>(
  path: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET',
  body?: unknown,
): Promise<T> {
  const response = await apiFetch(`/api/v1${path}`, { method, body });
  const data = (await response.json()) as T & {
    error?: { code: string; message: string };
  };
  if (!response.ok)
    throw new ApiError(
      response.status,
      data.error?.code ?? 'request_failed',
      data.error?.message ?? 'Request failed',
    );
  return data;
}
