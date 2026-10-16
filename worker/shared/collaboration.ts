/** Wire contracts shared by the browser and Worker; no runtime or platform imports. */
export interface CiPolicy {
  preset: 'node' | 'docker' | 'custom';
  commands: string[];
  timeout_seconds: number;
  required_approvals: number;
  require_checks: boolean;
  protect_default: boolean;
  dockerfile: string;
  image: string | null;
  /** Deployment environment whose protection rules gate the run (issue #50). */
  environment: string | null;
  /** Secret names injected as environment variables. */
  secrets: string[];
  /** `id_token: 'write'` lets the job request OIDC tokens. */
  permissions: { id_token: 'none' | 'write' };
  /** AWS web identity: the runner writes a token file and sets AWS_* variables. */
  aws: { role_arn: string; region: string; session_name?: string } | null;
}
export interface CiRun {
  id: string;
  repo_id: string;
  head_cs: string;
  settings_version: number;
  config: string;
  requested_by: string;
  state: string;
  publish: number;
  month: string;
  reserved_micros: number;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  deadline: number | null;
  log_key: string | null;
  image: string | null;
  error: string | null;
  /** Set for jobs of a v2 pipeline run. */
  pipeline_run_id?: string | null;
  job_key?: string | null;
  /** Trigger context JSON (issue #50); null for older runs. */
  context?: string | null;
}
/** A line-numbered problem in a pipeline file. */
export interface SpecError {
  line: number;
  column: number;
  message: string;
}
export interface PipelineJob {
  key: string;
  job: string;
  needs: string[];
  state: string;
  run_id: string | null;
  error: string | null;
  /** Deployment environment the job is gated on (issue #50). */
  environment: string | null;
  /** Its approval request, once the job is ready and the environment needs one. */
  approval: { id: string; state: string } | null;
}
export interface PipelineRun {
  id: string;
  pipeline: string;
  name: string;
  event: 'push' | 'pull_request' | 'manual' | 'schedule';
  ref: string | null;
  head_cs: string;
  concurrency_group: string | null;
  state: string;
  errors: SpecError[] | null;
  requested_by: string;
  created_at: number;
  finished_at: number | null;
  jobs: PipelineJob[];
}
export interface Pull {
  id: number;
  /** Per-repo number shared with issues (issue #38); `#N` in references. */
  number: number;
  repo_id: string;
  title: string;
  body: string;
  author_id: string;
  base_ref: string;
  base_cs: string;
  head_cs: string;
  state: string;
  revision: number;
  created_at: number;
  updated_at: number;
  merged_at: number | null;
  /** Set once merged (issue #42): the method and the changeset the target moved to. */
  merge_method?: MergeMethod | null;
  merged_cs?: string | null;
}
export interface Review {
  revision: number;
  id: number;
  pull_id: number;
  author_id: string;
  head_cs: string;
  decision: string;
  body: string;
  created_at: number;
}
/** How a pull request lands on its target (issue #42). */
export const MERGE_METHODS = ['merge', 'squash', 'rebase'] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];
/** One side of a conflicting region: 1-based first line and the lines themselves. */
export interface ConflictSide {
  start: number;
  lines: string[];
}
export interface ConflictHunk {
  base: ConflictSide;
  ours: ConflictSide;
  theirs: ConflictSide;
}
/**
 * A path the server could not merge. `ours` is the side being merged into,
 * `theirs` the incoming change. Only `content` and `add_add` carry hunks.
 */
export interface MergeConflict {
  path: string;
  kind:
    | 'content'
    | 'add_add'
    | 'modify_delete'
    | 'file_directory'
    | 'mode'
    | 'binary'
    | 'too_large'
    | 'unsupported'
    | 'multiple_merge_bases';
  hunks?: ConflictHunk[];
}
/** A comment in a line-level review thread (issue #39). */
export interface ReviewComment {
  id: number;
  thread_id: number;
  /** `user:<id>` or `agent:<agent or token id>`. */
  author: string;
  body: string;
  /** Replacement text for the thread's lines, from a fenced `suggestion` block. */
  suggestion_patch: string | null;
  /** The review this comment was submitted with, if any. */
  review_id: number | null;
  created_at: number;
}
export interface ReviewThread {
  id: number;
  pull_id: number;
  path: string;
  /** `head`: lines of the proposed revision. `base`: lines on the left of the diff. */
  side: 'base' | 'head';
  start_line: number;
  end_line: number;
  /** Pull request revision the anchor was last checked on. */
  revision: number;
  /** Changeset whose file the line numbers refer to. */
  anchor_cs: string;
  original_head_cs: string;
  /** The lines changed in a later revision; the anchor stays on the old one. */
  outdated: boolean;
  author: string;
  resolved_by: string | null;
  resolved_at: number | null;
  created_at: number;
  /** The anchored lines as they read at `anchor_cs` (null for oversized files). */
  snippet: string | null;
  comments: ReviewComment[];
}
export interface ReviewRequest {
  /** `user:<id>`, `team:<id>` or `agent:<id>`. */
  principal: string;
  requested_by: string;
  state: 'pending' | 'reviewed';
  created_at: number;
  updated_at: number;
}
