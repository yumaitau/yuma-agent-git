import type { Context } from 'hono';
import { z } from 'zod';
import type { Env } from '../env';
import type { Principal } from '../auth/principal';
import { can, pathDecider, restrictingDecision } from '../auth/rbac';
import type { RepoRecord } from '../db/client';
import { getRepoBySlug } from '../db/repos';
import { firstParentHistory, getChangeset } from '../core/changesets';
import { dagMergeBases } from '../core/ancestry';
import { actorOf, recordAudit } from '../audit/record';
import { emitEvent } from '../webhooks/events';
import { parseReferences } from '../../shared/markdown';
import { actorKey, eventStatement, getIssueRow, hydrateIssues } from './issues';

/**
 * Cross-references (issue #38): `#N`, `owner/name#N` and closing keywords in
 * issue bodies, comments, pull request bodies and changeset messages. A
 * reference adds one `referenced` event to the target issue's timeline; a
 * closing keyword closes the issue, but only when the caller says the source
 * landed on the default branch (a merged pull request or a direct push).
 */

export const referenceSourceSchema = z.object({
  kind: z.enum(['issue', 'pull', 'changeset']),
  /** Slug of the repo the source lives in. */
  repo: z.string(),
  /** Issue or pull request number; changeset id for `changeset`. */
  ref: z.union([z.number(), z.string()]),
});
export type ReferenceSource = z.infer<typeof referenceSourceSchema>;

const MAX_REFERENCES = 50;
const MAX_LANDED = 100;

/**
 * Link the issues `text` references to `source`. Cross-repo targets need
 * `read` on the target repo, and closing needs `triage` there, so a reference
 * never touches or reveals a repo the actor cannot see.
 */
export async function linkReferences(
  c: Context,
  repo: RepoRecord,
  source: ReferenceSource,
  text: string,
  close = false,
): Promise<void> {
  const principal = (c.get('principal') as Principal | null | undefined) ?? null;
  if (!principal) return;
  const env = c.env as Env;
  for (const ref of parseReferences(text).slice(0, MAX_REFERENCES)) {
    const local = ref.repo === null || ref.repo.toLowerCase() === repo.slug.toLowerCase();
    const target = local ? repo : await getRepoBySlug(env, ref.repo as string);
    if (!target || (!local && !(await can(env, target, principal, 'read')))) continue;
    const issue = await getIssueRow(env, target.id, ref.number);
    if (!issue) continue; // pull requests and missing numbers have no timeline
    if (local && source.kind === 'issue' && source.ref === issue.number) continue;
    if (
      close &&
      ref.closes &&
      issue.state === 'open' &&
      (await can(env, target, principal, 'triage'))
    ) {
      const now = Date.now();
      await recordAudit(
        c,
        {
          action: 'issue.update',
          repo: target,
          target: { number: issue.number, change: 'state', state: 'closed', source },
        },
        [
          env.DB.prepare(
            `UPDATE issues SET state = 'closed', state_reason = 'completed', closed_at = ?,
             updated_at = ? WHERE id = ? AND state = 'open'`,
          ).bind(now, now, issue.id),
          eventStatement(env, issue.id, actorKey(principal), 'closed', {
            state_reason: 'completed',
            source,
          }),
        ],
      );
      // the `issues` `closed` webhook (#75), unless someone else closed it first
      const closed = await getIssueRow(env, target.id, issue.number);
      if (closed?.closed_at === now) {
        const [hydrated] = await hydrateIssues(env, [closed]);
        await emitEvent(env, target, {
          event: 'issues',
          action: 'closed',
          actor: actorOf(principal),
          // the merge queue links with a request-less context
          origin: c.req.url ? new URL(c.req.url).origin : null,
          data: { issue: hydrated, source },
        });
      }
      continue;
    }
    const payload = JSON.stringify({ source });
    await env.DB.prepare(
      `INSERT INTO issue_events (issue_id, actor, kind, payload, created_at)
       SELECT ?, ?, 'referenced', ?, ? WHERE NOT EXISTS (
         SELECT 1 FROM issue_events WHERE issue_id = ? AND kind = 'referenced' AND payload = ?)`,
    )
      .bind(issue.id, actorKey(principal), payload, Date.now(), issue.id, payload)
      .run();
  }
}

/**
 * Changesets that just landed on the default branch (first-parent walk from
 * `to` back to `from`, at most 100) link and close the issues their messages
 * name, as does the body of the pull request that landed them, if any.
 */
export async function linkLanded(
  c: Context,
  repo: RepoRecord,
  from: string | null,
  to: string,
  pull?: { source: ReferenceSource; body: string },
): Promise<void> {
  // The ref already moved, so a failure here must not report the land as failed.
  try {
    if (pull) await linkReferences(c, repo, pull.source, pull.body, true);
    // everything `to` adds over `from`, merged-in commits too (#42)
    const landed =
      from === null
        ? await firstParentHistory(c.env as Env, repo.id, to, MAX_LANDED)
        : (await dagMergeBases(c.env as Env, repo.id, from, to)).onlyB;
    for (const cs of landed.slice(0, MAX_LANDED)) {
      await linkReferences(
        c,
        repo,
        { kind: 'changeset', repo: repo.slug, ref: cs.id },
        cs.message,
        true,
      );
    }
  } catch (err) {
    console.error('linking landed references failed', err);
  }
}

/**
 * Changesets a push made reachable from a branch other than the default link
 * the issues their messages name; they close nothing until they land.
 */
export async function linkPushed(
  c: Context,
  repo: RepoRecord,
  changesetIds: string[],
): Promise<void> {
  try {
    for (const id of changesetIds.slice(0, MAX_LANDED)) {
      const cs = await getChangeset(c.env as Env, repo.id, id);
      if (!cs) continue;
      await linkReferences(
        c,
        repo,
        { kind: 'changeset', repo: repo.slug, ref: cs.id },
        cs.message,
      );
    }
  } catch (err) {
    console.error('linking pushed references failed', err);
  }
}

/**
 * Whether `principal` may see a timeline event's source: the source repo must
 * be readable, and pull requests and changesets are whole-repository surfaces
 * (a caller restricted by path rules sees issue sources only).
 */
export function sourceVisibility(
  env: Env,
  principal: Principal | null,
): (source: ReferenceSource) => Promise<boolean> {
  const access = new Map<string, Promise<{ read: boolean; whole: boolean }>>();
  return async (source) => {
    let entry = access.get(source.repo);
    if (!entry) {
      entry = (async () => {
        const repo = await getRepoBySlug(env, source.repo);
        if (!repo) return { read: false, whole: false };
        const decider = await pathDecider(env, repo, principal);
        const read = decider.decide('read').allowed;
        return { read, whole: read && restrictingDecision(decider, ['read']) === null };
      })();
      access.set(source.repo, entry);
    }
    const { read, whole } = await entry;
    return source.kind === 'issue' ? read : whole;
  };
}
