import { z } from 'zod';
import type { Env } from '../env';
import type { Principal } from '../auth/principal';
import { can, pathDecider, restrictingDecision, type PathDecider } from '../auth/rbac';
import { getRepo } from '../db/repos';
import { enforcePushRules } from '../policy/rulesets';
import {
  agentKey,
  changeFacts,
  guardAgentAction,
  type Guard,
} from '../policy/guardrails';
import { pauseFor, pauseMessage } from '../policy/pause';
import { commitChanges } from '../core/commit';
import { getChangeset, type Changeset } from '../core/changesets';
import { getBlob } from '../core/blobs';
import { getTree, resolvePath } from '../core/trees';
import { readRefHead, moveRefViaDO } from '../core/refs';
import { ApiError, ConflictError } from '../core/errors';
import { diffRevisions } from '../core/diff';
import { blameFile } from '../core/derived/blame';
import { pathHistoryAt } from '../core/derived/pathHistory';
import { getDerived } from '../core/derived';
import { lookupRev } from '../core/read';
import { ulid } from '../core/ids';
import { C, T } from '../db/schema';
import { q1, run } from '../db/client';
import { actorOf, appendAudit } from '../audit/record';
import { charge, type TaskBudget } from './budget';
import { POST_MERGE_FIX_MARKER, formatPostMergeTask } from './prompt';

/**
 * Agent tools (issue #18) — the agent's hands and eyes are **exactly the RPC
 * surface** (architecture §4): every tool maps 1:1 onto an endpoint and calls
 * the same core modules (no self-fetch), with real RBAC (`can()` from #14)
 * applied under the task's principal.
 *
 * Budget wrapper semantics: exceeding a budget returns
 * `{error: 'budget_exceeded'}` as a RESULT (never an exception) so the loop
 * can `finish` gracefully.
 */

export interface ToolCtx {
  repo_id: string;
  principal: Principal | null;
  base_cs: string;
  head_cs: string;
  budget: TaskBudget;
  task_id: string;
}

export interface ToolResult {
  [key: string]: unknown;
}

export interface Tool {
  name: string;
  description: string;
  input_schema: z.ZodType;
  execute(env: Env, ctx: ToolCtx, input: unknown): Promise<ToolResult>;
}

const MAX_READ_BYTES = 1024 * 1024;
const MAX_GREP_FILES = 500;
const MAX_GREP_BYTES = 32 * 1024 * 1024;
const MAX_MATCHES = 200;
const MAX_BLADE_RANGES = 200;

async function guardPath(
  env: Env,
  ctx: ToolCtx,
  perm: 'read' | 'history' | 'write',
  path?: string,
): Promise<ToolResult | null> {
  const repo = await getRepo(env, ctx.repo_id);
  if (!repo) return { error: 'repo_not_found' };
  const allowed = await can(env, repo, ctx.principal, perm, path);
  return allowed ? null : { error: 'forbidden', perm, path };
}

/**
 * Every tool call is an agent action (#62): an agent identity, else the MCP
 * caller's token, else the built-in run's task.
 */
function agentOf(ctx: ToolCtx): string {
  const p = ctx.principal;
  return (
    agentKey(p) ??
    (ctx.task_id === 'mcp' && p?.kind === 'token'
      ? `token:${p.tokenId}`
      : `task:${ctx.task_id}`)
  );
}

/** A guardrail refusal as a tool result the agent can read and adjust to (#62). */
function refusal(guard: Exclude<Guard, { outcome: 'allow' }>): ToolResult {
  return { error: guard.code, message: guard.message, ...guard.details };
}

/** Rules + membership loaded once for a batch of per-path decisions. */
async function deciderFor(env: Env, ctx: ToolCtx): Promise<PathDecider | null> {
  const repo = await getRepo(env, ctx.repo_id);
  return repo ? pathDecider(env, repo, ctx.principal) : null;
}

/**
 * Resolve a tool `cs` argument the way the HTTP read routes do: a raw
 * changeset id, `ref:<name>`, or a bare ref name. Omitted → the working head.
 */
async function resolveCs(
  env: Env,
  ctx: ToolCtx,
  rev: string | undefined,
): Promise<Changeset | null> {
  return lookupRev(env, ctx.repo_id, rev ?? ctx.head_cs);
}

/** The id the spawned task runs as: the real user behind this task. */
function spawnUser(ctx: ToolCtx): string {
  return ctx.principal?.userId ?? ctx.task_id;
}

const readFileSync = z.object({
  path: z.string(),
  cs: z.string().optional(),
});

const listDirSchema = z.object({
  path: z.string().optional(),
  cs: z.string().optional(),
  recursive: z.boolean().optional(),
});

const fileHistorySchema = z.object({
  path: z.string(),
  limit: z.number().int().positive().max(200).optional(),
});

const blameSchema = z.object({
  path: z.string(),
  cs: z.string().optional(),
  cursor: z.number().int().nonnegative().optional(),
});

const diffToolSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  text: z.boolean().optional(),
});

const grepSchema = z.object({
  pattern: z.string().min(1).max(200),
  path_prefix: z.string().optional(),
  cs: z.string().optional(),
});

const commitToolSchema = z.object({
  message: z.string().min(1).max(65536),
  /** Extra parents for merges (the land dance merges main back in). */
  parents: z.array(z.string().min(1)).optional(),
  changes: z
    .array(
      z.object({
        path: z.string(),
        op: z.enum(['add', 'mod', 'del']),
        content_b64: z.string().optional(),
        blob_sha256: z.string().optional(),
      }),
    )
    .max(500),
});

const createTaskSchema = z.object({
  prompt: z.string().min(1),
  kind: z.enum(['freeform', 'fix_issue', 'post_merge_check', 'superfan']).optional(),
});

export const tools: Tool[] = [
  {
    name: 'read_file',
    description: 'Read one file at a revision (≤ 1 MiB; use diff/ranges for larger).',
    input_schema: readFileSync,
    async execute(env, ctx, input) {
      const parsed = readFileSync.parse(input);
      const denied = await guardPath(env, ctx, 'read', parsed.path);
      if (denied) return denied;
      const cs = await resolveCs(env, ctx, parsed.cs);
      if (!cs?.root_tree) return { error: 'revision_not_found' };
      const entry = await resolvePath(
        env,
        ctx.repo_id,
        cs.root_tree,
        parsed.path.split('/'),
      );
      if (!entry || entry.kind !== 'blob')
        return { error: 'path_not_found', path: parsed.path };
      if ((entry.size ?? 0) > MAX_READ_BYTES) {
        return {
          error: 'file_too_large',
          hint: 'use diff or read specific ranges',
          size: entry.size,
        };
      }
      const blob = await getBlob(env, ctx.repo_id, entry.hash);
      return {
        path: parsed.path,
        blob_sha256: entry.hash,
        size: blob?.size ?? 0,
        content: blob ? new TextDecoder().decode(blob.content) : '',
      };
    },
  },
  {
    name: 'list_dir',
    description: 'List one directory level (or recursively) at a revision.',
    input_schema: listDirSchema,
    async execute(env, ctx, input) {
      const parsed = listDirSchema.parse(input);
      const path = parsed.path ?? '';
      const denied = await guardPath(env, ctx, 'read', path === '' ? undefined : path);
      if (denied) return denied;
      const cs = await resolveCs(env, ctx, parsed.cs);
      if (!cs?.root_tree) return { error: 'revision_not_found' };
      let treeHash = cs.root_tree;
      if (path !== '') {
        const entry = await resolvePath(env, ctx.repo_id, treeHash, path.split('/'));
        if (!entry || entry.kind !== 'tree') return { error: 'path_not_found', path };
        treeHash = entry.hash;
      }
      if (!parsed.recursive) {
        const tree = await getTree(env, ctx.repo_id, treeHash);
        return { path, entries: tree?.entries ?? [] };
      }
      const out: { path: string; kind: string }[] = [];
      const walk = async (hash: string, prefix: string): Promise<void> => {
        const tree = await getTree(env, ctx.repo_id, hash);
        for (const entry of tree?.entries ?? []) {
          const child = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
          out.push({ path: child, kind: entry.kind });
          if (entry.kind === 'tree') await walk(entry.hash, child);
          if (out.length > 5000) return;
        }
      };
      await walk(treeHash, path);
      return { path, entries: out };
    },
  },
  {
    name: 'file_history',
    description: 'Changesets touching a path, newest first.',
    input_schema: fileHistorySchema,
    async execute(env, ctx, input) {
      const parsed = fileHistorySchema.parse(input);
      const denied = await guardPath(env, ctx, 'history', parsed.path);
      if (denied) return denied;
      const result = await pathHistoryAt(
        env,
        ctx.repo_id,
        ctx.head_cs,
        parsed.path,
        parsed.limit ?? 20,
      );
      const changesets = [];
      for (const id of result.commits) {
        const cs = await getChangeset(env, ctx.repo_id, id);
        if (cs) {
          changesets.push({ id: cs.id, message: cs.message, created_at: cs.created_at });
        }
      }
      return { path: parsed.path, changesets, next: result.next };
    },
  },
  {
    name: 'blame',
    description: 'Line ranges → changesets for a file (paged, 200 ranges/page).',
    input_schema: blameSchema,
    async execute(env, ctx, input) {
      const parsed = blameSchema.parse(input);
      const denied = await guardPath(env, ctx, 'history', parsed.path);
      if (denied) return denied;
      const cs = await resolveCs(env, ctx, parsed.cs);
      if (!cs) return { error: 'revision_not_found' };
      const outcome = await blameFile(env, ctx.repo_id, cs.id, parsed.path);
      if (outcome.status !== 'ok') return { status: 'computing' };
      const cursor = parsed.cursor ?? 0;
      const page = outcome.ranges.slice(cursor, cursor + MAX_BLADE_RANGES);
      return {
        path: parsed.path,
        ranges: page,
        complete: outcome.complete,
        next:
          cursor + MAX_BLADE_RANGES < outcome.ranges.length
            ? cursor + MAX_BLADE_RANGES
            : null,
      };
    },
  },
  {
    name: 'diff',
    description:
      'Server-computed diff between two revisions (base_cs → head_cs by default).',
    input_schema: diffToolSchema,
    async execute(env, ctx, input) {
      const parsed = diffToolSchema.parse(input);
      const denied = await guardPath(env, ctx, 'read');
      if (denied) return denied;
      const from = await lookupRev(env, ctx.repo_id, parsed.from ?? ctx.base_cs);
      const to = await lookupRev(env, ctx.repo_id, parsed.to ?? ctx.head_cs);
      if (!from || !to) return { error: 'revision_not_found' };
      const result = await diffRevisions(env, ctx.repo_id, from.id, to.id, {
        includeText: parsed.text ?? true,
      });
      // path rules apply per file, exactly like read_file / the HTTP diff:
      // denied paths are dropped from both the file list and the text hunks
      const decider = await deciderFor(env, ctx);
      const readable = (path: string): boolean =>
        decider?.decide('read', path).allowed ?? false;
      return {
        ...result,
        files: result.files.filter((f) => readable(f.path)),
        ...(result.texts ? { texts: result.texts.filter((t) => readable(t.path)) } : {}),
      } as unknown as ToolResult;
    },
  },
  {
    name: 'grep',
    description:
      'Server-side regex search over changed paths (bounded: 500 files / 200 matches).',
    input_schema: grepSchema,
    async execute(env, ctx, input) {
      const parsed = grepSchema.parse(input);
      if (/\([^)]*[+*][^)]*\)[+*]/.test(parsed.pattern)) {
        return {
          error: 'unsafe_pattern',
          hint: 'nested quantifiers can backtrack catastrophically',
        };
      }
      let regex: RegExp;
      try {
        regex = new RegExp(parsed.pattern);
      } catch {
        return { error: 'invalid_pattern' };
      }

      // candidate set: changed_paths derived data (what this repo ever touched)
      const changed = await getDerived<{ paths: string[] }>(
        env,
        ctx.repo_id,
        'changed_paths',
        ctx.head_cs,
      );
      const prefix = parsed.path_prefix ?? '';
      const candidates = (changed?.paths ?? [])
        .filter((p) => prefix === '' || p.startsWith(prefix))
        .slice(0, MAX_GREP_FILES);

      const cs = await resolveCs(env, ctx, parsed.cs);
      if (!cs) return { error: 'revision_not_found' };
      const matches: { path: string; line: number; text: string }[] = [];
      let bytes = 0;
      for (const path of candidates) {
        if (matches.length >= MAX_MATCHES || bytes > MAX_GREP_BYTES) break;
        const denied = await guardPath(env, ctx, 'read', path);
        if (denied) continue; // path rules can hide files from grep too
        const entry = cs.root_tree
          ? await resolvePath(env, ctx.repo_id, cs.root_tree, path.split('/'))
          : null;
        if (!entry || entry.kind !== 'blob') continue;
        const blob = await getBlob(env, ctx.repo_id, entry.hash);
        if (!blob) continue;
        bytes += blob.size;
        const text = new TextDecoder().decode(blob.content);
        text.split('\n').forEach((lineText, index) => {
          if (matches.length < MAX_MATCHES && regex.test(lineText)) {
            matches.push({ path, line: index + 1, text: lineText.slice(0, 300) });
          }
        });
      }
      return {
        matches,
        truncated: matches.length >= MAX_MATCHES,
        scanned: candidates.length,
      };
    },
  },
  {
    name: 'commit',
    description: 'Create a changeset on top of head_cs (small focused commits win).',
    input_schema: commitToolSchema,
    async execute(env, ctx, input) {
      const parsed = commitToolSchema.parse(input);
      // repo write, then `write` on every touched path (same as POST changesets)
      const decider = await deciderFor(env, ctx);
      if (!decider?.decide('write').allowed) return { error: 'forbidden', perm: 'write' };
      for (const change of parsed.changes) {
        const decision = decider.decide('write', change.path);
        if (!decision.allowed) {
          return {
            error: 'forbidden',
            perm: 'write',
            path: change.path,
            ...(decision.deniedBy ? { denied_by: decision.deniedBy } : {}),
          };
        }
      }
      const budgetError = charge(ctx.budget, 'commit');
      if (budgetError) return budgetError;
      const changes = parsed.changes.map((change) =>
        change.op === 'del'
          ? { path: change.path, op: 'del' as const }
          : change.content_b64 !== undefined
            ? { path: change.path, op: change.op, content_b64: change.content_b64 }
            : {
                path: change.path,
                op: change.op,
                blob_sha256: change.blob_sha256 as string,
              },
      );
      // push rulesets (#41), as for the commit RPC
      const repo = await getRepo(env, ctx.repo_id);
      if (!repo) return { error: 'repo_not_found' };
      try {
        await enforcePushRules(
          env,
          repo,
          ctx.principal,
          { kind: 'agent', id: ctx.task_id, onBehalfOf: ctx.principal?.userId },
          changes,
          'agent.commit',
        );
      } catch (err) {
        if (err instanceof ApiError) return { error: err.code, message: err.message };
        throw err;
      }
      const guard = await guardAgentAction(
        env,
        ctx.principal,
        repo,
        { action: 'changeset.create', ...(await changeFacts(env, repo.id, changes)) },
        {
          exact: { first_parent: ctx.head_cs, parents: parsed.parents, changes },
          summary: {
            first_parent: ctx.head_cs,
            files: changes.slice(0, 100).map((ch) => ch.path),
            file_count: changes.length,
          },
        },
        agentOf(ctx),
      );
      if (guard.outcome !== 'allow') return refusal(guard);
      const result = await commitChanges(env, ctx.repo_id, {
        first_parent: ctx.head_cs,
        parents: parsed.parents,
        message: parsed.message,
        author: { agent: ctx.task_id },
        changes,
      });
      ctx.head_cs = result.changeset.id; // working revision advances
      return {
        cs: result.changeset.id,
        deduped: result.deduped,
        changed_files: result.changeset.changed_files,
        budget: { commits: ctx.budget.commits, maxCommits: ctx.budget.maxCommits },
      };
    },
  },
  {
    name: 'land',
    description:
      'CAS-move the default branch to head_cs. Stale → merge (parents [head_cs, main_head]) and retry; any other refusal is final; success triggers post-merge checks.',
    input_schema: z.object({}),
    async execute(env, ctx) {
      const repo = await getRepo(env, ctx.repo_id);
      const allowed = repo ? await can(env, repo, ctx.principal, 'write') : false;
      if (!repo || !allowed) return { error: 'forbidden', perm: 'write' };
      // a ref move can replace any path: whole-repo write, like PUT refs
      const restricted = restrictingDecision(
        await pathDecider(env, repo, ctx.principal),
        ['read', 'write'],
      );
      if (restricted) {
        return {
          landed: false,
          reason: 'whole_repository_required',
          final: true,
          head_cs: ctx.head_cs,
          ...(restricted.deniedBy ? { denied_by: restricted.deniedBy } : {}),
        };
      }
      const branch = repo.default_branch;
      const current = await readRefHead(env, ctx.repo_id, branch);
      const guard = await guardAgentAction(
        env,
        ctx.principal,
        repo,
        { action: 'ref.move', ref: branch },
        {
          exact: { ref: branch, from: current, to: ctx.head_cs },
          summary: { ref: branch, from: current, to: ctx.head_cs },
        },
        agentOf(ctx),
      );
      if (guard.outcome !== 'allow')
        return { landed: false, reason: guard.code, final: true, ...refusal(guard) };
      try {
        await moveRefViaDO(env, ctx.repo_id, branch, {
          from: current,
          to: ctx.head_cs,
          actor: ctx.principal,
          via: 'agent.land',
        });
      } catch (err) {
        // only losing the race to another land is retryable (merge, then land
        // again) — a protected branch would otherwise loop until the budget dies
        if (!(err instanceof ConflictError)) {
          const code = err instanceof ApiError ? err.code : 'internal_error';
          // a ruleset refusal names the ruleset in its message
          const message = err instanceof ApiError ? { message: err.message } : {};
          return {
            landed: false,
            reason: code,
            ...message,
            final: true,
            head_cs: ctx.head_cs,
          };
        }
        // stale or not a fast-forward: someone else landed — merge and retry
        const head = await readRefHead(env, ctx.repo_id, branch);
        return { landed: false, reason: 'stale', main_head: head, head_cs: ctx.head_cs };
      }
      await appendAudit(env, {
        action: 'ref.move',
        repo,
        actor:
          ctx.task_id === 'mcp'
            ? actorOf(ctx.principal)
            : { kind: 'agent', id: ctx.task_id, onBehalfOf: ctx.principal?.userId },
        target: { ref: branch, from: current, to: ctx.head_cs, via: 'agent.land' },
      });
      // post-merge, pre-deploy checks — the no-merge-queue model (§2.3):
      // base = the pre-land head, head = what just landed, prompt = the files
      const preLand = current ?? ctx.head_cs;
      const landedDiff = await diffRevisions(env, ctx.repo_id, preLand, ctx.head_cs, {
        mode: 'direct',
      });
      // a fix task's own check never spawns another fix (lineage cap: 1)
      const self = await q1<{ prompt: string }>(
        env,
        `SELECT ${C.agentTasks.prompt} FROM ${T.agentTasks} WHERE ${C.agentTasks.id} = ?`,
        [ctx.task_id],
      );
      const fromFix = self?.prompt.startsWith(POST_MERGE_FIX_MARKER) ?? false;
      const checkId = ulid();
      const now = Date.now();
      await run(
        env,
        `INSERT INTO ${T.agentTasks}
           (${C.agentTasks.id}, ${C.agentTasks.repoId}, ${C.agentTasks.kind}, ${C.agentTasks.prompt},
            ${C.agentTasks.status}, ${C.agentTasks.baseCs}, ${C.agentTasks.agentState},
            ${C.agentTasks.createdBy}, ${C.agentTasks.createdAt}, ${C.agentTasks.updatedAt})
         VALUES (?, ?, 'post_merge_check', ?, 'queued', ?, ?, ?, ?, ?)`,
        [
          checkId,
          ctx.repo_id,
          formatPostMergeTask(
            ctx.head_cs,
            [...new Set(landedDiff.files.map((f) => f.path))],
            fromFix,
          ),
          preLand,
          checkId,
          spawnUser(ctx),
          now,
          now,
        ],
      );
      await env.AGENT_QUEUE.send({ task_id: checkId });
      return { landed: true, main_head: ctx.head_cs, post_merge_check: checkId };
    },
  },
  {
    name: 'create_task',
    description: 'Spawn a sub-task (depth ≤ 2, ≤ 5 fan-out per task).',
    input_schema: createTaskSchema,
    async execute(env, ctx, input) {
      const parsed = createTaskSchema.parse(input);
      if (ctx.budget.depth >= 2)
        return { error: 'depth_exceeded', depth: ctx.budget.depth };
      if (ctx.budget.fanOut >= 5)
        return { error: 'fan_out_exceeded', fanOut: ctx.budget.fanOut };
      const repo = await getRepo(env, ctx.repo_id);
      const allowed = repo ? await can(env, repo, ctx.principal, 'write') : false;
      if (!allowed) return { error: 'forbidden', perm: 'write' };
      ctx.budget.fanOut++;
      const id = ulid();
      const now = Date.now();
      await run(
        env,
        `INSERT INTO ${T.agentTasks}
           (${C.agentTasks.id}, ${C.agentTasks.repoId}, ${C.agentTasks.kind}, ${C.agentTasks.prompt},
            ${C.agentTasks.status}, ${C.agentTasks.baseCs}, ${C.agentTasks.agentState},
            ${C.agentTasks.createdBy}, ${C.agentTasks.createdAt}, ${C.agentTasks.updatedAt})
         VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
        [
          id,
          ctx.repo_id,
          parsed.kind ?? 'freeform',
          parsed.prompt,
          ctx.head_cs,
          id,
          spawnUser(ctx),
          now,
          now,
        ],
      );
      await env.AGENT_QUEUE.send({ task_id: id });
      return { task_id: id, status: 'queued' };
    },
  },
  {
    name: 'finish',
    description: 'Terminal success: the loop stops here with this summary.',
    input_schema: z.object({
      summary: z.string().min(1),
      result_cs: z.string().optional(),
    }),
    async execute(_env, ctx, input) {
      const parsed = z
        .object({ summary: z.string(), result_cs: z.string().optional() })
        .parse(input);
      return {
        terminal: 'finish',
        summary: parsed.summary,
        result_cs: parsed.result_cs ?? ctx.head_cs,
      };
    },
  },
  {
    name: 'report_failure',
    description: 'Terminal failure with a structured reason (never fabricate success).',
    input_schema: z.object({ reason: z.string().min(1) }),
    async execute(_env, _ctx, input) {
      const parsed = z.object({ reason: z.string() }).parse(input);
      return { terminal: 'failure', reason: parsed.reason };
    },
  },
];

export const toolRegistry = new Map(tools.map((tool) => [tool.name, tool]));

/**
 * Execute a tool with budget accounting. Over-budget is a RESULT, not a throw:
 * the loop can still call `finish`.
 */
export async function executeTool(
  env: Env,
  ctx: ToolCtx,
  name: string,
  input: unknown,
): Promise<ToolResult> {
  const tool = toolRegistry.get(name);
  if (!tool) return { error: 'unknown_tool', name };
  const budgetError = charge(ctx.budget, 'tool');
  if (budgetError) return budgetError;
  // kill switch (#62): a paused org or instance ends the run at its next tool
  const repo = await getRepo(env, ctx.repo_id);
  const pause = repo ? await pauseFor(env, repo) : null;
  if (pause) {
    const reason = pauseMessage(pause);
    return { error: 'agents_paused', message: reason, terminal: 'failure', reason };
  }
  try {
    return await tool.execute(env, ctx, input);
  } catch (err) {
    // tool failures are results too — the loop decides what to do next
    return {
      error: 'tool_failed',
      tool: name,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export type { TaskBudget };
