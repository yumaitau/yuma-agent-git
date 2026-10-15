import { Agent } from 'agents';
import type { Env } from '../env';
import { C, T } from '../db/schema';
import { q1, run } from '../db/client';
import { getChangeset } from '../core/changesets';
import { getTree } from '../core/trees';
import { POST_MERGE_MAX_TOOL_CALLS, newBudget, type TaskBudget } from './budget';
import { parsePostMergeTask } from './prompt';
import { r2 } from '../observability/phase';
import { recordAgent } from '../observability/metrics';

/**
 * Agent runtime (issue #17, architecture §4) — agents that consume and produce
 * code **entirely through RPCs, zero checkouts**. One Durable Object per task
 * (Agents SDK `Agent` over DOs); state = task, transcript, working revision.
 *
 * This issue ships the runtime with a **deterministic echo loop** placeholder
 * (N steps that read the base revision through core modules and commit
 * nothing) so the lifecycle — queue dispatch, status transitions, transcripts,
 * cancellation, deadlines, crash-safe resume — is testable before the AI loop
 * lands in #19.
 */

export interface TranscriptEntry {
  t: number;
  kind: 'tool_call' | 'tool_result' | 'llm' | 'note';
  name?: string;
  input?: unknown;
  output?: unknown;
  text?: string;
}

export interface AgentState {
  task_id: string;
  repo_id: string;
  status: 'thinking' | 'acting' | 'waiting' | 'done' | 'failed';
  base_cs: string;
  head_cs: string;
  steps: number;
  transcript: TranscriptEntry[];
  error?: string;
  cancelled?: boolean;
  attempt?: number;
  /** Entries ever recorded / already streamed to R2. */
  total?: number;
  flushed?: number;
  /** Terminal summary (AI loop finish). */
  summary?: string;
  /** AI loop budget counters — persisted so a resume never re-spends them. */
  budget?: TaskBudget;
  /** Last AI loop turn started (resume continues after it). */
  turn?: number;
}

export interface RunTaskOptions {
  /**
   * Which loop runs: 'ai' (default — the Workers AI think-act-observe cycle,
   * issue #19) or 'echo' (the deterministic #17 placeholder, used by runtime
   * lifecycle tests and for AI-less bring-up).
   */
  mode?: 'ai' | 'echo';
  /** Echo-loop step count (tests inject). */
  steps?: number;
  /** Delay between steps — gives cancellation a deterministic window. */
  stepDelayMs?: number;
  /** Wall-clock deadline; default 10 minutes. */
  deadlineMs?: number;
  /** Injected failure for the runtime-failure tests. */
  failAtStep?: number;
}

const TRANSCRIPT_RING = 200;
const FLUSH_EVERY = 20;

/**
 * One agent session per task id. All state lives in the Agent's durable state
 * plus D1 rows; the full transcript streams to R2 so the ring cap never loses
 * entries.
 */
export class YagAgent extends Agent<Env, AgentState> {
  initialState: AgentState = {
    task_id: '',
    repo_id: '',
    status: 'waiting',
    base_cs: '',
    head_cs: '',
    steps: 0,
    transcript: [],
    attempt: 0,
    total: 0,
    flushed: 0,
  };

  /** Live snapshot for the task API. */
  async getStateSnapshot(): Promise<AgentState> {
    return this.state;
  }

  /**
   * Cancel: the in-flight step/tool finishes, then the loop exits. Only a
   * queued or running task can be cancelled — terminal statuses stick.
   * `taskId` covers tasks whose DO has not run yet (empty state).
   */
  async cancel(taskId?: string): Promise<{ ok: true }> {
    const id = taskId ?? this.state.task_id;
    this.setState({ ...this.state, cancelled: true });
    await run(
      this.env,
      `UPDATE ${T.agentTasks} SET ${C.agentTasks.status} = 'cancelled', ${C.agentTasks.updatedAt} = ?
        WHERE ${C.agentTasks.id} = ? AND ${C.agentTasks.status} IN ('queued', 'running')`,
      [Date.now(), id],
    );
    return { ok: true };
  }

  /** Queue entry point — crash-safe: resumes from persisted state. */
  async runTask(taskId: string, opts: RunTaskOptions = {}): Promise<AgentState> {
    const attempt = (this.state.attempt ?? 0) + 1;
    const row = await q1(
      this.env,
      `SELECT * FROM ${T.agentTasks} WHERE ${C.agentTasks.id} = ?`,
      [taskId],
    );
    const task = row as {
      id: string;
      repo_id: string;
      base_cs: string | null;
      prompt: string;
      kind: string;
      status: string;
      created_by: string;
      github_issue?: string | null;
    } | null;
    if (!task) {
      throw new Error(`no agent task ${taskId}`);
    }

    // terminal statuses stick: a cancelled, landed or timed-out task is never
    // resurrected by a queue redelivery (an infra-failed one may retry)
    const resuming = this.state.task_id === taskId;
    const timedOut =
      resuming && this.state.status === 'failed' && this.state.error === 'timeout';
    const cancelled = resuming && this.state.cancelled === true;
    if (
      task.status === 'cancelled' ||
      task.status === 'landed' ||
      timedOut ||
      cancelled
    ) {
      return this.state;
    }

    // post-merge checks verify pre-land head → landed changeset
    let headCs = task.base_cs ?? '';
    if (task.kind === 'post_merge_check') {
      const landed = parsePostMergeTask(task.prompt).landed_cs;
      if (landed && (await getChangeset(this.env, task.repo_id, landed))) headCs = landed;
    }

    if (this.state.task_id !== taskId) {
      this.setState({
        task_id: taskId,
        repo_id: task.repo_id,
        status: 'thinking',
        base_cs: task.base_cs ?? '',
        head_cs: headCs,
        steps: 0,
        transcript: [],
        attempt,
        cancelled: false,
        total: 0,
        flushed: 0,
      });
    } else {
      // crash-safe resume / queue retry: keep transcript, steps, budget and
      // turn (attempt meta is what distinguishes the runs in the transcript)
      this.setState({ ...this.state, attempt, status: 'thinking', error: undefined });
    }

    await this.pushTranscript({
      t: Date.now(),
      kind: 'note',
      text: `attempt ${attempt}`,
    });
    await this.transition('running');

    const aiMode =
      opts.mode !== 'echo' && opts.steps === undefined && opts.failAtStep === undefined;

    // deadline: DO alarm + in-loop check (10 min default). The AI loop's
    // deadline lives in its persisted budget, so a resume keeps the original.
    const deadlineMs = opts.deadlineMs ?? 10 * 60 * 1000;
    const budget =
      this.state.budget ??
      newBudget({
        deadlineMs,
        maxToolCalls:
          task.kind === 'post_merge_check' ? POST_MERGE_MAX_TOOL_CALLS : undefined,
      });
    const deadline = aiMode ? budget.deadline : Date.now() + deadlineMs;
    await this.ctx.storage.setAlarm(deadline);

    if (aiMode) {
      // Workers AI think-act-observe loop (issue #19)
      this.setState({ ...this.state, budget });
      const { runAgentLoop, onTaskFinished } = await import('./loop');
      try {
        const outcome = await runAgentLoop(this.env, {
          task_id: taskId,
          repo_id: task.repo_id,
          prompt: task.prompt,
          kind: task.kind,
          github_issue: task.github_issue ?? null,
          // the task runs as the user who (transitively) created it
          principal: {
            kind: 'token',
            userId: task.created_by ?? taskId,
            tokenId: taskId,
            scopes: ['repo:read', 'repo:write', 'agent:run'],
            repoId: task.repo_id,
          },
          budget,
          state: () => this.state,
          setState: (next) => {
            this.setState(next);
          },
          record: (entry) => this.pushTranscript(entry),
        });
        await this.flushTranscript();
        await this.ctx.storage.deleteAlarm();
        // cancellation already wrote its own terminal status; a timeout's
        // 'failed' must not be overwritten either
        if (outcome.via === 'cancelled' || outcome.via === 'timeout') return this.state;
        this.setState({
          ...this.state,
          head_cs: outcome.head_cs,
          status: outcome.status === 'done' ? 'done' : 'failed',
          error: outcome.reason,
          summary: outcome.summary,
        });
        // 'landed' = the agent called finish (the enum's only success state)
        const moved = await this.transition(
          outcome.status === 'done' ? 'landed' : 'failed',
        );
        if (moved) {
          await onTaskFinished(
            this.env,
            {
              id: taskId,
              kind: task.kind,
              github_issue: task.github_issue ?? null,
              repo_id: task.repo_id,
              prompt: task.prompt,
              created_by: task.created_by,
            },
            outcome,
          );
        }
        return this.state;
      } catch (err) {
        // infrastructure failure (eviction, gateway): persist + rethrow — the
        // queue's retry re-enters from this state
        this.setState({
          ...this.state,
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        });
        await this.transition('failed');
        await this.flushTranscript();
        throw err;
      }
    }

    // deterministic echo loop (issue #17 placeholder / lifecycle tests)
    const steps = opts.steps ?? 1;
    try {
      for (let step = 0; step < steps; step++) {
        if (this.state.cancelled) break;
        if (Date.now() > deadline) {
          throw new Error('timeout');
        }
        if (opts.failAtStep === step + 1) {
          throw new Error(`injected failure at step ${step + 1}`);
        }

        // deterministic echo step: read the base revision, commit nothing
        const read = await this.echoRead();
        this.setState({
          ...this.state,
          steps: this.state.steps + 1,
          status: 'acting',
        });
        await this.pushTranscript({
          t: Date.now(),
          kind: 'tool_call',
          name: 'read_file',
          input: { path: read.path, cs: this.state.base_cs },
        });
        await this.pushTranscript({
          t: Date.now(),
          kind: 'tool_result',
          name: 'read_file',
          output: { entries: read.entries },
        });
        if (opts.stepDelayMs) {
          await new Promise((resolve) => setTimeout(resolve, opts.stepDelayMs));
        }
      }

      if (this.state.cancelled) {
        return this.state; // status already cancelled
      }
      this.setState({ ...this.state, status: 'done' });
      await this.transition('landed');
      await this.flushTranscript();
      await this.ctx.storage.deleteAlarm();
      return this.state;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setState({ ...this.state, status: 'failed', error: message });
      await this.transition('failed');
      await this.flushTranscript();
      await this.ctx.storage.deleteAlarm();
      throw err; // the queue consumer decides retry vs poison
    }
  }

  /**
   * Deadline alarm: fail the task if it is still running. The loop sees the
   * timeout between turns and stops; the final transition never overwrites it.
   */
  async alarm(): Promise<void> {
    const state = this.state;
    if (state.status === 'done' || state.status === 'failed' || state.cancelled) return;
    this.setState({ ...state, status: 'failed', error: 'timeout' });
    await this.transition('failed');
    await this.flushTranscript();
  }

  // -----------------------------------------------------------------------

  /** Echo placeholder step: resolve the base revision and list its root. */
  private async echoRead(): Promise<{ path: string; entries: string[] }> {
    const base = this.state.base_cs;
    const cs = base ? await getChangeset(this.env, this.state.repo_id, base) : null;
    const tree = cs?.root_tree
      ? await getTree(this.env, this.state.repo_id, cs.root_tree)
      : null;
    return {
      path: '/',
      entries: (tree?.entries ?? []).map((e) => `${e.kind} ${e.name}`),
    };
  }

  /**
   * D1 status transition. Terminal statuses stick: `running` may (re)enter
   * from queued or an infra-failed attempt, but never from landed/cancelled;
   * `landed`/`failed` only replace `running`. Returns whether the row moved.
   */
  private async transition(status: 'running' | 'landed' | 'failed'): Promise<boolean> {
    const from = status === 'running' ? `NOT IN ('landed', 'cancelled')` : `= 'running'`;
    const result = await this.env.DB.prepare(
      `UPDATE ${T.agentTasks}
          SET ${C.agentTasks.status} = ?,
              ${C.agentTasks.updatedAt} = ?,
              ${C.agentTasks.resultCs} = ?,
              ${C.agentTasks.agentState} = ?
        WHERE ${C.agentTasks.id} = ? AND ${C.agentTasks.status} ${from}`,
    )
      .bind(
        status,
        Date.now(),
        this.state.head_cs || null,
        this.ctx.id.name,
        this.state.task_id,
      )
      .run();
    const moved = (result.meta.changes ?? 0) > 0;
    if (moved) await recordAgent(this.env, status);
    return moved;
  }

  /**
   * Ring-buffer transcript (cap 200) with the full stream in R2 as jsonl —
   * flushed in 20-entry windows via an append-put (read-modify-write), so the
   * ring never rotates unflushed entries out.
   */
  private async pushTranscript(entry: TranscriptEntry): Promise<void> {
    const total = (this.state.total ?? 0) + 1;
    const transcript = [...this.state.transcript, entry].slice(-TRANSCRIPT_RING);
    this.setState({ ...this.state, transcript, total });
    if (total % FLUSH_EVERY === 0 || entry.kind === 'note') {
      await this.flushTranscript();
    }
  }

  private async flushTranscript(): Promise<void> {
    const total = this.state.total ?? 0;
    const flushed = this.state.flushed ?? 0;
    const pending = total - flushed;
    if (pending <= 0) return;
    const entries = this.state.transcript.slice(-pending);
    const key = `repos/${this.state.repo_id}/agents/${this.state.task_id}/transcript.jsonl`;
    const existing = await r2(this.env.OBJECTS).get(key);
    const prior = existing ? await existing.text() : '';
    const tail = entries.map((e) => JSON.stringify(e)).join('\n');
    await r2(this.env.OBJECTS).put(
      key,
      `${prior}${prior.length > 0 ? '\n' : ''}${tail}\n`,
    );
    this.setState({ ...this.state, flushed: total });
  }
}
