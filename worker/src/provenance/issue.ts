import type { Env } from '../env';
import type { RepoRecord } from '../db/client';
import { q, q1, run } from '../db/client';
import type { Principal } from '../auth/principal';
import { dagMergeBases } from '../core/ancestry';
import { getChangeset } from '../core/changesets';
import { ulid } from '../core/ids';
import { AGENT_PREFIX, TAG_PREFIX } from '../core/refs';
import { gitIdentity } from '../git/identity';
import { commitShas } from '../git/upload-pack';
import { applies, rulesetsFor, type Outcome, type Violation } from '../policy/rulesets';
import { signEnvelope } from './dsse';

/**
 * Source provenance (issue #58): every move of a protected ref (the default
 * branch, or a branch or tag any ruleset covers) gets one in-toto statement,
 * signed by the forge into a DSSE envelope with the same key ring as CI
 * attestations (#54), published at `/.well-known/yag-provenance-keys`.
 *
 * SLSA v1.2's source track asks for tamper-resistant provenance of protected
 * branch updates but fixes no predicate, so the predicate type is this
 * forge's own. It names the ref and both revisions, who moved it (agent, the
 * human it acted for, task), how (`via`), the pull requests it landed with
 * their approvals and checks, the rulesets that applied with any bypass, and
 * each new changeset with its author, agent, signature check and sessions
 * (model, harness, tools, transcript SHA-256).
 *
 * Issued after the move, like the ruleset log: a failed issue never fails
 * the move. Without CI_OIDC_SIGNING_KEYS nothing is issued, and a
 * `required_provenance` rule then refuses the move instead (rulesets.ts).
 */

export const SOURCE_PREDICATE = 'urn:yuma-agent-git:source-provenance:v1';
/** Changesets listed in one statement; the rest are counted. */
export const MAX_LISTED = 100;

export interface RefMove {
  repo: RepoRecord;
  ref: string;
  from: string | null;
  to: string | null;
  via: string;
  actor: Principal | null;
  outcome: Outcome | null;
  /** Pull request ids this move landed (merges and the merge queue). */
  pulls?: number[];
}

export function canSign(env: Env): boolean {
  return Boolean(env.CI_OIDC_SIGNING_KEYS);
}

/** Git's name for a forge ref: branches live under `refs/heads/`. */
export function gitRefName(ref: string): string {
  return ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
}

async function actorFacts(env: Env, principal: Principal | null) {
  if (principal === null) return { actor: { kind: 'system', id: 'system' } };
  const human = await q1<{ login: string }>(env, 'SELECT login FROM users WHERE id = ?', [
    principal.userId,
  ]);
  const onBehalfOf = { id: principal.userId, login: human?.login ?? null };
  if (principal.kind === 'user') return { actor: { kind: 'user', ...onBehalfOf } };
  if (principal.kind === 'agent') {
    const agent = await q1<{ name: string; kind: string }>(
      env,
      'SELECT name, kind FROM agents WHERE id = ?',
      [principal.agentId],
    );
    return {
      actor: { kind: 'agent', id: principal.agentId },
      agent: {
        id: principal.agentId,
        name: agent?.name ?? null,
        kind: agent?.kind ?? null,
      },
      on_behalf_of: onBehalfOf,
      task_id: principal.taskId,
    };
  }
  return {
    actor: {
      kind: 'token',
      id: principal.tokenId,
      ...(principal.ciRunId ? { ci_run: principal.ciRunId } : {}),
    },
    on_behalf_of: onBehalfOf,
  };
}

async function pullFacts(env: Env, repoId: string, ids: readonly number[]) {
  const out: Record<string, unknown>[] = [];
  for (const id of ids) {
    const pull = await q1<{
      number: number;
      head_cs: string;
      revision: number;
      author_id: string;
      merge_method: string | null;
    }>(
      env,
      'SELECT number, head_cs, revision, author_id, merge_method FROM pull_requests WHERE repo_id = ? AND id = ?',
      [repoId, id],
    );
    if (!pull) continue;
    const reviews = await q<{ author_id: string; login: string | null; decision: string }>(
      env,
      `SELECT r.author_id, u.login, r.decision FROM pull_reviews r
         LEFT JOIN users u ON u.id = r.author_id
        WHERE r.pull_id = ? AND r.head_cs = ? AND r.revision = ? AND r.decision != 'comment'
        ORDER BY r.id`,
      [id, pull.head_cs, pull.revision],
    );
    const checks = await q<{ id: string; state: string; pipeline_run_id: string | null }>(
      env,
      `SELECT id, state, pipeline_run_id FROM ci_runs WHERE repo_id = ? AND head_cs = ?
        ORDER BY created_at DESC LIMIT 20`,
      [repoId, pull.head_cs],
    );
    out.push({
      number: pull.number,
      head: pull.head_cs,
      revision: pull.revision,
      author_id: pull.author_id,
      method: pull.merge_method,
      reviews: reviews.map((r) => ({ by: r.login ?? r.author_id, decision: r.decision })),
      checks: checks.map((r) => ({
        run: r.id,
        state: r.state,
        pipeline_run: r.pipeline_run_id,
      })),
    });
  }
  return out;
}

/** New changesets in `from..to`, newest first, at most `MAX_LISTED`. */
async function newChangesets(
  env: Env,
  repoId: string,
  from: string | null,
  to: string,
): Promise<{ ids: string[]; total: number | null }> {
  if (from === null) return { ids: [to], total: null };
  try {
    const { onlyB } = await dagMergeBases(env, repoId, from, to, 2_000);
    const ids = onlyB.map((cs) => cs.id);
    return { ids: ids.slice(0, MAX_LISTED), total: ids.length };
  } catch {
    return { ids: [to], total: null }; // too far apart to walk: name the head
  }
}

async function changesetFacts(env: Env, repoId: string, ids: string[]) {
  const shas = await commitShas(env, repoId, ids);
  const out: Record<string, unknown>[] = [];
  for (const id of ids) {
    const cs = await getChangeset(env, repoId, id);
    if (!cs) continue;
    const agent = await q1<{ agent_id: string; on_behalf_of: string; task_id: string | null }>(
      env,
      'SELECT agent_id, on_behalf_of, task_id FROM changeset_agents WHERE repo_id = ? AND changeset_id = ?',
      [repoId, id],
    );
    const signature = await q1<{
      status: string;
      format: string | null;
      key_id: string | null;
      signer: string | null;
    }>(
      env,
      'SELECT status, format, key_id, signer FROM commit_signatures WHERE repo_id = ? AND cs_id = ?',
      [repoId, id],
    );
    const sessions = await q<{
      id: string;
      model: string | null;
      harness: string | null;
      tools: string;
      transcript_sha256: string | null;
    }>(
      env,
      `SELECT s.id, s.model, s.harness, s.tools, s.transcript_sha256
         FROM changeset_sessions l JOIN agent_sessions s ON s.id = l.session_id
        WHERE l.repo_id = ? AND l.cs_id = ? ORDER BY s.id`,
      [repoId, id],
    );
    out.push({
      id,
      git_commit: shas.get(id) ?? null,
      author: gitIdentity(cs.author),
      agent: agent
        ? { id: agent.agent_id, on_behalf_of: agent.on_behalf_of, task_id: agent.task_id }
        : null,
      // no row: the forge wrote this changeset itself (API, merge, agent tool)
      signature: signature ?? { status: 'forge' },
      sessions: sessions.map((s) => ({
        id: s.id,
        model: s.model,
        harness: s.harness,
        tools: JSON.parse(s.tools) as unknown,
        transcript_sha256: s.transcript_sha256,
      })),
    });
  }
  return out;
}

function violations(list: readonly Violation[]) {
  return list.map((v) => ({ ruleset: v.ruleset, rule: v.rule, message: v.message }));
}

/** Build the statement for one move (exported for tests and the verifier). */
export async function buildStatement(
  env: Env,
  move: RefMove,
  now: number,
): Promise<Record<string, unknown>> {
  const { repo } = move;
  const shas = await commitShas(
    env,
    repo.id,
    [move.from, move.to].filter((x): x is string => x !== null),
  );
  const rev = (cs: string | null) =>
    cs === null ? null : { yagChangeset: cs, gitCommit: shas.get(cs) ?? null };
  const rulesets = (await rulesetsFor(env, repo)).filter((r) => applies(r, repo, move.ref));
  const listed = move.to
    ? await newChangesets(env, repo.id, move.from, move.to)
    : { ids: [], total: 0 };
  const subjectCs = (move.to ?? move.from) as string;
  const subject = rev(subjectCs)!;
  return {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [
      {
        name: `${repo.slug}@${gitRefName(move.ref)}`,
        digest: {
          yagChangeset: subject.yagChangeset,
          ...(subject.gitCommit ? { gitCommit: subject.gitCommit } : {}),
        },
      },
    ],
    predicateType: SOURCE_PREDICATE,
    predicate: {
      repository: { id: repo.id, slug: repo.slug },
      ref: gitRefName(move.ref),
      kind: move.to === null ? 'delete' : move.from === null ? 'create' : 'update',
      previous: rev(move.from),
      current: rev(move.to),
      via: move.via,
      timestamp: new Date(now).toISOString(),
      ...(await actorFacts(env, move.actor)),
      pull_requests: await pullFacts(env, repo.id, move.pulls ?? []),
      rulesets: {
        applied: rulesets.map((r) => ({
          id: r.id,
          name: r.name,
          enforcement: r.enforcement,
          rules: r.rules.map((rule) => rule.type),
        })),
        bypassed: violations(move.outcome?.bypassed ?? []),
        evaluated: violations(move.outcome?.evaluated ?? []),
      },
      bypass: (move.outcome?.bypassed.length ?? 0) > 0,
      changesets: await changesetFacts(env, repo.id, listed.ids),
      changesets_total: listed.total,
    },
  };
}

/** Whether moves of `ref` get provenance: the default branch, or a ruleset covers it. */
export async function isProtected(
  env: Env,
  repo: RepoRecord,
  ref: string,
): Promise<boolean> {
  if (ref.startsWith(AGENT_PREFIX)) return false;
  if (ref === repo.default_branch) return true;
  if (!ref.startsWith('refs/') || ref.startsWith(TAG_PREFIX))
    return (await rulesetsFor(env, repo)).some(
      (r) => r.target !== 'push' && applies(r, repo, ref),
    );
  return false;
}

/** Sign and store the statement for a protected ref move; null when not issued. */
export async function issueProvenance(env: Env, move: RefMove): Promise<string | null> {
  if (move.from === move.to || !canSign(env)) return null;
  if (!(await isProtected(env, move.repo, move.ref))) return null;
  const now = Date.now();
  const statement = await buildStatement(env, move, now);
  const { envelope, keyId } = await signEnvelope(env, statement);
  const id = ulid(now);
  await run(
    env,
    `INSERT INTO provenance (id, repo_id, ref, old_cs, new_cs, via, bypass, statement,
       envelope, key_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      move.repo.id,
      move.ref,
      move.from,
      move.to,
      move.via,
      (move.outcome?.bypassed.length ?? 0) > 0 ? 1 : 0,
      JSON.stringify(statement),
      JSON.stringify(envelope),
      keyId,
      now,
    ],
  );
  return id;
}

/** `issueProvenance` for call sites that already moved the ref: logs, never throws. */
export async function issueAfterMove(env: Env, move: RefMove): Promise<void> {
  try {
    await issueProvenance(env, move);
  } catch (err) {
    console.error('provenance not issued', move.repo.id, move.ref, err);
  }
}
