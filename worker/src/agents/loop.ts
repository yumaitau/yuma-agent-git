import type { Env } from '../env';
import { C, T } from '../db/schema';
import { chat, buildMessages } from './llm';
import { executeTool, type ToolCtx } from './tools';
import { charge, type TaskBudget } from './budget';
import { ulid } from '../core/ids';
import {
  TOOL_NUDGE,
  fixIssuePrompt,
  parsePostMergeTask,
  postMergeFixPrompt,
  postMergePrompt,
} from './prompt';
import type { AgentState, TranscriptEntry } from './runtime';
import type { Principal } from '../auth/principal';

/**
 * Think → act → observe (issue #19) — the loop that turns a prompt into landed
 * changesets. Crash-safe by construction: state (including the budget counters
 * and the turn number) is persisted **before** tools execute, so a DO
 * eviction resumes mid-plan instead of double-committing or re-spending.
 *
 * Terminal conditions: `finish` (done) / `report_failure` (failed) tool
 * results; budget exhaustion, deadline and the turn cap (10 LLM turns) end
 * the run as failed with the reason — committed work is never lost, but it
 * is not reported as success; cancellation is checked between turns and
 * between tool calls.
 */

export interface LoopSession {
  task_id: string;
  repo_id: string;
  prompt: string;
  kind: string;
  /** The task's principal — the creating user's identity + agent:<id> token. */
  principal: Principal;
  /** GitHub issue number for fix_issue tasks. */
  github_issue?: string | null;
  budget: TaskBudget;
  state(): AgentState;
  setState(next: AgentState): void;
  record(entry: TranscriptEntry): Promise<void>;
}

export interface LoopOutcome {
  status: 'done' | 'failed' | 'cancelled';
  /** What ended the run. */
  via: 'finish' | 'report_failure' | 'budget' | 'cancelled' | 'timeout';
  summary?: string;
  reason?: string;
  head_cs: string;
  turns: number;
}

export const MAX_LLM_TURNS = 10;
const MAX_NO_TOOL_TURNS = 3;

/** Structured per-turn logging (#21 dashboards read this). */
function logTurn(info: {
  task_id: string;
  turn: number;
  tool?: string;
  duration_ms: number;
  tokens?: number;
}): void {
  console.log(JSON.stringify({ ...info, at: Date.now() }));
}

/**
 * Build the task prompt for the task kind (fix_issue embeds the issue body
 * fetched through the GitHub App).
 */
export async function buildTaskPrompt(
  env: Env,
  task: {
    kind: string;
    prompt: string;
    github_issue?: string | null;
    repo_id: string;
  },
): Promise<string> {
  if (task.kind === 'post_merge_check') {
    const parsed = parsePostMergeTask(task.prompt);
    return postMergePrompt(parsed.files, parsed.landed_cs ?? undefined);
  }
  if (task.kind === 'fix_issue' && task.github_issue) {
    const { githubApi } = await import('../bridge/github');
    const { q1 } = await import('../db/client');
    const repoRow = await q1(env, `SELECT * FROM ${T.repos} WHERE ${C.repos.id} = ?`, [
      task.repo_id,
    ]);
    const installationId = (repoRow as { github_installation_id?: number | null })
      .github_installation_id;
    const slug = (repoRow as { slug: string }).slug;
    const [owner, name] = slug.split('/') as [string, string];
    if (installationId) {
      const res = await githubApi(
        env,
        installationId,
        `/repos/${owner}/${name}/issues/${task.github_issue}`,
      );
      if (res.ok) {
        const issue = (await res.json()) as {
          number: number;
          title: string;
          body: string | null;
        };
        return fixIssuePrompt(issue);
      }
    }
  }
  return task.prompt;
}

/**
 * After a terminal transition:
 *  - fix_issue success: land the work back to GitHub and comment the
 *    changeset id on the issue (architecture §4);
 *  - post_merge_check that reported failure: open a freeform fix task for
 *    the same repo, as the same user — unless the check verified a fix
 *    task's own land (lineage cap: one level, so fixes can't loop).
 */
export async function onTaskFinished(
  env: Env,
  task: {
    id: string;
    kind: string;
    github_issue?: string | null;
    repo_id: string;
    prompt: string;
    created_by: string;
  },
  outcome: LoopOutcome,
): Promise<void> {
  if (task.kind === 'post_merge_check') {
    if (outcome.via === 'report_failure') await openPostMergeFix(env, task, outcome);
    return;
  }
  if (task.kind !== 'fix_issue' || !task.github_issue) return;
  if (outcome.status !== 'done') return;
  const { startExportToGithub } = await import('../bridge/exportPush');
  const { githubApi } = await import('../bridge/github');
  const { q1 } = await import('../db/client');
  const repoRow = await q1(env, `SELECT * FROM ${T.repos} WHERE ${C.repos.id} = ?`, [
    task.repo_id,
  ]);
  const installationId = (repoRow as { github_installation_id?: number | null })
    .github_installation_id;
  const slug = (repoRow as { slug: string }).slug;
  const [owner, name] = slug.split('/') as [string, string];

  try {
    await startExportToGithub(env, task.repo_id, { target_branch: 'yag-sync' });
    if (installationId) {
      await githubApi(
        env,
        installationId,
        `/repos/${owner}/${name}/issues/${task.github_issue}/comments`,
        {
          method: 'POST',
          body: JSON.stringify({
            body: `Landed in ${outcome.head_cs}\n\n${outcome.summary ?? ''}`,
          }),
        },
      );
    }
  } catch (err) {
    console.error('fix_issue: post-finish sync failed', err);
  }
}

async function openPostMergeFix(
  env: Env,
  check: { id: string; repo_id: string; prompt: string; created_by: string },
  outcome: LoopOutcome,
): Promise<string | null> {
  const parsed = parsePostMergeTask(check.prompt);
  if (parsed.fromFix) {
    console.log(
      JSON.stringify({ post_merge_fix: 'skipped', check: check.id, reason: 'fix_depth' }),
    );
    return null;
  }
  const id = ulid();
  const now = Date.now();
  const { run } = await import('../db/client');
  await run(
    env,
    `INSERT INTO ${T.agentTasks}
       (${C.agentTasks.id}, ${C.agentTasks.repoId}, ${C.agentTasks.kind}, ${C.agentTasks.prompt},
        ${C.agentTasks.status}, ${C.agentTasks.baseCs}, ${C.agentTasks.agentState},
        ${C.agentTasks.createdBy}, ${C.agentTasks.createdAt}, ${C.agentTasks.updatedAt})
     VALUES (?, ?, 'freeform', ?, 'queued', ?, ?, ?, ?, ?)`,
    [
      id,
      check.repo_id,
      postMergeFixPrompt({
        id: check.id,
        landed_cs: parsed.landed_cs,
        files: parsed.files,
        findings: outcome.reason ?? '(no findings given)',
      }),
      outcome.head_cs || parsed.landed_cs,
      id,
      check.created_by,
      now,
      now,
    ],
  );
  await env.AGENT_QUEUE.send({ task_id: id });
  return id;
}

/** The think-act-observe cycle. */
export async function runAgentLoop(env: Env, session: LoopSession): Promise<LoopOutcome> {
  const prompt = await buildTaskPrompt(env, {
    kind: session.kind,
    prompt: session.prompt,
    repo_id: session.repo_id,
    github_issue: session.github_issue,
  });
  let noToolTurns = 0;

  // crash-safe resume: continue after the last persisted turn
  for (let turn = (session.state().turn ?? 0) + 1; turn <= MAX_LLM_TURNS; turn++) {
    const stopped = stopRequested(session, turn - 1);
    if (stopped) return stopped;
    const started = Date.now();
    const budgetError = charge(session.budget, 'llm');
    persist(session, { turn });
    if (budgetError) {
      return budgetExhausted(session, budgetError.kind, turn);
    }

    // Infrastructure errors (model gateway down, DO eviction mid-run) are
    // allowed to kill the run: state is already persisted, and the queue's
    // retry re-enters from it.
    const response = await chat(env, {
      messages: buildMessages({ ...session.state(), budget: session.budget }, prompt),
      tools: true,
    });

    if (response.content) {
      await session.record({ t: Date.now(), kind: 'llm', text: response.content });
    }

    if (response.tool_calls.length === 0) {
      noToolTurns++;
      if (noToolTurns >= MAX_NO_TOOL_TURNS) {
        await session.record({ t: Date.now(), kind: 'note', text: TOOL_NUDGE });
        noToolTurns = 0;
      }
      logTurn({
        task_id: session.task_id,
        turn,
        duration_ms: Date.now() - started,
        tokens: response.usage?.completion_tokens,
      });
      continue;
    }
    noToolTurns = 0;

    for (const call of response.tool_calls) {
      const stoppedMid = stopRequested(session, turn);
      if (stoppedMid) return stoppedMid;
      const toolCtx: ToolCtx = {
        repo_id: session.repo_id,
        principal: session.principal,
        base_cs: session.state().base_cs,
        head_cs: session.state().head_cs,
        budget: session.budget,
        task_id: session.task_id,
      };
      const toolStarted = Date.now();

      // CRASH-SAFE: persist state before executing the tool
      persist(session, { status: 'acting' });

      await session.record({
        t: Date.now(),
        kind: 'tool_call',
        name: call.name,
        input: call.arguments,
      });
      const result = await executeTool(env, toolCtx, call.name, call.arguments);
      persist(session, { head_cs: toolCtx.head_cs });
      await session.record({
        t: Date.now(),
        kind: 'tool_result',
        name: call.name,
        output: result,
      });
      logTurn({
        task_id: session.task_id,
        turn,
        tool: call.name,
        duration_ms: Date.now() - toolStarted,
        tokens: response.usage?.completion_tokens,
      });

      // terminal results
      if (result.terminal === 'finish') {
        return {
          status: 'done',
          via: 'finish',
          summary: result.summary as string,
          head_cs: toolCtx.head_cs,
          turns: turn,
        };
      }
      if (result.terminal === 'failure') {
        return {
          status: 'failed',
          via: 'report_failure',
          reason: result.reason as string,
          head_cs: toolCtx.head_cs,
          turns: turn,
        };
      }
      if (result.error === 'budget_exceeded') {
        return budgetExhausted(session, String(result.kind), turn);
      }
    }
  }

  return budgetExhausted(session, 'llm_turns', MAX_LLM_TURNS);
}

/** Persist the budget counters (and any state patch) into the DO state. */
function persist(session: LoopSession, patch: Partial<AgentState>): void {
  session.setState({ ...session.state(), ...patch, budget: { ...session.budget } });
}

/** Cancellation / deadline-alarm checks between turns and tool calls. */
function stopRequested(session: LoopSession, turns: number): LoopOutcome | null {
  const state = session.state();
  if (state.cancelled) {
    return {
      status: 'cancelled',
      via: 'cancelled',
      reason: 'cancelled',
      head_cs: state.head_cs,
      turns,
    };
  }
  if (state.status === 'failed' && state.error === 'timeout') {
    return {
      status: 'failed',
      via: 'timeout',
      reason: 'timeout',
      head_cs: state.head_cs,
      turns,
    };
  }
  return null;
}

/**
 * Budget exhaustion is a failure with a reason, not a success: the commits
 * stay reachable from `head_cs` (work is never lost) but nothing claims the
 * task was completed.
 */
function budgetExhausted(session: LoopSession, kind: string, turns: number): LoopOutcome {
  return {
    status: 'failed',
    via: 'budget',
    reason: `budget exhausted (${kind})`,
    summary: 'budget exhausted',
    head_cs: session.state().head_cs,
    turns,
  };
}

export type { TaskBudget };
