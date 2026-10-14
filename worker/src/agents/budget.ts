/**
 * Per-task execution budgets (issue #18) — structural limits so one agent can
 * never run away: 50 tool calls, 20 commits, 10 LLM turns, wall-clock
 * deadline. Exceeding a budget is a **tool result** (`{error:'budget_exceeded'}`)
 * rather than an exception, so the loop can finish gracefully and land
 * whatever it already committed — work is never lost (architecture §2.3).
 */

export interface TaskBudget {
  toolCalls: number;
  maxToolCalls: number;
  commits: number;
  maxCommits: number;
  llmTurns: number;
  maxLlmTurns: number;
  deadline: number;
  /** sub-task tracking (create_task depth/fan-out guards) */
  depth: number;
  fanOut: number;
}

export const DEFAULT_BUDGET = {
  maxToolCalls: 50,
  maxCommits: 20,
  maxLlmTurns: 10,
  maxDepth: 2,
  maxFanOut: 5,
} as const;

export function newBudget(
  opts: {
    maxToolCalls?: number;
    maxCommits?: number;
    maxLlmTurns?: number;
    deadlineMs?: number;
    depth?: number;
  } = {},
  now: number = Date.now(),
): TaskBudget {
  return {
    toolCalls: 0,
    maxToolCalls: opts.maxToolCalls ?? DEFAULT_BUDGET.maxToolCalls,
    commits: 0,
    maxCommits: opts.maxCommits ?? DEFAULT_BUDGET.maxCommits,
    llmTurns: 0,
    maxLlmTurns: opts.maxLlmTurns ?? DEFAULT_BUDGET.maxLlmTurns,
    deadline: now + (opts.deadlineMs ?? 10 * 60 * 1000),
    depth: opts.depth ?? 0,
    fanOut: 0,
  };
}

export type BudgetKind = 'tool' | 'commit' | 'llm';

/** Consume one unit; null when allowed, else the error payload. */
export function charge(
  budget: TaskBudget,
  kind: BudgetKind,
  now: number = Date.now(),
): { error: 'budget_exceeded'; kind: BudgetKind; remaining: number } | null {
  if (now > budget.deadline) {
    return { error: 'budget_exceeded', kind: 'deadline', remaining: 0 } as never;
  }
  switch (kind) {
    case 'tool':
      budget.toolCalls++;
      if (budget.toolCalls > budget.maxToolCalls) {
        return { error: 'budget_exceeded', kind, remaining: 0 };
      }
      return null;
    case 'commit':
      budget.commits++;
      if (budget.commits > budget.maxCommits) {
        return { error: 'budget_exceeded', kind, remaining: 0 };
      }
      return null;
    case 'llm':
      budget.llmTurns++;
      if (budget.llmTurns > budget.maxLlmTurns) {
        return { error: 'budget_exceeded', kind, remaining: 0 };
      }
      return null;
  }
}

export function remaining(budget: TaskBudget): {
  toolCalls: number;
  commits: number;
  llmTurns: number;
} {
  return {
    toolCalls: Math.max(0, budget.maxToolCalls - budget.toolCalls),
    commits: Math.max(0, budget.maxCommits - budget.commits),
    llmTurns: Math.max(0, budget.maxLlmTurns - budget.llmTurns),
  };
}
