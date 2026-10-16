import type { Command } from 'commander';
import { z } from 'zod';
import { forgeFor, type Deps, type Forge } from '../forge.js';

/**
 * `yag run …`, shaped like `gh run …` (issue #74), over native CI routes:
 * pipeline runs (#50) and their jobs, plus single-command CI runs.
 */

const jobSchema = z.object({
  key: z.string(),
  job: z.string(),
  state: z.string(),
  run_id: z.string().nullable(),
  error: z.string().nullable(),
});
const pipelineRunSchema = z.object({
  id: z.string(),
  name: z.string(),
  event: z.string(),
  ref: z.string().nullable(),
  head_cs: z.string(),
  state: z.string(),
  created_at: z.number(),
  jobs: z.array(jobSchema),
});
const ciRunSchema = z.object({
  id: z.string(),
  head_cs: z.string(),
  state: z.string(),
  created_at: z.number(),
  error: z.string().nullable(),
});

interface Run {
  id: string;
  name: string;
  event: string;
  state: string;
  head_cs: string;
  created_at: number;
  /** CI run ids holding logs, with their job names. */
  jobs: { name: string; state: string; run_id: string | null; error: string | null }[];
}

async function runs(forge: Forge): Promise<Run[]> {
  const [pipelines, ci] = await Promise.all([
    forge.native('GET', '/ci/pipelines'),
    forge.native('GET', '/ci'),
  ]);
  const fromPipelines = z
    .object({ runs: z.array(pipelineRunSchema) })
    .parse(pipelines)
    .runs.map((r) => ({
      ...r,
      jobs: r.jobs.map((j) => ({ ...j, name: j.job })),
    }));
  const single = z
    .object({ runs: z.array(ciRunSchema) })
    .parse(ci)
    .runs.map((r) => ({
      id: r.id,
      name: 'ci',
      event: 'ci',
      state: r.state,
      head_cs: r.head_cs,
      created_at: r.created_at,
      jobs: [{ name: 'ci', state: r.state, run_id: r.id, error: r.error }],
    }));
  return [...fromPipelines, ...single].sort((a, b) => b.created_at - a.created_at);
}

async function find(forge: Forge, id: string): Promise<Run> {
  const all = await runs(forge);
  const run =
    all.find((r) => r.id === id) ?? all.find((r) => r.jobs.some((j) => j.run_id === id));
  if (!run) throw new Error(`No run ${id} in the recent runs`);
  // a job's run id narrows the run to that job
  return run.id === id ? run : { ...run, jobs: run.jobs.filter((j) => j.run_id === id) };
}

async function logs(forge: Forge, run: Run, out: (line: string) => void): Promise<void> {
  for (const job of run.jobs) {
    if (!job.run_id) {
      out(`== ${job.name} (${job.state}): no log yet`);
      continue;
    }
    const res = await forge.raw(
      'GET',
      `/api/v1/repos/${forge.target.repo}/ci/runs/${encodeURIComponent(job.run_id)}/log`,
    );
    if (!res.ok) throw new Error(`Log for ${job.name}: HTTP ${res.status}`);
    out(`== ${job.name} (${job.state})`);
    out(await res.text());
  }
}

export function registerRun(program: Command, deps: Deps): void {
  const run = program.command('run').description('CI runs, like gh run');
  const repoOption = (cmd: Command) =>
    cmd.option('-R, --repo <owner/name>', 'repository (default: this checkout)');

  repoOption(
    run.command('list').option('-L, --limit <n>', 'at most this many', '20'),
  ).action(async (opts: { repo?: string; limit: string }) => {
    const forge = await forgeFor(deps, opts);
    const all = (await runs(forge)).slice(0, Number(opts.limit) || 20);
    if (all.length === 0) deps.err('No runs yet.');
    for (const r of all)
      deps.out(
        [
          r.id,
          r.state,
          r.name,
          r.event,
          r.head_cs.slice(0, 12),
          new Date(r.created_at).toISOString(),
        ].join('\t'),
      );
  });

  repoOption(
    run
      .command('view')
      .argument('<id>', 'pipeline run id, or a job run id')
      .option('--log', 'print the job logs'),
  ).action(async (id: string, opts: { repo?: string; log?: boolean }) => {
    const forge = await forgeFor(deps, opts);
    const r = await find(forge, id);
    if (opts.log) return logs(forge, r, deps.out);
    deps.out(`${r.name} ${r.id}: ${r.state} (${r.event} at ${r.head_cs.slice(0, 12)})`);
    for (const j of r.jobs)
      deps.out(
        `  ${j.name}\t${j.state}${j.run_id ? `\t${j.run_id}` : ''}${j.error ? `\t${j.error}` : ''}`,
      );
  });

  repoOption(run.command('log').argument('<id>')).action(
    async (id: string, opts: { repo?: string }) => {
      const forge = await forgeFor(deps, opts);
      await logs(forge, await find(forge, id), deps.out);
    },
  );

  repoOption(
    run
      .command('rerun')
      .argument('<id>', 'pipeline run id (reruns its failed jobs), or a job run id'),
  ).action(async (id: string, opts: { repo?: string }) => {
    const forge = await forgeFor(deps, opts);
    const r = await find(forge, id);
    const again = r.jobs.filter(
      (j) =>
        j.run_id && (r.id !== id || !['passed', 'running', 'queued'].includes(j.state)),
    );
    if (again.length === 0) throw new Error('Nothing to rerun: no failed jobs');
    for (const j of again) {
      const retried = z
        .union([
          z.object({ run: z.object({ id: z.string(), state: z.string() }) }),
          z.object({ approval: z.object({ id: z.string() }) }),
        ])
        .parse(
          await forge.native('POST', `/ci/runs/${encodeURIComponent(j.run_id!)}/retry`),
        );
      deps.out(
        'run' in retried
          ? `${j.name}: ${retried.run.id} ${retried.run.state}`
          : `${j.name}: waiting for approval ${retried.approval.id}`,
      );
    }
  });
}
