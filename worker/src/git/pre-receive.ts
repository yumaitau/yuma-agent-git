import type { Env } from '../env';
import type { RepoRecord } from '../db/client';
import type { Principal } from '../auth/principal';
import { agentIdOf, hasScope } from '../auth/principal';
import type { PathDecider } from '../auth/rbac';
import { MAX_FILE_BYTES } from '../bridge/import';
import { agentRefOwner, TAG_PREFIX } from '../core/refs';
import { actorFor, evaluate, rulesetsFor, type Outcome } from '../policy/rulesets';
import { isManifest, npmDependencies, type Dependency } from '../policy/engine';
import { agentKey, guardAgentAction } from '../policy/guardrails';

/**
 * Pre-receive checks (issue #32): every check sees the whole push before any
 * changeset is written and returns verdicts naming the ref, the rule and a
 * message `git push` prints. Checks are pure over the parsed push plus a
 * bounded number of D1 reads, so they are deterministic and quick.
 *
 * Secret scanning (#66) joins this list as a further `Check`. Agent policy
 * (#62) runs last, so only pushes every other check passes ask a human.
 */

/** One file change of a pushed commit, relative to its first parent. */
export interface GitChange {
  path: string;
  op: 'add' | 'mod' | 'del';
  sha?: string;
  mode?: string;
  /** Inflated size when the blob arrived in this pack. */
  size?: number;
}

export interface PushCommit {
  sha: string;
  changes: GitChange[];
  /** Every tree the commit adds or changes: its path and entry names. */
  trees: { path: string; names: string[] }[];
}

export interface PushUpdate {
  /** Ref name as Git sent it. */
  ref: string;
  /** Ref name inside the forge (`main`, `refs/tags/v1`). */
  name: string;
  oldSha: string;
  newSha: string;
  /** Changeset the ref points at now (null when created by this push). */
  from: string | null;
  deleting: boolean;
  fastForward: boolean;
  /** New commits this update makes reachable. */
  commits: string[];
  error?: string;
  /** Push-ruleset outcome, recorded once the ref has moved. */
  pushRules?: Outcome;
}

export interface PreReceiveContext {
  env: Env;
  repo: RepoRecord;
  principal: Principal;
  decider: PathDecider;
  commits: Map<string, PushCommit>;
  /** Net file changes the ref sees (old head → new head). */
  refChanges(update: PushUpdate): Promise<GitChange[]>;
  /** A blob's bytes from the pack or the store, or null. */
  readBlob(sha: string): Promise<Uint8Array | null>;
}

export interface Verdict {
  ref: string;
  rule: string;
  message: string;
}

export type Check = (ctx: PreReceiveContext, updates: PushUpdate[]) => Promise<Verdict[]>;

function changesOf(ctx: PreReceiveContext, update: PushUpdate): GitChange[] {
  return update.commits.flatMap((sha) => ctx.commits.get(sha)?.changes ?? []);
}

/** `refs/agents/<id>/…` belongs to the agent with that id, as for PUT refs. */
const agentRefs: Check = async (ctx, updates) =>
  updates.flatMap((u) => {
    const owner = agentRefOwner(u.name);
    if (owner === null || agentIdOf(ctx.principal) === owner) {
      return [];
    }
    return [
      {
        ref: u.ref,
        rule: 'agent_ref',
        message: `only agent ${owner} may write ${u.name}`,
      },
    ];
  });

/**
 * Agent tokens (#57) never update the default branch (they open a pull
 * request) and need `releases:write` for tags.
 */
const agentLimits: Check = async (ctx, updates) =>
  ctx.principal.kind !== 'agent'
    ? []
    : updates.flatMap((u): Verdict[] => {
        if (u.name === ctx.repo.default_branch) {
          return [
            {
              ref: u.ref,
              rule: 'agent_default_branch',
              message: 'agents cannot update the default branch; open a pull request',
            },
          ];
        }
        if (u.name.startsWith(TAG_PREFIX) && !hasScope(ctx.principal, 'releases:write')) {
          return [
            {
              ref: u.ref,
              rule: 'agent_scope',
              message: 'pushing tags needs the releases:write scope',
            },
          ];
        }
        return [];
      });

/** The default branch is never deleted or rewritten by a push. */
const protectedRefs: Check = async (ctx, updates) => {
  const mine = updates.filter((u) => u.name === ctx.repo.default_branch);
  if (mine.length === 0) return [];
  return mine.flatMap((u): Verdict[] => {
    if (u.deleting) {
      return [
        {
          ref: u.ref,
          rule: 'protected_branch',
          message: 'the default branch cannot be deleted',
        },
      ];
    }
    if (!u.fastForward) {
      return [
        {
          ref: u.ref,
          rule: 'protected_branch',
          message: 'force pushes to the default branch are not allowed',
        },
      ];
    }
    return [];
  });
};

/**
 * Rulesets (#41): branch and tag rules as the ref-lock Durable Object applies
 * them on the move (refused here so `git push` names the ruleset and nothing
 * is stored), and push rules over every file the new commits change.
 */
const rulesets: Check = async (ctx, updates) => {
  const all = await rulesetsFor(ctx.env, ctx.repo);
  if (all.length === 0) return [];
  const actor = await actorFor(ctx.env, ctx.repo, ctx.principal, all);
  const out: Verdict[] = [];
  for (const u of updates) {
    const ref = evaluate(all, {
      repo: ctx.repo,
      actor,
      ref: {
        name: u.name,
        kind: u.deleting ? 'delete' : u.from === null ? 'create' : 'update',
        fastForward: u.fastForward,
      },
    });
    u.pushRules = evaluate(all, {
      repo: ctx.repo,
      actor,
      files: changesOf(ctx, u).map((c) => ({ path: c.path, op: c.op, size: c.size })),
    });
    const v = ref.blocking[0] ?? u.pushRules.blocking[0];
    if (v)
      out.push({
        ref: u.ref,
        rule: `ruleset "${v.ruleset}" ${v.rule}`,
        message: v.message,
      });
  }
  return out;
};

/** Path rules: `write` on every path the new commits touch and the ref changes. */
const pathRules: Check = async (ctx, updates) => {
  if (ctx.decider.rules.length === 0) return [];
  const out: Verdict[] = [];
  for (const u of updates) {
    const paths = new Set(changesOf(ctx, u).map((c) => c.path));
    if (u.from !== null) for (const c of await ctx.refChanges(u)) paths.add(c.path);
    for (const path of paths) {
      const decision = ctx.decider.decide('write', path);
      if (decision.allowed) continue;
      const rule = decision.deniedBy ? `path_rule ${decision.deniedBy.id}` : 'path_rule';
      out.push({ ref: u.ref, rule, message: `write denied on ${path}` });
      break;
    }
  }
  return out;
};

const maxFileSize: Check = async (ctx, updates) =>
  updates.flatMap((u) => {
    const big = changesOf(ctx, u).find((c) => (c.size ?? 0) > MAX_FILE_BYTES);
    return big
      ? [
          {
            ref: u.ref,
            rule: 'max_file_size',
            message: `${big.path} is ${big.size} bytes; the limit is ${MAX_FILE_BYTES}`,
          },
        ]
      : [];
  });

/** `.git` under any spelling Windows or macOS would resolve to it. */
function isDotGit(name: string): boolean {
  const folded = name.toLowerCase().replace(/[\u200c-\u200f\u202a-\u202e\ufeff]/g, '');
  return folded.replace(/[. ]+$/, '') === '.git' || folded === 'git~1';
}

/**
 * Paths that attack clients: a `.git` component, two names in one tree that
 * collide on a case-insensitive filesystem, and submodules (not supported).
 */
const pathSafety: Check = async (ctx, updates) =>
  updates.flatMap((u): Verdict[] => {
    for (const sha of u.commits) {
      const commit = ctx.commits.get(sha);
      if (!commit) continue;
      for (const change of commit.changes) {
        if (change.path.split('/').some(isDotGit)) {
          return [
            {
              ref: u.ref,
              rule: 'unsafe_path',
              message: `${change.path} names a .git directory`,
            },
          ];
        }
        if (change.mode === '160000') {
          return [
            {
              ref: u.ref,
              rule: 'submodule',
              message: `${change.path} is a submodule; submodules are not supported`,
            },
          ];
        }
      }
      for (const tree of commit.trees) {
        const seen = new Set<string>();
        for (const name of tree.names) {
          const key = name.normalize('NFC').toLowerCase();
          if (seen.has(key)) {
            const path = tree.path === '' ? name : `${tree.path}/${name}`;
            return [
              {
                ref: u.ref,
                rule: 'case_collision',
                message: `${path} collides with another name that differs only in case`,
              },
            ];
          }
          seen.add(key);
        }
      }
    }
    return [];
  });

/**
 * Agent guardrails (#62): the kill switch and the org policy judge each ref
 * update an agent pushes (`push`, or `release.publish` for tags). A held
 * update names its approval; once a human approves, pushing the same old and
 * new SHAs lands.
 */
const agentPolicy: Check = async (ctx, updates) => {
  if (agentKey(ctx.principal) === null) return [];
  const out: Verdict[] = [];
  for (const u of updates) {
    const changes = changesOf(ctx, u);
    const dependencies: Dependency[] = [];
    for (const c of changes) {
      if (c.op === 'del' || !c.sha || !isManifest(c.path)) continue;
      const bytes = await ctx.readBlob(c.sha);
      dependencies.push(
        ...(bytes
          ? npmDependencies(new TextDecoder().decode(bytes))
          : [{ name: c.path, registry: 'invalid' }]),
      );
    }
    const guard = await guardAgentAction(
      ctx.env,
      ctx.principal,
      ctx.repo,
      {
        // a tag is a release however it arrives
        action: u.name.startsWith(TAG_PREFIX) ? 'release.publish' : 'push',
        ref: u.name,
        files: changes.map((c) => ({
          path: c.path,
          op: c.op,
          ...(c.size === undefined ? {} : { size: c.size }),
        })),
        force_push: !u.deleting && !u.fastForward,
        dependencies,
      },
      {
        exact: { ref: u.name, old: u.oldSha, new: u.newSha },
        summary: {
          ref: u.name,
          old: u.oldSha,
          new: u.newSha,
          files: changes.slice(0, 100).map((c) => c.path),
          file_count: changes.length,
        },
      },
    );
    if (guard.outcome !== 'allow')
      out.push({ ref: u.ref, rule: guard.code, message: guard.message });
  }
  return out;
};

export const CHECKS: Check[] = [
  agentRefs,
  agentLimits,
  rulesets,
  protectedRefs,
  pathRules,
  maxFileSize,
  pathSafety,
  agentPolicy,
];

/**
 * Run the checks in order; the first verdict per ref is the one reported, and
 * a refused ref is not shown to later checks.
 */
export async function preReceive(
  ctx: PreReceiveContext,
  updates: PushUpdate[],
): Promise<Map<string, Verdict>> {
  const verdicts = new Map<string, Verdict>();
  for (const check of CHECKS) {
    const open = updates.filter((u) => !verdicts.has(u.ref));
    if (open.length === 0) break;
    for (const verdict of await check(ctx, open)) {
      if (!verdicts.has(verdict.ref)) verdicts.set(verdict.ref, verdict);
    }
  }
  return verdicts;
}
