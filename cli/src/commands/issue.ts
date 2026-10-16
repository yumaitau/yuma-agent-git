import type { Command } from 'commander';
import { z } from 'zod';
import type { QueryParams, RequestBody } from '@yuma/agent-git-sdk';
import { forgeFor, type Deps } from '../forge.js';

/** `yag issue …`, shaped like `gh issue …` (issue #74), over the GitHub compatible API. */

const userSchema = z.object({ login: z.string() });
export const issueSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.string(),
  state_reason: z.string().nullable().optional(),
  user: userSchema.nullable(),
  labels: z.array(z.object({ name: z.string() })),
  assignees: z.array(userSchema),
  html_url: z.string(),
  comments: z.number().optional(),
});
const commentSchema = z.object({
  body: z.string(),
  user: userSchema.nullable(),
  created_at: z.string().nullable(),
});

const number = (value: string): number => z.coerce.number().int().min(1).parse(value);

export function issueLine(issue: z.infer<typeof issueSchema>): string {
  return [
    `#${issue.number}`,
    issue.state.toUpperCase(),
    issue.title,
    issue.labels.map((l) => l.name).join(', '),
  ].join('\t');
}

export function registerIssue(program: Command, deps: Deps): void {
  const issue = program.command('issue').description('Issues, like gh issue');
  const repoOption = (cmd: Command) =>
    cmd.option('-R, --repo <owner/name>', 'repository (default: this checkout)');

  repoOption(
    issue
      .command('list')
      .option('-s, --state <state>', 'open, closed or all', 'open')
      .option('-l, --label <names...>', 'only issues with all these labels')
      .option('-a, --assignee <login>', 'only issues assigned to this login')
      .option('-L, --limit <n>', 'at most this many', '30')
      .option('--json', 'print the GitHub-shaped JSON'),
  ).action(
    async (opts: {
      repo?: string;
      state: string;
      label?: string[];
      assignee?: string;
      limit: string;
      json?: boolean;
    }) => {
      const forge = await forgeFor(deps, opts);
      const query: QueryParams<'ghListIssues'> = {
        state: z.enum(['open', 'closed', 'all']).parse(opts.state),
        per_page: Math.min(number(opts.limit), 100),
      };
      if (opts.label) query.labels = opts.label.join(',');
      if (opts.assignee) query.assignee = opts.assignee;
      const params = new URLSearchParams(
        Object.entries(query).map(([k, v]): [string, string] => [k, String(v)]),
      );
      const issues = z
        .array(issueSchema)
        .parse(await forge.gh('GET', `/issues?${params}`));
      if (opts.json) return deps.out(JSON.stringify(issues, null, 2));
      if (issues.length === 0) deps.err('No issues match.');
      for (const i of issues) deps.out(issueLine(i));
    },
  );

  repoOption(
    issue
      .command('create')
      .requiredOption('-t, --title <title>', 'issue title')
      .option('-b, --body <body>', 'description', '')
      .option('-l, --label <names...>', 'labels to add')
      .option('-a, --assignee <logins...>', 'people to assign'),
  ).action(
    async (opts: {
      repo?: string;
      title: string;
      body: string;
      label?: string[];
      assignee?: string[];
    }) => {
      const forge = await forgeFor(deps, opts);
      const body: RequestBody<'ghCreateIssue'> = {
        title: opts.title,
        body: opts.body,
        labels: opts.label,
        assignees: opts.assignee,
      };
      const created = issueSchema.parse(await forge.gh('POST', '/issues', body));
      deps.out(created.html_url);
    },
  );

  repoOption(
    issue
      .command('view')
      .argument('<number>')
      .option('-c, --comments', 'show the comments too')
      .option('--json', 'print the GitHub-shaped JSON'),
  ).action(
    async (n: string, opts: { repo?: string; comments?: boolean; json?: boolean }) => {
      const forge = await forgeFor(deps, opts);
      const raw = await forge.gh('GET', `/issues/${number(n)}`);
      if (opts.json) return deps.out(JSON.stringify(raw, null, 2));
      const i = issueSchema.parse(raw);
      deps.out(`${i.title} #${i.number}`);
      deps.out(
        `${i.state.toUpperCase()}${i.state_reason ? ` (${i.state_reason})` : ''} • ${i.user?.login ?? 'unknown'} • ${i.comments ?? 0} comments`,
      );
      if (i.labels.length) deps.out(`Labels: ${i.labels.map((l) => l.name).join(', ')}`);
      if (i.assignees.length)
        deps.out(`Assignees: ${i.assignees.map((a) => a.login).join(', ')}`);
      if (i.body) deps.out(`\n${i.body}`);
      if (opts.comments) {
        const comments = z
          .array(commentSchema)
          .parse(await forge.gh('GET', `/issues/${i.number}/comments`));
        for (const c of comments) deps.out(`\n${c.user?.login ?? 'unknown'}:\n${c.body}`);
      }
      deps.out(`\n${i.html_url}`);
    },
  );

  const setState = async (
    n: string,
    opts: { repo?: string; reason?: string; comment?: string },
    state: 'open' | 'closed',
  ) => {
    const forge = await forgeFor(deps, opts);
    if (opts.comment) {
      const comment: RequestBody<'ghCreateIssueComment'> = { body: opts.comment };
      await forge.gh('POST', `/issues/${number(n)}/comments`, comment);
    }
    const body: RequestBody<'ghUpdateIssue'> = { state };
    if (state === 'closed' && opts.reason)
      body.state_reason = opts.reason === 'not planned' ? 'not_planned' : 'completed';
    const updated = issueSchema.parse(
      await forge.gh('PATCH', `/issues/${number(n)}`, body),
    );
    deps.out(`${state === 'closed' ? 'Closed' : 'Reopened'} issue #${updated.number}`);
  };

  repoOption(
    issue
      .command('close')
      .argument('<number>')
      .option('-r, --reason <reason>', '"completed" or "not planned"')
      .option('-c, --comment <text>', 'leave a closing comment'),
  ).action((n: string, opts: { repo?: string; reason?: string; comment?: string }) =>
    setState(n, opts, 'closed'),
  );

  repoOption(
    issue
      .command('reopen')
      .argument('<number>')
      .option('-c, --comment <text>', 'leave a comment'),
  ).action((n: string, opts: { repo?: string; comment?: string }) =>
    setState(n, opts, 'open'),
  );

  repoOption(
    issue.command('comment').argument('<number>').requiredOption('-b, --body <text>'),
  ).action(async (n: string, opts: { repo?: string; body: string }) => {
    const forge = await forgeFor(deps, opts);
    const body: RequestBody<'ghCreateIssueComment'> = { body: opts.body };
    const comment = z
      .object({ html_url: z.string() })
      .parse(await forge.gh('POST', `/issues/${number(n)}/comments`, body));
    deps.out(comment.html_url);
  });
}
