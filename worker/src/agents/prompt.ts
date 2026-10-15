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
- Land with the land tool. If it reports stale, merge the landed head back in (commit with parents [main_head]) and retry — never force. Any other land refusal (marked final, e.g. protected_branch) is final: call finish or report_failure.
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
export function postMergePrompt(changedFiles: string[], landedCs?: string): string {
  return `Verify these changes after merge (post-merge, pre-deploy checks)${landedCs ? ` — landed changeset ${landedCs}` : ''}:

${changedFiles.map((f) => `- ${f}`).join('\n') || '(no changed files listed — use diff)'}

Use diff (it defaults to the pre-land head → the landed changeset) and read_file to confirm the change is correct and complete. If you find problems, report_failure with specific findings; otherwise finish with a short verification summary.`;
}

/**
 * Lineage marker on fix tasks spawned by a failed post-merge check. A check
 * whose landing task carried it never spawns another fix (cap: one level).
 */
export const POST_MERGE_FIX_MARKER = '[post-merge-fix]';
const FIX_DEPTH_LINE = 'fix_depth: 1';
const MAX_LISTED_FILES = 200;

/** Stored `agent_tasks.prompt` of a post_merge_check row (written by `land`). */
export function formatPostMergeTask(
  landedCs: string,
  changedFiles: string[],
  fromFix: boolean,
): string {
  const listed = changedFiles.slice(0, MAX_LISTED_FILES).map((f) => `- ${f}`);
  if (changedFiles.length > MAX_LISTED_FILES) {
    listed.push(`- … (${changedFiles.length - MAX_LISTED_FILES} more)`);
  }
  return [
    `verify these changes: ${landedCs}`,
    ...(fromFix ? [FIX_DEPTH_LINE] : []),
    ...listed,
  ].join('\n');
}

/** Inverse of `formatPostMergeTask` (also accepts the legacy one-line form). */
export function parsePostMergeTask(prompt: string): {
  landed_cs: string | null;
  files: string[];
  fromFix: boolean;
} {
  const lines = prompt.split('\n');
  const head = /^verify these changes:?\s*(\S+)?/i.exec(lines[0] ?? '');
  return {
    landed_cs: head?.[1] ?? null,
    files: lines.filter((l) => l.startsWith('- ')).map((l) => l.slice(2)),
    fromFix: lines.includes(FIX_DEPTH_LINE),
  };
}

/** Prompt for the freeform fix task a failed post-merge check opens. */
export function postMergeFixPrompt(check: {
  id: string;
  landed_cs: string | null;
  files: string[];
  findings: string;
}): string {
  return `${POST_MERGE_FIX_MARKER} Post-merge check ${check.id} failed${check.landed_cs ? ` on landed changeset ${check.landed_cs}` : ''}.

Findings:
${check.findings}

Changed files:
${check.files.map((f) => `- ${f}`).join('\n') || '(none listed)'}

Fix the problems the check found, commit, land, and finish with a summary.`;
}
