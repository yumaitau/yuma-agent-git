import type { Env } from '../env';
import { C, T } from '../db/schema';
import { chat, buildMessages } from './llm';
import { executeTool, type ToolCtx } from './tools';
import { charge, type TaskBudget } from './budget';
import { TOOL_NUDGE, fixIssuePrompt, postMergePrompt } from './prompt';
import type { AgentState, TranscriptEntry } from './runtime';
import type { Principal } from '../auth/principal';

/**
 * Think → act → observe (issue #19) — the loop that turns a prompt into landed
 * changesets. Crash-safe by construction: state is persisted **before** tools
 * execute, so a DO eviction resumes mid-plan instead of double-committing.
 *
 * Terminal conditions: `finish` / `report_failure` tool results, budget
 * exhaustion (auto-finish — committed work is never lost), deadline, and the
 * turn cap (10 LLM turns → auto-finish).
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
  status: 'done' | 'failed';
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
    const files = task.prompt
      .replace(/^verify these changes:?\s*/i, '')
      .split(',')
      .filter(Boolean);
    return postMergePrompt(files);
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
 * On terminal success of a fix_issue task: land the work back to GitHub and
 * comment the changeset id on the issue (architecture §4).
 */
export async function onTaskFinished(
  env: Env,
  task: { kind: string; github_issue?: string | null; repo_id: string },
  outcome: LoopOutcome,
): Promise<void> {
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

/** The think-act-observe cycle. */
export async function runAgentLoop(env: Env, session: LoopSession): Promise<LoopOutcome> {
  const prompt = await buildTaskPrompt(env, {
    kind: session.kind,
    prompt: session.prompt,
    repo_id: session.repo_id,
    github_issue: session.github_issue,
  });
  let noToolTurns = 0;

  for (let turn = 1; turn <= MAX_LLM_TURNS; turn++) {
    const started = Date.now();
    const budgetError = charge(session.budget, 'llm');
    if (budgetError) {
      return finishGracefully(session, 'budget exhausted', turn);
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
      session.setState({ ...session.state(), status: 'acting' });

      await session.record({
        t: Date.now(),
        kind: 'tool_call',
        name: call.name,
        input: call.arguments,
      });
      const result = await executeTool(env, toolCtx, call.name, call.arguments);
      if (toolCtx.head_cs !== session.state().head_cs) {
        session.setState({ ...session.state(), head_cs: toolCtx.head_cs });
      }
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
          summary: result.summary as string,
          head_cs: toolCtx.head_cs,
          turns: turn,
        };
      }
      if (result.terminal === 'failure') {
        return {
          status: 'failed',
          reason: result.reason as string,
          head_cs: toolCtx.head_cs,
          turns: turn,
        };
      }
      if (result.error === 'budget_exceeded') {
        return finishGracefully(session, 'budget exhausted', turn);
      }
    }
  }

  return finishGracefully(session, 'budget exhausted', MAX_LLM_TURNS);
}

function finishGracefully(
  session: LoopSession,
  summary: string,
  turns: number,
): LoopOutcome {
  return { status: 'done', summary, head_cs: session.state().head_cs, turns };
}

export type { TaskBudget };
