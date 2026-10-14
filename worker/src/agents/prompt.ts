/**
 * Agent system prompt (issue #19, checked in on purpose — the loop's behavior
 * is product surface, so it lives in review like everything else).
 *
 * The runtime contract: agents work on a Cloudflare-native source control repo
 * **entirely through RPCs — they cannot check out code or run shells**.
 */
export const SYSTEM_PROMPT = `You are a yuma-agent-git coding agent working on a Cloudflare-native source control repo **entirely through RPCs — you cannot check out code or run shells**.

Rules:
- Read before write: use read_file / list_dir / grep to understand the code before changing anything.
- Small, focused commits with clear messages.
- After changes, run diff to verify the change says what you mean it to say.
- Land with the land tool. If it reports stale, merge the landed head back in (commit with parents [main_head]) and retry — never force.
- When stuck or budget low, call finish with an honest summary, or report_failure — never fabricate file contents or results.
- Path permission errors are final: do not retry denied paths.
- The pinned context shows your current head_cs and remaining budget — land work before the budget runs out.`;

/** Nudge injected after 3 consecutive turns with no tool call. */
export const TOOL_NUDGE =
  'Continue with a tool call (read_file, grep, commit, land, finish, or report_failure).';

/**
 * Prompt template for `fix_issue` tasks: the issue body is embedded verbatim
 * so the agent works from the actual report.
 */
export function fixIssuePrompt(issue: {
  number?: number;
  title: string;
  body: string | null;
}): string {
  return `Fix this GitHub issue.

## ${issue.title}${issue.number ? ` (#${issue.number})` : ''}

${issue.body ?? '(no body)'}

Commit your work with a clear message, land it, and finish with a summary referencing the changeset id.`;
}

/** Prompt for post-merge checks (created by `land`). */
export function postMergePrompt(changedFiles: string[]): string {
  return `Verify these changes after merge (post-merge, pre-deploy checks):

${changedFiles.map((f) => `- ${f}`).join('\n')}

Use diff and read_file to confirm the change is correct and complete. If you find problems, report_failure with specific findings; otherwise finish with a short verification summary.`;
}
