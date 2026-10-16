import type { Env } from '../../env';
import { q1, type RepoRecord } from '../../db/client';
import { commitIdsFor } from '../../git/mapping';
import type { CiRun } from '../config';
import type { RunContext } from '../context';
import { WORKFLOW_DIR } from './analyse';

/**
 * GitHub-style variables (issue #49) for jobs of a translated workflow, so
 * `${{ github.* }}` expressions (ci/gha/translate.ts) and scripts reading
 * `GITHUB_*` see forge values. `GITHUB_WORKSPACE` is set by the translated
 * step itself. Jobs of other pipelines get none.
 */
export async function githubEnv(
  env: Env,
  job: CiRun,
  repo: RepoRecord,
  context: RunContext | null,
): Promise<Record<string, string>> {
  if (!job.pipeline_run_id) return {};
  const run = await q1<{ pipeline: string; name: string }>(
    env,
    'SELECT pipeline, name FROM ci_pipeline_runs WHERE id = ?',
    [job.pipeline_run_id],
  );
  if (!run?.pipeline.startsWith(`${WORKFLOW_DIR.join('/')}/`)) return {};
  const ref = context?.ref ?? '';
  const actor = await q1<{ login: string }>(env, 'SELECT login FROM users WHERE id = ?', [
    job.requested_by,
  ]);
  // known Git ids only: a job does not wait for history to be hashed
  const commit = await commitIdsFor(env, job.repo_id, job.head_cs);
  return {
    GITHUB_ACTIONS: 'true',
    GITHUB_WORKFLOW: run.name,
    GITHUB_SHA: commit?.sha1 ?? '',
    GITHUB_REF: ref,
    GITHUB_REF_NAME: ref.replace(/^refs\/(heads|tags|pull)\//, ''),
    GITHUB_REF_TYPE: ref.startsWith('refs/tags/')
      ? 'tag'
      : ref.startsWith('refs/heads/')
        ? 'branch'
        : '',
    GITHUB_REPOSITORY: repo.slug,
    GITHUB_REPOSITORY_OWNER: repo.slug.split('/')[0]!,
    GITHUB_EVENT_NAME: context?.event ?? '',
    GITHUB_ACTOR: actor?.login ?? '',
    GITHUB_RUN_ID: job.pipeline_run_id,
    GITHUB_JOB: (job.job_key ?? '').split(' ')[0]!,
    GITHUB_SERVER_URL: context?.origin ?? '',
  };
}
