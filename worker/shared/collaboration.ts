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
}
export interface Pull {
  id: number;
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
