import type { Env } from '../env';
import { q } from '../db/client';
import { diffRevisions } from '../core/diff';
import { TAG_PREFIX } from '../core/refs';
import type { Pull } from '../../shared/collaboration';
import { contextFor, type RunContext, type Trigger } from './context';
import { advancePipelines, startPipeline } from './planner';
import { globMatch, loadPipelines, nextRun, type PipelineFile } from './spec';

/**
 * Which pipeline files run for an event (issue #47). A file that does not
 * parse always records a failed run, so its line-numbered errors show where
 * the event's checks are shown.
 */
export function ciReady(env: Env): boolean {
  return env.CI_ENABLED === 'true' && Boolean(env.CI_QUEUE && env.CI_RUNNER);
}

const matches = (patterns: string[] | undefined, value: string): boolean =>
  !patterns || patterns.some((p) => globMatch(p, value));

/** Changed paths between two revisions, or null when too many to list. */
async function changedPaths(
  env: Env,
  repoId: string,
  from: string,
  to: string,
  mode: 'direct' | 'merge-base',
): Promise<string[] | null> {
  const diff = await diffRevisions(env, repoId, from, to, { mode, maxFiles: 2000 });
  return diff.truncated ? null : diff.files.map((f) => f.path);
}

async function startFiles(
  env: Env,
  files: PipelineFile[],
  base: {
    repoId: string;
    head: string;
    ref: string | null;
    actor: string;
    context: RunContext;
  },
  event: 'push' | 'pull_request',
  wanted: (file: PipelineFile) => Promise<boolean>,
): Promise<string[]> {
  const started: string[] = [];
  for (const file of files) {
    if (file.pipeline && !(await wanted(file))) continue;
    await startPipeline(env, { ...base, ...file, event });
    started.push(
      file.errors
        ? `${file.path}:${file.errors[0]!.line}: ${file.errors[0]!.message}`
        : `started ${file.pipeline!.name}`,
    );
  }
  return started;
}

/** Push trigger for refs moved by receive-pack. Returns lines for `git push` to print. */
export async function pushPipelines(
  env: Env,
  repoId: string,
  trigger: Trigger,
  moves: { name: string; from: string | null; to: string | null }[],
): Promise<string[]> {
  if (!ciReady(env)) return [];
  const messages: string[] = [];
  for (const move of moves) {
    const tag = move.name.startsWith(TAG_PREFIX);
    // Branches and tags only: agent refs are working copies, not events.
    if (!move.to || (!tag && move.name.startsWith('refs/'))) continue;
    const name = tag ? move.name.slice(TAG_PREFIX.length) : move.name;
    const files = await loadPipelines(env, repoId, move.to);
    let paths: string[] | null | undefined;
    const lines = await startFiles(
      env,
      files,
      {
        repoId,
        head: move.to,
        ref: move.name,
        actor: trigger.actor,
        context: contextFor(trigger, 'push', tag ? move.name : `refs/heads/${move.name}`),
      },
      'push',
      async (file) => {
        const on = file.pipeline!.on.push;
        if (on === undefined) return false;
        const own = tag ? on?.tags : on?.branches;
        // A filter on only the other kind of ref leaves this kind out.
        if (!own && (tag ? on?.branches : on?.tags)) return false;
        if (!matches(own, name)) return false;
        if (tag || !on?.paths || !move.from) return true;
        paths ??= await changedPaths(env, repoId, move.from, move.to!, 'direct');
        return !paths || paths.some((p) => matches(on.paths, p));
      },
    );
    messages.push(...lines.map((l) => `CI ${move.name}: ${l}`));
  }
  return messages;
}

/** Pull request trigger. Returns null when the revision has no pipeline files. */
export async function pullPipelines(
  env: Env,
  pull: Pull,
  trigger: Trigger,
): Promise<{ status: string } | null> {
  const files = await loadPipelines(env, pull.repo_id, pull.head_cs);
  if (files.length === 0) return null;
  if (!ciReady(env)) return { status: 'not_started' };
  let paths: string[] | null | undefined;
  const started = await startFiles(
    env,
    files,
    {
      repoId: pull.repo_id,
      head: pull.head_cs,
      ref: `pull/${pull.id}`,
      actor: trigger.actor,
      context: contextFor(trigger, 'pull_request', `refs/pull/${pull.id}/merge`, pull.id),
    },
    'pull_request',
    async (file) => {
      const on = file.pipeline!.on.pull_request;
      if (on === undefined || !matches(on?.branches, pull.base_ref)) return false;
      if (!on?.paths) return true;
      paths ??= await changedPaths(
        env,
        pull.repo_id,
        pull.base_cs,
        pull.head_cs,
        'merge-base',
      );
      return !paths || paths.some((p) => matches(on.paths, p));
    },
  );
  return { status: started.length > 0 ? 'queued' : 'not_started' };
}

/**
 * Cron sweep: re-read schedules when a default branch moves, start pipelines
 * that are due (at most a minute late with the per-minute cron) and retry
 * jobs waiting for a runner slot.
 */
export async function sweepPipelines(env: Env): Promise<void> {
  if (!ciReady(env)) return;
  const now = Date.now();
  const stale = await q<{ repo_id: string; head: string }>(
    env,
    `SELECT r.id AS repo_id, f.head FROM repos r
    JOIN refs f ON f.repo_id = r.id AND f.name = r.default_branch
    LEFT JOIN ci_schedule_scans s ON s.repo_id = r.id
    WHERE s.head_cs IS NULL OR s.head_cs != f.head LIMIT 10`,
  );
  for (const repo of stale) {
    const files = await loadPipelines(env, repo.repo_id, repo.head);
    const wanted = files.flatMap((f) =>
      (f.pipeline?.on.schedule ?? []).map((s) => ({ pipeline: f.path, ...s })),
    );
    // Unchanged entries keep their next time, so a push neither skips nor repeats one.
    const key = (s: { pipeline: string; cron: string; timezone: string }): string =>
      JSON.stringify([s.pipeline, s.cron, s.timezone]);
    const known = new Map(
      (
        await q<{ pipeline: string; cron: string; timezone: string; next_at: number }>(
          env,
          'SELECT * FROM ci_schedules WHERE repo_id = ?',
          [repo.repo_id],
        )
      ).map((s) => [key(s), s.next_at]),
    );
    await env.DB.batch([
      env.DB.prepare('DELETE FROM ci_schedules WHERE repo_id = ?').bind(repo.repo_id),
      ...wanted.map((w) =>
        env.DB.prepare(
          `INSERT INTO ci_schedules (repo_id, pipeline, cron, timezone, next_at) VALUES (?,?,?,?,?)
          ON CONFLICT DO NOTHING`,
        ).bind(
          repo.repo_id,
          w.pipeline,
          w.cron,
          w.timezone,
          known.get(key(w)) ?? nextRun(w.cron, w.timezone, now),
        ),
      ),
      env.DB.prepare(
        `INSERT INTO ci_schedule_scans (repo_id, head_cs) VALUES (?, ?)
        ON CONFLICT (repo_id) DO UPDATE SET head_cs = excluded.head_cs`,
      ).bind(repo.repo_id, repo.head),
    ]);
  }
  const due = await q<{
    repo_id: string;
    pipeline: string;
    cron: string;
    timezone: string;
    next_at: number;
    head: string;
    default_branch: string;
  }>(
    env,
    `SELECT s.*, f.head, r.default_branch FROM ci_schedules s
    JOIN repos r ON r.id = s.repo_id
    JOIN refs f ON f.repo_id = r.id AND f.name = r.default_branch
    WHERE s.next_at <= ? ORDER BY s.next_at LIMIT 10`,
    [now],
  );
  for (const s of due) {
    // Claim the slot first so overlapping sweeps start it once.
    const claimed = await env.DB.prepare(
      `UPDATE ci_schedules SET next_at = ? WHERE repo_id = ? AND pipeline = ? AND cron = ?
      AND timezone = ? AND next_at = ?`,
    )
      .bind(
        nextRun(s.cron, s.timezone, now),
        s.repo_id,
        s.pipeline,
        s.cron,
        s.timezone,
        s.next_at,
      )
      .run();
    if (!claimed.meta.changes) continue;
    const file = (await loadPipelines(env, s.repo_id, s.head)).find(
      (f) => f.path === s.pipeline,
    );
    if (!file?.pipeline?.on.schedule) continue;
    await startPipeline(env, {
      repoId: s.repo_id,
      head: s.head,
      path: file.path,
      pipeline: file.pipeline,
      event: 'schedule',
      ref: s.default_branch,
      actor: 'schedule',
      context: contextFor(
        { actor: 'schedule', actor_kind: 'system', origin: null },
        'schedule',
        `refs/heads/${s.default_branch}`,
      ),
    });
  }
  await advancePipelines(env);
}
