import type { Command } from 'commander';
import { z } from 'zod';
import type { RequestBody } from '@yuma/agent-git-sdk';
import { loadConfig, loadState } from '../config.js';
import { forgeFor, resolveTarget, Forge, type Deps } from '../forge.js';

/**
 * `yag pr …`, shaped like `gh pr …` (issue #74), over the GitHub compatible
 * API. Works from a plain Git checkout of the forge (branches, `git fetch`)
 * and from a `yag` working copy (changesets).
 */

const userSchema = z.object({ login: z.string() });
const sideSchema = z.object({ ref: z.string(), sha: z.string(), changeset: z.string() });
export const pullSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.string(),
  draft: z.boolean(),
  merged: z.boolean(),
  user: userSchema.nullable(),
  head: sideSchema,
  base: sideSchema,
  html_url: z.string(),
  mergeable: z.boolean().optional(),
});
type Pull = z.infer<typeof pullSchema>;
const checkRunSchema = z.object({
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  details_url: z.string().nullable(),
});

const number = (value: string): number => z.coerce.number().int().min(1).parse(value);

function stateOf(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  if (pull.draft) return 'DRAFT';
  return pull.state.toUpperCase();
}

export function pullLine(pull: Pull): string {
  return [`#${pull.number}`, stateOf(pull), pull.title, pull.head.ref].join('\t');
}

async function getPull(forge: Forge, n: string): Promise<Pull> {
  return pullSchema.parse(await forge.gh('GET', `/pulls/${number(n)}`));
}

export function registerPr(program: Command, deps: Deps): void {
  const pr = program.command('pr').description('Pull requests, like gh pr');
  const repoOption = (cmd: Command) =>
    cmd.option('-R, --repo <owner/name>', 'repository (default: this checkout)');

  repoOption(
    pr
      .command('create', { isDefault: true })
      .description('Open a pull request from a pushed branch, or from a yag working copy')
      .requiredOption('-t, --title <title>', 'pull request title')
      .option('-b, --body <body>', 'description', '')
      .option(
        '-H, --head <branch>',
        'branch holding the changes (default: current branch)',
      )
      .option('-B, --base <branch>', 'target branch (default: the default branch)')
      .option('-d, --draft', 'start as a draft', false),
  ).action(
    async (opts: {
      repo?: string;
      title: string;
      body: string;
      head?: string;
      base?: string;
      draft: boolean;
    }) => {
      const forge = await forgeFor(deps, opts);
      const workcopy = await loadConfig(deps.cwd).catch(() => null);
      if (workcopy && !opts.head) {
        // a yag working copy proposes its checked-out changeset
        const state = await loadState(deps.cwd);
        const body: RequestBody<'createPull'> = {
          title: opts.title,
          body: opts.body,
          head_cs: state.cs,
          draft: opts.draft,
        };
        const { pull } = z
          .object({ pull: z.object({ id: z.number() }) })
          .parse(await forge.native('POST', '/pulls', body));
        deps.out(`${forge.target.api}/r/${forge.target.repo}/pulls/${pull.id}`);
        return;
      }
      const head =
        opts.head ??
        (await deps.git(['symbolic-ref', '--short', 'HEAD'], deps.cwd)).trim();
      const base =
        opts.base ??
        z.object({ default_branch: z.string() }).parse(await forge.gh('GET', ''))
          .default_branch;
      const body: RequestBody<'ghCreatePull'> = {
        title: opts.title,
        body: opts.body,
        head,
        base,
        draft: opts.draft,
      };
      try {
        deps.out(pullSchema.parse(await forge.gh('POST', '/pulls', body)).html_url);
      } catch (err) {
        if ((err as { code?: string }).code === 'revision_not_found')
          throw new Error(`Branch ${head} is not on the forge: git push origin ${head}`);
        throw err;
      }
    },
  );

  repoOption(
    pr
      .command('list')
      .option('-s, --state <state>', 'open, closed or all', 'open')
      .option('-B, --base <branch>', 'only pull requests into this branch')
      .option('-L, --limit <n>', 'at most this many', '30')
      .option('--json', 'print the GitHub-shaped JSON'),
  ).action(
    async (opts: {
      repo?: string;
      state: string;
      base?: string;
      limit: string;
      json?: boolean;
    }) => {
      const forge = await forgeFor(deps, opts);
      const params = new URLSearchParams({
        state: z.enum(['open', 'closed', 'all']).parse(opts.state),
        per_page: String(Math.min(number(opts.limit), 100)),
      });
      if (opts.base) params.set('base', opts.base);
      const pulls = z.array(pullSchema).parse(await forge.gh('GET', `/pulls?${params}`));
      if (opts.json) return deps.out(JSON.stringify(pulls, null, 2));
      if (pulls.length === 0) deps.err('No pull requests match.');
      for (const p of pulls) deps.out(pullLine(p));
    },
  );

  repoOption(
    pr
      .command('view')
      .argument('<number>')
      .option('--json', 'print the GitHub-shaped JSON'),
  ).action(async (n: string, opts: { repo?: string; json?: boolean }) => {
    const forge = await forgeFor(deps, opts);
    const raw = await forge.gh('GET', `/pulls/${number(n)}`);
    if (opts.json) return deps.out(JSON.stringify(raw, null, 2));
    const p = pullSchema.parse(raw);
    deps.out(`${p.title} #${p.number}`);
    deps.out(
      `${stateOf(p)} • ${p.user?.login ?? 'unknown'} wants to merge ${p.head.ref} into ${p.base.ref}`,
    );
    if (p.mergeable !== undefined)
      deps.out(p.mergeable ? 'Ready to merge' : 'Not mergeable yet');
    if (p.body) deps.out(`\n${p.body}`);
    deps.out(`\n${p.html_url}`);
  });

  repoOption(
    pr
      .command('checkout')
      .argument('<number>')
      .option('-b, --branch <name>', 'local branch name (default: pr-<number>)')
      .option('--remote <name>', 'Git remote of the forge', 'origin'),
  ).action(
    async (n: string, opts: { repo?: string; branch?: string; remote: string }) => {
      const target = await resolveTarget(deps, opts);
      const forge = new Forge(target, deps.fetch);
      const p = await getPull(forge, n);
      const workcopy = await loadConfig(deps.cwd).catch(() => null);
      if (workcopy) {
        const { checkout } = await import('../checkout.js');
        const { YagApi } = await import('../api.js');
        const { ObjectCache } = await import('../cache.js');
        const { homedir } = await import('node:os');
        const { join } = await import('node:path');
        const result = await checkout({
          api: new YagApi({ api: target.api, repo: target.repo, token: target.token }),
          cache: new ObjectCache(
            deps.env.YAG_CACHE_DIR ?? join(homedir(), '.yag', 'objects'),
          ),
          dir: deps.cwd,
          rev: p.head.changeset,
          prefixes: [],
        });
        deps.out(`Checked out pull request #${p.number} at ${result.cs}`);
        return;
      }
      // plain Git: the forge serves any commit of the repository by SHA
      const branch = opts.branch ?? `pr-${p.number}`;
      await deps.git(['fetch', opts.remote, p.head.sha], deps.cwd);
      const exists = await deps
        .git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], deps.cwd)
        .then(
          () => true,
          () => false,
        );
      if (exists) {
        await deps.git(['checkout', branch], deps.cwd);
        await deps.git(['merge', '--ff-only', 'FETCH_HEAD'], deps.cwd);
      } else {
        await deps.git(['checkout', '-b', branch, 'FETCH_HEAD'], deps.cwd);
      }
      deps.out(`Switched to branch ${branch} at ${p.head.sha.slice(0, 12)}`);
    },
  );

  repoOption(
    pr
      .command('merge')
      .argument('<number>')
      .option('-m, --merge', 'merge commit')
      .option('-s, --squash', 'squash into one commit')
      .option('-r, --rebase', 'rebase onto the base branch')
      .option('--subject <text>', 'merge or squash commit title')
      .option('--body <text>', 'merge or squash commit body')
      .option('--match-head-commit <sha>', 'merge only if the head is still this commit'),
  ).action(
    async (
      n: string,
      opts: {
        repo?: string;
        merge?: boolean;
        squash?: boolean;
        rebase?: boolean;
        subject?: string;
        body?: string;
        matchHeadCommit?: string;
      },
    ) => {
      const forge = await forgeFor(deps, opts);
      const methods = (['merge', 'squash', 'rebase'] as const).filter((m) => opts[m]);
      if (methods.length > 1)
        throw new Error('Pick one of --merge, --squash or --rebase');
      const body: RequestBody<'ghMergePull'> = {
        merge_method: methods[0],
        commit_title: opts.subject,
        commit_message: opts.body,
        sha: opts.matchHeadCommit,
      };
      const result = z
        .object({ sha: z.string() })
        .parse(await forge.gh('PUT', `/pulls/${number(n)}/merge`, body));
      deps.out(`Merged pull request #${number(n)} (${result.sha.slice(0, 12)})`);
    },
  );

  repoOption(
    pr
      .command('review')
      .argument('<number>')
      .option('-a, --approve', 'approve')
      .option('-r, --request-changes', 'request changes')
      .option('-c, --comment', 'comment only')
      .option('-b, --body <text>', 'review body', ''),
  ).action(
    async (
      n: string,
      opts: {
        repo?: string;
        approve?: boolean;
        requestChanges?: boolean;
        comment?: boolean;
        body: string;
      },
    ) => {
      const events = [
        opts.approve && 'APPROVE',
        opts.requestChanges && 'REQUEST_CHANGES',
        opts.comment && 'COMMENT',
      ].filter((e): e is 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT' => Boolean(e));
      if (events.length !== 1)
        throw new Error('Pick one of --approve, --request-changes or --comment');
      const forge = await forgeFor(deps, opts);
      const p = await getPull(forge, n);
      const body: RequestBody<'ghCreateReview'> = {
        event: events[0]!,
        body: opts.body,
        commit_id: p.head.sha,
      };
      const review = z
        .object({ state: z.string() })
        .parse(await forge.gh('POST', `/pulls/${p.number}/reviews`, body));
      deps.out(`Reviewed pull request #${p.number}: ${review.state}`);
    },
  );

  repoOption(pr.command('checks').argument('<number>')).action(
    async (n: string, opts: { repo?: string }) => {
      const forge = await forgeFor(deps, opts);
      const p = await getPull(forge, n);
      const { check_runs: runs } = z
        .object({ check_runs: z.array(checkRunSchema) })
        .parse(await forge.gh('GET', `/commits/${p.head.sha}/check-runs`));
      if (runs.length === 0) deps.err('No checks reported on this pull request.');
      for (const run of runs)
        deps.out(
          [run.name, run.conclusion ?? run.status, run.details_url ?? ''].join('\t'),
        );
      // gh's exit codes: 1 for a failure, 8 while checks are pending
      const bad = runs.some(
        (r) => r.conclusion !== null && !['success', 'skipped'].includes(r.conclusion),
      );
      if (bad) deps.exit(1);
      else if (runs.some((r) => r.conclusion === null)) deps.exit(8);
    },
  );
}
