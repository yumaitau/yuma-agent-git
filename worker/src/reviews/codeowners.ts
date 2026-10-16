import type { Context } from 'hono';
import type { Env } from '../env';
import type { AppEnv } from '../auth/principal';
import { actorOf, recordAudit } from '../audit/record';
import { emitEvent } from '../webhooks/events';
import { q, q1 } from '../db/client';
import { getRef } from '../db/repos';
import { can, USER_TEAMS_CTE, type RepoWithCreator } from '../auth/rbac';
import { getChangeset } from '../core/changesets';
import { getBlob } from '../core/blobs';
import { resolvePath } from '../core/trees';
import { diffRevisions } from '../core/diff';
import { globMatch } from '../policy/rulesets';
import type {
  Codeowners,
  CodeownersError,
  CodeownersRule,
  Pull,
  PullCodeowners,
} from '../../shared/collaboration';

/**
 * CODEOWNERS (issue #40), with GitHub's syntax and semantics: one pattern and
 * its owners per line, the last matching line wins, and a line with no owners
 * leaves its paths unowned. Owners are `@login`, `@org/team`, an email
 * address, or `@agent:<agent id or name>` for an agent reviewer. Invalid lines
 * are skipped and owners that do not resolve are ignored; both are reported
 * as errors. Path rules (rbac.ts) decide who may touch a path; this file only
 * decides who reviews it.
 */

/** Where the file is looked for, first found wins. */
export const CODEOWNERS_PATHS = [
  '.yuma/CODEOWNERS',
  '.github/CODEOWNERS',
  'CODEOWNERS',
  'docs/CODEOWNERS',
] as const;

/** GitHub ignores CODEOWNERS files over 3 MB. */
export const MAX_CODEOWNERS_BYTES = 3 * 1024 * 1024;
const MAX_OWNERS = 200;

interface ParsedRule {
  line: number;
  pattern: string;
  /** Owner tokens as written, with their 1-based column. */
  owners: { raw: string; column: number }[];
}

const AGENT_OWNER = /^@agent:([A-Za-z0-9_.-]+)$/;
const TEAM_OWNER = /^@([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;
const USER_OWNER = /^@([A-Za-z0-9_.-]+)$/;
const EMAIL_OWNER = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Split a CODEOWNERS file into rules, reporting lines GitHub would skip. */
export function parseCodeowners(text: string): {
  rules: ParsedRule[];
  errors: CodeownersError[];
} {
  const rules: ParsedRule[] = [];
  const errors: CodeownersError[] = [];
  for (const [i, raw] of text.split('\n').entries()) {
    const source = raw.replace(/\r$/, '');
    const tokens = [...source.matchAll(/\S+/g)].map((m) => ({
      raw: m[0],
      column: (m.index ?? 0) + 1,
    }));
    const end = tokens.findIndex((t, k) => k > 0 && t.raw.startsWith('#'));
    const parts = end === -1 ? tokens : tokens.slice(0, end);
    const first = parts[0];
    if (!first || first.raw.startsWith('#')) continue;
    const line = i + 1;
    const fail = (column: number, kind: CodeownersError['kind'], message: string) =>
      errors.push({ line, column, kind, source, message });
    const pattern = first.raw.startsWith('\\#') ? first.raw.slice(1) : first.raw;
    if (pattern.startsWith('!')) {
      fail(first.column, 'invalid_pattern', 'Negated patterns are not supported.');
      continue;
    }
    if (/[[\]]/.test(pattern)) {
      fail(first.column, 'invalid_pattern', 'Character ranges are not supported.');
      continue;
    }
    const bad = parts
      .slice(1)
      .find(
        (o) =>
          !AGENT_OWNER.test(o.raw) &&
          !TEAM_OWNER.test(o.raw) &&
          !USER_OWNER.test(o.raw) &&
          !EMAIL_OWNER.test(o.raw),
      );
    if (bad) {
      fail(
        bad.column,
        'invalid_owner',
        `${bad.raw} is not an owner: use @login, @org/team, an email or @agent:<name>.`,
      );
      continue;
    }
    rules.push({ line, pattern, owners: parts.slice(1) });
  }
  return { rules, errors };
}

/**
 * Does a CODEOWNERS pattern cover `path`? gitignore rules as GitHub applies
 * them: a pattern with no `/` except a trailing one matches at any depth, a
 * leading or inner `/` anchors it to the root, a trailing `/` matches only
 * directories, and a matched directory owns everything below it, except that
 * `dir/*` covers only the files directly in `dir`. `*` and `?` stay inside a
 * segment (the shared ruleset glob); a `**` segment spans any number of them.
 */
export function patternMatches(pattern: string, path: string): boolean {
  const dirOnly = pattern.endsWith('/');
  const trimmed = pattern.replace(/\/+$/, '');
  const anchored = trimmed.includes('/');
  const body = trimmed.replace(/^\/+/, '');
  const segs = [...(anchored ? [] : ['**']), ...(body === '' ? [] : body.split('/'))];
  const parts = path.split('/');
  const n = parts.length;
  // reach[j]: the segments so far match the first j path parts
  let reach = new Uint8Array(n + 1);
  reach[0] = 1;
  for (const seg of segs) {
    const next = new Uint8Array(n + 1);
    if (seg === '**') {
      for (let j = 0; j <= n; j++) next[j] = reach[j] || (j > 0 && next[j - 1]) ? 1 : 0;
    } else {
      for (let j = 1; j <= n; j++)
        next[j] = reach[j - 1] && globMatch(seg, parts[j - 1]!) ? 1 : 0;
    }
    reach = next;
  }
  if (reach[n] && !dirOnly) return true;
  if (!dirOnly && segs[segs.length - 1] === '*') return false;
  for (let j = 1; j < n; j++) if (reach[j]) return true;
  return false;
}

/** The owners of `path`: the last rule that matches, or none. */
export function ownersOf(codeowners: Pick<Codeowners, 'rules'>, path: string): string[] {
  for (let i = codeowners.rules.length - 1; i >= 0; i--) {
    const rule = codeowners.rules[i]!;
    if (patternMatches(rule.pattern, path)) return rule.owners;
  }
  return [];
}

/**
 * May agent identity `agent` review pull requests in `repo`? An org agent
 * must belong to the repo's org; a person's agent needs its owner to read the
 * repo; either way the agent's repo allow-list must include it (#57).
 */
export async function agentCanReview(
  env: Env,
  repo: RepoWithCreator,
  agent: { owner_kind: string; owner_id: string; allowed_repos: string | null },
): Promise<boolean> {
  const repos = agent.allowed_repos
    ? (JSON.parse(agent.allowed_repos) as string[])
    : null;
  if (repos && !repos.includes(repo.id)) return false;
  return agent.owner_kind === 'org'
    ? repo.owner_kind === 'org' && repo.owner_id === agent.owner_id
    : can(env, repo, { kind: 'user', userId: agent.owner_id }, 'read');
}

/** One owner token to a principal, or why it cannot own anything here. */
async function resolveOwner(
  env: Env,
  repo: RepoWithCreator,
  raw: string,
): Promise<{ principal: string } | { error: string }> {
  const agentName = AGENT_OWNER.exec(raw)?.[1];
  if (agentName !== undefined) {
    // An id names any agent; a name only one owned by the repo's org (or, for
    // a personal repo, its creator), so nobody else can claim it by naming
    // their own agent the same.
    const owner =
      repo.owner_kind === 'org'
        ? ['org', repo.owner_id ?? '']
        : ['user', repo.created_by ?? ''];
    const agents = await q<{
      id: string;
      owner_kind: string;
      owner_id: string;
      allowed_repos: string | null;
    }>(
      env,
      `SELECT id, owner_kind, owner_id, allowed_repos FROM agents
        WHERE disabled = 0 AND (id = ? OR (name = ? AND owner_kind = ? AND owner_id = ?))
        ORDER BY id = ? DESC, id LIMIT 2`,
      [agentName, agentName, ...owner, agentName],
    );
    const [agent] = agents;
    if (agent && agent.id !== agentName && agents.length > 1)
      return { error: `${raw} names more than one agent; use its id.` };
    if (agent && (await agentCanReview(env, repo, agent)))
      return { principal: `agent:${agent.id}` };
    return {
      error: `${raw} is not an agent that can review this repository.`,
    };
  }
  const team = TEAM_OWNER.exec(raw);
  if (team) {
    const row =
      repo.owner_kind === 'org'
        ? await q1<{ id: string }>(
            env,
            `SELECT t.id FROM teams t JOIN orgs o ON o.id = t.org_id
              WHERE o.id = ? AND lower(o.slug) = lower(?) AND lower(t.slug) = lower(?)`,
            [repo.owner_id, team[1]!, team[2]!],
          )
        : null;
    return row
      ? { principal: `team:${row.id}` }
      : { error: `${raw} is not a team in this repository's organisation.` };
  }
  const login = USER_OWNER.exec(raw)?.[1];
  const users =
    login !== undefined
      ? await q<{ id: string }>(
          env,
          'SELECT id FROM users WHERE login = ? COLLATE NOCASE AND active = 1',
          [login],
        )
      : await q<{ id: string }>(
          env,
          `SELECT DISTINCT u.id FROM user_identities i JOIN users u ON u.id = i.user_id
            WHERE lower(i.email) = lower(?) AND u.active = 1 LIMIT 2`,
          [raw],
        );
  if (users.length !== 1)
    return {
      error:
        users.length > 1
          ? `${raw} matches more than one user.`
          : `${raw} is not a user of this forge.`,
    };
  // GitHub, too, ignores owners who cannot approve: they need write access
  if (!(await can(env, repo, { kind: 'user', userId: users[0]!.id }, 'write')))
    return { error: `${raw} does not have write access to this repository.` };
  return { principal: `user:${users[0]!.id}` };
}

/**
 * The CODEOWNERS file at changeset `revision` (the first of
 * `CODEOWNERS_PATHS` that exists), parsed and with owners resolved.
 */
export async function loadCodeowners(
  env: Env,
  repo: RepoWithCreator,
  revision: string,
): Promise<Codeowners> {
  const cs = await getChangeset(env, repo.id, revision);
  const none: Codeowners = { file: null, revision, rules: [], errors: [] };
  if (!cs?.root_tree) return none;
  for (const file of CODEOWNERS_PATHS) {
    const entry = await resolvePath(env, repo.id, cs.root_tree, file.split('/'));
    if (entry?.kind !== 'blob') continue;
    const tooLarge: CodeownersError = {
      line: 0,
      column: 0,
      kind: 'too_large',
      source: '',
      message: 'CODEOWNERS is larger than 3 MB and is ignored.',
    };
    if ((entry.size ?? 0) > MAX_CODEOWNERS_BYTES)
      return { ...none, file, errors: [tooLarge] };
    const blob = await getBlob(env, repo.id, entry.hash);
    if (!blob) return { ...none, file };
    if (blob.size > MAX_CODEOWNERS_BYTES) return { ...none, file, errors: [tooLarge] };
    const content = new TextDecoder().decode(blob.content);
    const lines = content.split('\n');
    const parsed = parseCodeowners(content);
    const resolved = new Map<string, { principal: string } | { error: string }>();
    const rules: CodeownersRule[] = [];
    const errors = [...parsed.errors];
    for (const rule of parsed.rules) {
      const owners: string[] = [];
      for (const owner of rule.owners) {
        let hit = resolved.get(owner.raw);
        if (!hit) {
          // each owner is a D1 lookup; keep a pathological file inside a request's budget
          hit =
            resolved.size < MAX_OWNERS
              ? await resolveOwner(env, repo, owner.raw)
              : { error: `Only the first ${MAX_OWNERS} distinct owners are checked.` };
          resolved.set(owner.raw, hit);
        }
        if ('principal' in hit) {
          if (!owners.includes(hit.principal)) owners.push(hit.principal);
        } else
          errors.push({
            line: rule.line,
            column: owner.column,
            kind: 'unknown_owner',
            source: (lines[rule.line - 1] ?? '').replace(/\r$/, ''),
            message: hit.error,
          });
      }
      rules.push({ line: rule.line, pattern: rule.pattern, owners });
    }
    errors.sort((a, b) => a.line - b.line || a.column - b.column);
    return { file, revision, rules, errors };
  }
  return none;
}

/**
 * Principals whose approval of the pull's current revision stands: each
 * reviewer's latest non-comment review is an approval, from someone other
 * than the author who still has write access. People also stand for their
 * teams (parents included); an agent identity stands only for itself.
 */
async function approvers(
  env: Env,
  repo: RepoWithCreator,
  pull: Pull,
): Promise<Set<string>> {
  const reviews = await q<{
    author_id: string;
    agent_id: string | null;
    decision: string;
  }>(
    env,
    `SELECT author_id, agent_id, decision FROM pull_reviews
      WHERE pull_id = ? AND head_cs = ? AND revision = ? AND decision != 'comment'
      ORDER BY id DESC`,
    [pull.id, pull.head_cs, pull.revision],
  );
  const seen = new Set<string>();
  const out = new Set<string>();
  for (const review of reviews) {
    const key = review.agent_id ? `agent:${review.agent_id}` : `user:${review.author_id}`;
    if (seen.has(key) || review.author_id === pull.author_id) continue;
    seen.add(key);
    if (review.decision !== 'approve') continue;
    if (!(await can(env, repo, { kind: 'user', userId: review.author_id }, 'write')))
      continue;
    out.add(key);
    if (review.agent_id) continue;
    for (const team of await q<{ team_id: string }>(
      env,
      `WITH RECURSIVE ${USER_TEAMS_CTE} SELECT team_id FROM user_teams`,
      [review.author_id],
    ))
      out.add(`team:${team.team_id}`);
  }
  return out;
}

/**
 * Owners of each file the pull request changes, read from CODEOWNERS on the
 * target branch's current head (so a pull request cannot rewrite its own
 * owners), and whether an owner approved the current revision. Unowned
 * files count as approved.
 */
export async function pullCodeowners(
  env: Env,
  repo: RepoWithCreator,
  pull: Pull,
): Promise<PullCodeowners> {
  const target = (await getRef(env, repo.id, pull.base_ref))?.head ?? pull.base_cs;
  const codeowners = await loadCodeowners(env, repo, target);
  const { file, revision, errors } = codeowners;
  if (codeowners.rules.length === 0)
    return { file, revision, errors, files: [], truncated: false };
  const diff = await diffRevisions(env, repo.id, pull.base_cs, pull.head_cs);
  const paths = [
    ...new Set(diff.files.filter((f) => f.side === 'to').map((f) => f.path)),
  ];
  const approved = await approvers(env, repo, pull);
  return {
    file,
    revision,
    errors,
    truncated: diff.truncated,
    files: paths.map((path) => {
      const owners = ownersOf(codeowners, path);
      return {
        path,
        owners,
        approved: owners.length === 0 || owners.some((o) => approved.has(o)),
      };
    }),
  };
}

/**
 * Request review from the owners of the files an open pull request changes
 * (on open, a new head, or ready for review). Owners already requested keep
 * their state; the author is never requested. Runs after the change it
 * follows committed, so a failure is logged and the merge gate still holds.
 */
export async function requestCodeOwners(
  c: Context<AppEnv>,
  repo: RepoWithCreator,
  pull: Pull,
): Promise<void> {
  if (pull.state !== 'open') return;
  try {
    const owned = await pullCodeowners(c.env, repo, pull);
    const owners = new Set(owned.files.flatMap((f) => f.owners));
    owners.delete(`user:${pull.author_id}`);
    const current = new Set(
      (
        await q<{ principal: string }>(
          c.env,
          'SELECT principal FROM review_requests WHERE pull_id = ?',
          [pull.id],
        )
      ).map((r) => r.principal),
    );
    const added = [...owners].filter((p) => !current.has(p));
    if (added.length === 0) return;
    const now = Date.now();
    await recordAudit(
      c,
      {
        action: 'pull.reviewers.update',
        repo,
        target: { pull_id: pull.id, added, removed: [], via: 'codeowners' },
      },
      added.map((p) =>
        c.env.DB.prepare(
          `INSERT INTO review_requests (pull_id, principal, requested_by, state, created_at, updated_at)
           VALUES (?, ?, 'codeowners', 'pending', ?, ?) ON CONFLICT DO NOTHING`,
        ).bind(pull.id, p, now, now),
      ),
    );
    await emitEvent(c.env, repo, {
      event: 'pull_request',
      action: 'review_requested',
      actor: actorOf(c.get('principal')),
      origin: new URL(c.req.url).origin,
      data: { pull_request: pull, requested_reviewers: added, via: 'codeowners' },
    });
  } catch (err) {
    console.error('codeowners: review requests not made', err);
  }
}
