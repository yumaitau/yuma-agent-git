import type { Env } from '../env';
import { q } from '../db/client';
import { can, USER_TEAMS_CTE, type RepoWithCreator } from '../auth/rbac';
import { diffRevisions } from '../core/diff';
import { globMatch, type Ruleset } from '../policy/rulesets';
import { parseReferences } from '../../shared/markdown';
import { RISKS, type Risk } from '../../shared/work';
import type { Pull, PullCodeowners } from '../../shared/collaboration';

/**
 * Pull request risk (issue #60), for the `human_approvals_by_risk` rule. The
 * level is the higher of the work items the pull request closes (#59) and a
 * classifier over the change: sensitive paths make it high, size makes it
 * medium or high, and files with code owners make it at least medium.
 */

/** Paths that make a change high risk unless a rule names its own list. */
export const DEFAULT_SENSITIVE_PATHS = [
  '.github/**',
  '**/migrations/**',
  '**/auth/**',
  '**/security/**',
  '**/secrets/**',
  '**/CODEOWNERS',
  '**/wrangler.json*',
  '**/wrangler.toml',
  '**/*.tf',
  '**/Dockerfile',
] as const;

/** Sensitive paths the `human_approvals_by_risk` rules name, else the default list. */
export function sensitivePaths(rulesets: readonly Ruleset[]): string[] {
  const rules = rulesets.flatMap((r) =>
    r.rules.flatMap((rule) => (rule.type === 'human_approvals_by_risk' ? [rule] : [])),
  );
  if (rules.length === 0) return [...DEFAULT_SENSITIVE_PATHS];
  return [
    ...new Set(rules.flatMap((rule) => rule.sensitive_paths ?? DEFAULT_SENSITIVE_PATHS)),
  ];
}

/** Changed lines or files at which a change becomes medium, then high, risk. */
export const RISK_SIZE = {
  medium: { lines: 200, files: 10 },
  high: { lines: 1000, files: 50 },
} as const;

export interface RiskInput {
  paths: readonly string[];
  lines: number;
  /** Changed files that have a code owner. */
  ownedFiles: number;
  /** The diff was too large to list. */
  truncated: boolean;
  sensitive: readonly string[];
}

const rank = (r: Risk): number => RISKS.indexOf(r);
export const maxRisk = (a: Risk, b: Risk): Risk => (rank(a) >= rank(b) ? a : b);

/** Pure: the level and why, from what changed. */
export function classifyRisk(input: RiskInput): { level: Risk; reasons: string[] } {
  const reasons: string[] = [];
  let level: Risk = 'low';
  const raise = (to: Risk, why: string): void => {
    level = maxRisk(level, to);
    reasons.push(why);
  };
  // `**/x` also matches `x` at the root
  const matches = (pattern: string, path: string): boolean =>
    globMatch(pattern, path) ||
    (pattern.startsWith('**/') && globMatch(pattern.slice(3), path));
  const touched = input.paths.filter((p) =>
    input.sensitive.some((pattern) => matches(pattern, p)),
  );
  if (touched.length > 0)
    raise('high', `changes sensitive paths: ${touched.slice(0, 3).join(', ')}`);
  if (input.truncated) raise('high', 'too large to list every changed file');
  const files = input.paths.length;
  if (input.lines >= RISK_SIZE.high.lines || files >= RISK_SIZE.high.files)
    raise('high', `${input.lines} changed lines in ${files} files`);
  else if (input.lines >= RISK_SIZE.medium.lines || files >= RISK_SIZE.medium.files)
    raise('medium', `${input.lines} changed lines in ${files} files`);
  if (input.ownedFiles > 0)
    raise('medium', `${input.ownedFiles} changed file(s) have code owners`);
  return { level, reasons };
}

export interface PullRisk {
  level: Risk;
  reasons: string[];
  lines: number;
  files: number;
  /** Highest risk of the work items the pull request closes, if any. */
  work_item: Risk | null;
}

/** Added and removed lines in a unified diff (file headers excluded). */
function changedLines(unified: string): number {
  let n = 0;
  for (const line of unified.split('\n'))
    if (
      (line.startsWith('+') && !line.startsWith('+++ ')) ||
      (line.startsWith('-') && !line.startsWith('--- '))
    )
      n++;
  return n;
}

export async function pullRisk(
  env: Env,
  repo: RepoWithCreator,
  pull: Pull,
  owned: PullCodeowners | null,
  sensitive: readonly string[],
): Promise<PullRisk> {
  const diff = await diffRevisions(env, repo.id, pull.base_cs, pull.head_cs, {
    includeText: true,
    maxFiles: 500,
  });
  const paths = [
    ...new Set(diff.files.filter((f) => f.side === 'to').map((f) => f.path)),
  ];
  const lines = (diff.texts ?? [])
    .filter((t) => t.side === 'to')
    .reduce((sum, t) => sum + changedLines(t.unified), 0);
  const classified = classifyRisk({
    paths,
    lines,
    ownedFiles: owned?.files.filter((f) => f.owners.length > 0).length ?? 0,
    truncated: diff.truncated,
    sensitive,
  });
  const closes = parseReferences(pull.body)
    .filter(
      (r) =>
        r.closes && (r.repo === null || r.repo.toLowerCase() === repo.slug.toLowerCase()),
    )
    .map((r) => r.number)
    .slice(0, 50);
  const items =
    closes.length === 0
      ? []
      : await q<{ risk: Risk }>(
          env,
          `SELECT w.risk FROM work_items w JOIN issues i ON i.id = w.issue_id
            WHERE i.repo_id = ? AND i.number IN (${closes.map(() => '?').join(',')})`,
          [repo.id, ...closes],
        );
  const workItem = items.reduce<Risk | null>(
    (top, i) => (top === null ? i.risk : maxRisk(top, i.risk)),
    null,
  );
  const reasons = [...classified.reasons];
  let level = classified.level;
  if (workItem !== null && rank(workItem) > rank(level)) {
    level = workItem;
    reasons.unshift(`closes ${workItem} risk work`);
  }
  return { level, reasons, lines, files: paths.length, work_item: workItem };
}

/**
 * People who approved this revision, and whether one of them owns a changed
 * file. Only a person's own review counts: never an agent acting for them
 * (#60), never the author, and only with write access.
 */
export async function humanApprovals(
  env: Env,
  repo: RepoWithCreator,
  pull: Pull,
  owned: PullCodeowners | null,
): Promise<{ count: number; codeOwner: boolean }> {
  const reviews = await q<{ author_id: string; decision: string }>(
    env,
    `SELECT author_id, decision FROM pull_reviews
      WHERE pull_id = ? AND head_cs = ? AND revision = ? AND decision != 'comment'
        AND agent_id IS NULL ORDER BY id DESC`,
    [pull.id, pull.head_cs, pull.revision],
  );
  const owners = new Set(owned?.files.flatMap((f) => f.owners) ?? []);
  const seen = new Set<string>();
  let count = 0;
  let codeOwner = false;
  for (const review of reviews) {
    if (seen.has(review.author_id) || review.author_id === pull.author_id) continue;
    seen.add(review.author_id);
    if (review.decision !== 'approve') continue;
    if (!(await can(env, repo, { kind: 'user', userId: review.author_id }, 'write')))
      continue;
    count++;
    if (codeOwner || owners.size === 0) continue;
    if (owners.has(`user:${review.author_id}`)) codeOwner = true;
    else
      for (const team of await q<{ team_id: string }>(
        env,
        `WITH RECURSIVE ${USER_TEAMS_CTE} SELECT team_id FROM user_teams`,
        [review.author_id],
      ))
        if (owners.has(`team:${team.team_id}`)) codeOwner = true;
  }
  return { count, codeOwner };
}
