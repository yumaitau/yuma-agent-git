import { Hono } from 'hono';
import type { AppEnv } from '../../auth/principal';
import type { CiRun, PipelineRun } from '../../../shared/collaboration';
import { numericId } from '../../webhooks/payloads';
import {
  apiUrl,
  changesetOf,
  gh,
  iso,
  loadRepo,
  native,
  originOf,
  param,
  PREFIX,
  shaOf,
  type Ctx,
} from './native';

/**
 * Check runs and commit statuses, read from CI (#50 pipelines and the older
 * single-command runs) for a commit. Read only: there is no store for
 * statuses posted by outside tools, so `POST /statuses/:sha` is not offered.
 */
export const checksRoutes = new Hono<AppEnv>();
const REPO = `${PREFIX}/repos/:owner/:repo`;

interface Check {
  key: string;
  name: string;
  state: string;
  run_id: string | null;
  started_at: number | null;
  finished_at: number | null;
  error: string | null;
}

/** GitHub check run `status` and `conclusion` for a native CI state. */
function statusOf(state: string): { status: string; conclusion: string | null } {
  const done: Record<string, string> = {
    passed: 'success',
    failed: 'failure',
    cancelled: 'cancelled',
    skipped: 'skipped',
    expired: 'timed_out',
  };
  if (state in done) return { status: 'completed', conclusion: done[state]! };
  return { status: state === 'running' ? 'in_progress' : 'queued', conclusion: null };
}

/** Commit status `state` for a native CI state. */
function commitStateOf(state: string): 'success' | 'failure' | 'error' | 'pending' {
  const { conclusion } = statusOf(state);
  if (conclusion === null) return 'pending';
  if (conclusion === 'success' || conclusion === 'skipped') return 'success';
  return conclusion === 'failure' ? 'failure' : 'error';
}

async function checksFor(c: Ctx) {
  const repo = await loadRepo(c);
  const cs = await changesetOf(c, repo, param(c, 'ref'));
  const [legacy, pipelines] = await Promise.all([
    native<{ runs: CiRun[] }>(c, 'GET', `${repo.path}/ci`),
    native<{ runs: PipelineRun[] }>(c, 'GET', `${repo.path}/ci/pipelines?head=${cs}`),
  ]);
  const checks: Check[] = [
    ...pipelines.runs.flatMap((run) =>
      run.jobs.map((job) => ({
        key: `${run.id}:${job.key}`,
        name: job.job,
        state: job.state,
        run_id: job.run_id,
        started_at: run.created_at,
        finished_at: statusOf(job.state).conclusion === null ? null : run.finished_at,
        error: job.error,
      })),
    ),
    ...legacy.runs
      .filter((run) => run.head_cs === cs)
      .map((run) => ({
        key: run.id,
        name: 'ci',
        state: run.state,
        run_id: run.id,
        started_at: run.started_at,
        finished_at: run.finished_at,
        error: run.error,
      })),
  ];
  return { repo, sha: await shaOf(c, repo.record.id, cs), checks };
}

checksRoutes.get(
  `${REPO}/commits/:ref/check-runs`,
  gh(async (c) => {
    const { repo, sha, checks } = await checksFor(c);
    const html = `${originOf(c)}/r/${repo.record.slug}/ci`;
    const runs = await Promise.all(
      checks.map(async (check) => {
        const id = await numericId(check.key);
        return {
          id,
          node_id: `${repo.record.id}:check_run:${check.key}`,
          name: check.name,
          head_sha: sha,
          external_id: check.run_id,
          ...statusOf(check.state),
          started_at: iso(check.started_at),
          completed_at: iso(check.finished_at),
          html_url: html,
          details_url: html,
          output: {
            title: check.state,
            summary: check.error ?? '',
            text: null,
            annotations_count: 0,
          },
          app: { slug: 'yag-ci', name: 'Yuma CI' },
          pull_requests: [],
        };
      }),
    );
    return c.json({ total_count: runs.length, check_runs: runs });
  }),
);

async function statuses(c: Ctx) {
  const { repo, sha, checks } = await checksFor(c);
  const html = `${originOf(c)}/r/${repo.record.slug}/ci`;
  const list = await Promise.all(
    checks.map(async (check) => ({
      id: await numericId(`status:${check.key}`),
      node_id: `${repo.record.id}:status:${check.key}`,
      context: check.name,
      state: commitStateOf(check.state),
      description: check.error ?? check.state,
      target_url: html,
      created_at: iso(check.started_at),
      updated_at: iso(check.finished_at ?? check.started_at),
    })),
  );
  return { repo, sha, list };
}

checksRoutes.get(
  `${REPO}/commits/:ref/statuses`,
  gh(async (c) => c.json((await statuses(c)).list)),
);

checksRoutes.get(
  `${REPO}/commits/:ref/status`,
  gh(async (c) => {
    const { repo, sha, list } = await statuses(c);
    const states = list.map((s) => s.state);
    const state = states.some((s) => s === 'failure' || s === 'error')
      ? 'failure'
      : states.length > 0 && states.every((s) => s === 'success')
        ? 'success'
        : 'pending';
    return c.json({
      state,
      sha,
      total_count: list.length,
      statuses: list,
      repository: { full_name: repo.record.slug },
      url: apiUrl(c, `/repos/${repo.record.slug}/commits/${sha}/status`),
    });
  }),
);
