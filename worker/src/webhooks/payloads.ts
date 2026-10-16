import { z } from 'zod';
import type { Env } from '../env';
import type { RepoRecord } from '../db/client';
import { q1 } from '../db/client';
import { getRepo } from '../db/repos';
import { getChangeset, type Changeset } from '../core/changesets';
import { sha256Hex } from '../core/hashing';
import { commitShas } from '../git/upload-pack';
import type { ForgeEvent } from './events';

/**
 * Webhook bodies (issue #75). The `yag` format is the forge's own shape:
 * changeset ids next to Git SHAs. The `github` format follows GitHub's
 * documented payloads for push, pull_request, pull_request_review, issues and
 * create/delete, so existing GitHub webhook consumers can read it. GitHub's
 * numeric ids are derived from our ids (`numericId`), stable per object.
 * CI runs have no GitHub equivalent here and are refused for that format.
 */

const ZERO_SHA = '0'.repeat(40);
/** Commits listed in a push payload, like GitHub's 20 commit cap. */
const MAX_PUSH_COMMITS = 20;

export const GITHUB_EVENTS = new Set([
  'push',
  'ref',
  'pull_request',
  'pull_request_review',
  'issues',
]);

/** A stable positive integer for an id (52 bits, safe in JSON numbers). */
export async function numericId(id: string): Promise<number> {
  return parseInt((await sha256Hex(new TextEncoder().encode(id))).slice(0, 13), 16);
}

const iso = (ms: number | null | undefined): string | null =>
  ms == null ? null : new Date(ms).toISOString();

function gitRef(name: string): string {
  return name.startsWith('refs/') ? name : `refs/heads/${name}`;
}

async function login(env: Env, userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const row = await q1<{ login: string }>(env, 'SELECT login FROM users WHERE id = ?', [
    userId,
  ]);
  return row?.login ?? null;
}

function commitOf(cs: Changeset, sha: string | undefined, origin: string, slug: string) {
  const author = 'agent' in cs.author ? { name: cs.author.agent, email: '' } : cs.author;
  const files = (op: string): string[] =>
    cs.changed_files.filter((f) => f.op === op).map((f) => f.path);
  return {
    id: sha ?? null,
    changeset: cs.id,
    message: cs.message,
    timestamp: iso(cs.created_at),
    url: `${origin}/r/${slug}/cs/${cs.id}`,
    author,
    committer: cs.committer
      ? { name: cs.committer.name, email: cs.committer.email }
      : author,
    added: files('add'),
    removed: files('del'),
    modified: files('mod'),
  };
}

const pushData = z.object({
  ref: z.string(),
  before: z.string().nullable(),
  after: z.string().nullable(),
  commits: z.array(z.string()),
  forced: z.boolean(),
});

async function pushPayload(
  env: Env,
  repo: RepoRecord,
  event: ForgeEvent,
  origin: string,
) {
  const d = pushData.parse(event.data);
  const listed = d.commits.slice(-MAX_PUSH_COMMITS);
  const ids = [...new Set([d.before, d.after, ...listed].filter((x) => x !== null))];
  const shas = await commitShas(env, repo.id, ids);
  const commits = [];
  for (const id of listed) {
    const cs = await getChangeset(env, repo.id, id);
    if (cs) commits.push(commitOf(cs, shas.get(id), origin, repo.slug));
  }
  const head = d.after === null ? null : await getChangeset(env, repo.id, d.after);
  return {
    ref: gitRef(d.ref),
    before: d.before === null ? ZERO_SHA : (shas.get(d.before) ?? ZERO_SHA),
    after: d.after === null ? ZERO_SHA : (shas.get(d.after) ?? ZERO_SHA),
    before_changeset: d.before,
    after_changeset: d.after,
    created: d.before === null,
    deleted: d.after === null,
    forced: d.forced,
    size: d.commits.length,
    commits,
    head_commit: head ? commitOf(head, shas.get(head.id), origin, repo.slug) : null,
  };
}

const pullSchema = z.looseObject({
  id: z.number(),
  number: z.number(),
  title: z.string(),
  body: z.string(),
  author_id: z.string(),
  base_ref: z.string(),
  base_cs: z.string(),
  head_cs: z.string(),
  state: z.string(),
  created_at: z.number(),
  updated_at: z.number(),
  merged_at: z.number().nullable(),
});

export async function githubPull(
  env: Env,
  repo: RepoRecord,
  raw: unknown,
  origin: string,
): Promise<Record<string, unknown>> {
  const pull = pullSchema.parse(raw);
  const shas = await commitShas(env, repo.id, [pull.base_cs, pull.head_cs]);
  return {
    id: pull.id,
    node_id: `${repo.id}:pull:${pull.id}`,
    number: pull.number,
    state: pull.state === 'merged' || pull.state === 'closed' ? 'closed' : 'open',
    draft: pull.state === 'draft',
    merged: pull.state === 'merged',
    title: pull.title,
    body: pull.body,
    html_url: `${origin}/r/${repo.slug}/pulls/${pull.id}`,
    user: await githubUser(env, pull.author_id),
    head: { ref: `pull/${pull.number}/head`, sha: shas.get(pull.head_cs) },
    base: { ref: pull.base_ref, sha: shas.get(pull.base_cs) },
    created_at: iso(pull.created_at),
    updated_at: iso(pull.updated_at),
    merged_at: iso(pull.merged_at),
    closed_at: pull.state === 'merged' ? iso(pull.merged_at) : null,
  };
}

export async function githubUser(env: Env, userId: string | null) {
  return userId === null
    ? null
    : { login: await login(env, userId), id: await numericId(userId), type: 'User' };
}

/** GitHub's `repository` object; the REST compatibility layer (#74) extends it. */
export async function githubRepository(repo: RepoRecord, origin: string) {
  const [owner, short] = repo.slug.split('/') as [string, string];
  return {
    id: await numericId(repo.id),
    node_id: repo.id,
    name: short,
    full_name: repo.slug,
    private: repo.visibility !== 'public',
    owner: {
      login: owner,
      id: await numericId(repo.owner_id ?? owner),
      type: repo.owner_kind === 'org' ? 'Organization' : 'User',
    },
    html_url: `${origin}/r/${repo.slug}`,
    clone_url: `${origin}/${repo.slug}.git`,
    default_branch: repo.default_branch,
  };
}

/** GitHub event name for a forge event, or null when the format has none. */
function githubName(event: ForgeEvent): string | null {
  if (event.event === 'ref') return event.action === 'deleted' ? 'delete' : 'create';
  return GITHUB_EVENTS.has(event.event) ? event.event : null;
}

/**
 * The body and event header for one delivery, or null when the hook's
 * format has no shape for this event.
 */
export async function buildPayload(
  env: Env,
  event: ForgeEvent,
  format: 'yag' | 'github',
): Promise<{ name: string; body: string } | null> {
  const repo = await getRepo(env, event.repo_id);
  if (!repo) return null;
  const origin = event.origin ?? '';
  const senderLogin = await login(env, event.sender.user_id);

  if (format === 'yag') {
    const data =
      event.event === 'push' ? await pushPayload(env, repo, event, origin) : event.data;
    return {
      name: event.event,
      body: JSON.stringify({
        event: event.event,
        action: event.action,
        repository: {
          id: repo.id,
          full_name: repo.slug,
          private: repo.visibility !== 'public',
          default_branch: repo.default_branch,
          html_url: `${origin}/r/${repo.slug}`,
          clone_url: `${origin}/${repo.slug}.git`,
        },
        sender: { kind: event.sender.kind, id: event.sender.id, login: senderLogin },
        ...data,
      }),
    };
  }

  const name = githubName(event);
  if (name === null) return null;
  const repository = await githubRepository(repo, origin);
  const sender = {
    login: senderLogin ?? event.sender.id,
    id: await numericId(event.sender.user_id ?? event.sender.id),
    type: event.sender.kind === 'user' ? 'User' : 'Bot',
  };
  let body: Record<string, unknown>;
  switch (event.event) {
    case 'push': {
      const push = await pushPayload(env, repo, event, origin);
      const github = (c: ReturnType<typeof commitOf>) => ({
        id: c.id,
        distinct: true,
        message: c.message,
        timestamp: c.timestamp,
        url: c.url,
        author: c.author,
        committer: c.committer,
        added: c.added,
        removed: c.removed,
        modified: c.modified,
      });
      body = {
        ref: push.ref,
        before: push.before,
        after: push.after,
        created: push.created,
        deleted: push.deleted,
        forced: push.forced,
        base_ref: null,
        compare: `${origin}/r/${repo.slug}/history`,
        commits: push.commits.map(github),
        head_commit: push.head_commit && github(push.head_commit),
        pusher: { name: sender.login, email: null },
      };
      break;
    }
    case 'ref': {
      const d = z.object({ ref: z.string(), ref_type: z.string() }).parse(event.data);
      body = {
        ref: d.ref.replace(/^refs\/(heads|tags)\//, ''),
        ref_type: d.ref_type,
        master_branch: repo.default_branch,
        description: null,
        pusher_type: 'user',
      };
      break;
    }
    case 'pull_request': {
      const pull = await githubPull(env, repo, event.data['pull_request'], origin);
      body = { action: event.action, number: pull['number'], pull_request: pull };
      break;
    }
    case 'pull_request_review': {
      const review = z
        .looseObject({
          id: z.number(),
          author_id: z.string(),
          decision: z.string(),
          body: z.string(),
          head_cs: z.string(),
          created_at: z.number(),
        })
        .parse(event.data['review']);
      const pull = await githubPull(env, repo, event.data['pull_request'], origin);
      const shas = await commitShas(env, repo.id, [review.head_cs]);
      body = {
        action: event.action,
        review: {
          id: review.id,
          user: await githubUser(env, review.author_id),
          body: review.body,
          state:
            review.decision === 'approve'
              ? 'approved'
              : review.decision === 'request_changes'
                ? 'changes_requested'
                : 'commented',
          commit_id: shas.get(review.head_cs),
          submitted_at: iso(review.created_at),
          html_url: pull['html_url'],
        },
        pull_request: pull,
      };
      break;
    }
    default: {
      const issue = z
        .looseObject({
          id: z.number(),
          number: z.number(),
          title: z.string(),
          body: z.string(),
          state: z.string(),
          state_reason: z.string().nullable(),
          author_id: z.string(),
          labels: z.array(z.object({ name: z.string(), color: z.string() })),
          created_at: z.number(),
          updated_at: z.number(),
          closed_at: z.number().nullable(),
        })
        .parse(event.data['issue']);
      body = {
        action: event.action,
        issue: {
          id: issue.id,
          node_id: `${repo.id}:issue:${issue.id}`,
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
          state_reason: issue.state_reason,
          user: await githubUser(env, issue.author_id),
          labels: issue.labels,
          html_url: `${origin}/r/${repo.slug}/issues/${issue.number}`,
          created_at: iso(issue.created_at),
          updated_at: iso(issue.updated_at),
          closed_at: iso(issue.closed_at),
        },
      };
    }
  }
  return { name, body: JSON.stringify({ ...body, repository, sender }) };
}
