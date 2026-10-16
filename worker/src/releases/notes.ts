import type { Env } from '../env';
import type { RepoRecord } from '../db/client';
import { q } from '../db/client';
import { ancestorsParentsFirst, type Changeset } from '../core/changesets';
import { dagMergeBases } from '../core/ancestry';
import type { GeneratedNotes } from '../../shared/releases';

/**
 * Release notes from history (issue #54): the changesets in `previous..target`
 * (git's two-dot range over every parent), the pull requests that landed one
 * of them, then the remaining non-merge commits. Plain Markdown a person or
 * an agent edits before publishing.
 */
const MAX_WALK = 5_000;
const MAX_COMMITS = 100;

interface PullRow {
  number: number | null;
  id: number;
  title: string;
  login: string | null;
  merged_cs: string | null;
  head_cs: string;
}

function firstLine(message: string): string {
  return message.split('\n', 1)[0]!.trim();
}

export async function generateNotes(
  env: Env,
  repo: RepoRecord,
  input: { tag: string; target: string; previous: { tag: string; cs: string } | null },
): Promise<GeneratedNotes> {
  const range: Changeset[] = input.previous
    ? (await dagMergeBases(env, repo.id, input.previous.cs, input.target, MAX_WALK)).onlyB
    : (await ancestorsParentsFirst(env, repo.id, input.target, MAX_WALK)).reverse();
  const ids = new Set(range.map((cs) => cs.id));

  // merged pull requests are few next to changesets: read them and match here
  const pulls = (
    await q<PullRow>(
      env,
      `SELECT p.number, p.id, p.title, u.login, p.merged_cs, p.head_cs
         FROM pull_requests p LEFT JOIN users u ON u.id = p.author_id
        WHERE p.repo_id = ? AND p.state = 'merged'
        ORDER BY p.merged_at`,
      [repo.id],
    )
  ).filter((p) => (p.merged_cs !== null && ids.has(p.merged_cs)) || ids.has(p.head_cs));
  const landed = new Set(pulls.flatMap((p) => [p.merged_cs, p.head_cs]));
  const commits = range.filter((cs) => cs.parents.length < 2 && !landed.has(cs.id));

  const lines: string[] = [];
  if (pulls.length > 0) {
    lines.push("## What's changed", '');
    for (const p of pulls)
      lines.push(
        `- ${p.title} (#${p.number ?? p.id})${p.login ? ` by @${p.login}` : ''}`,
      );
    lines.push('');
  }
  if (commits.length > 0) {
    lines.push(pulls.length > 0 ? '## Other commits' : '## Commits', '');
    for (const cs of commits.slice(0, MAX_COMMITS))
      lines.push(`- ${cs.id.slice(0, 12)} ${firstLine(cs.message)}`);
    if (commits.length > MAX_COMMITS)
      lines.push(`- and ${commits.length - MAX_COMMITS} more`);
    lines.push('');
  }
  if (range.length === 0) lines.push('No changes.', '');
  lines.push(
    input.previous
      ? `**Full changelog**: ${input.previous.tag}...${input.tag}`
      : `**Full changelog**: ${input.tag}`,
  );
  return {
    name: input.tag,
    body: lines.join('\n'),
    previous_tag: input.previous?.tag ?? null,
    changesets: range.length,
    pulls: pulls.map((p) => p.number ?? p.id),
  };
}
