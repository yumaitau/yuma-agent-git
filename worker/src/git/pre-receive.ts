import type { Env } from '../env';
import type { RepoRecord } from '../db/client';
import type { Principal } from '../auth/principal';
import { hasScope } from '../auth/principal';
import type { PathDecider } from '../auth/rbac';
import { MAX_FILE_BYTES } from '../bridge/import';
import { settings } from '../ci/config';
import { agentRefOwner } from '../core/refs';

/**
 * Pre-receive checks (issue #32): every check sees the whole push before any
 * changeset is written and returns verdicts naming the ref, the rule and a
 * message `git push` prints. Checks are pure over the parsed push plus a
 * bounded number of D1 reads, so they are deterministic and quick.
 *
 * Rulesets (#41), secret scanning (#66) and agent policy (#62) join this
 * list as further `Check`s when those features exist.
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
}

export interface PreReceiveContext {
  env: Env;
  repo: RepoRecord;
  principal: Principal;
  decider: PathDecider;
  commits: Map<string, PushCommit>;
  /** Net file changes the ref sees (old head → new head). */
  refChanges(update: PushUpdate): Promise<GitChange[]>;
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

/** `refs/agents/<id>/…` belongs to the agent token with that id, as for PUT refs. */
const agentRefs: Check = async (ctx, updates) =>
  updates.flatMap((u) => {
    const owner = agentRefOwner(u.name);
    const p = ctx.principal;
    if (
      owner === null ||
      (p.kind === 'token' && hasScope(p, 'agent:run') && p.tokenId === owner)
    ) {
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
 * The default branch is protected: never deleted, never rewritten, and with
 * the CI policy `protect_default` only changed through a pull request.
 */
const protectedRefs: Check = async (ctx, updates) => {
  const mine = updates.filter((u) => u.name === ctx.repo.default_branch);
  if (mine.length === 0) return [];
  const config = await settings(ctx.env, ctx.repo.id);
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
    if (config?.policy.protect_default) {
      return [
        {
          ref: u.ref,
          rule: 'protected_branch (protect_default)',
          message: 'open a pull request to update the protected default branch',
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

export const CHECKS: Check[] = [
  agentRefs,
  protectedRefs,
  pathRules,
  maxFileSize,
  pathSafety,
];

/** Run every check; the first verdict per ref is the one reported. */
export async function preReceive(
  ctx: PreReceiveContext,
  updates: PushUpdate[],
): Promise<Map<string, Verdict>> {
  const verdicts = new Map<string, Verdict>();
  for (const check of CHECKS) {
    for (const verdict of await check(ctx, updates)) {
      if (!verdicts.has(verdict.ref)) verdicts.set(verdict.ref, verdict);
    }
  }
  return verdicts;
}
