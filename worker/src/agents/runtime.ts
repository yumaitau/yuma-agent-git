import { Agent } from 'agents';
import type { Env } from '../env';
import { C, T } from '../db/schema';
import { q1, run } from '../db/client';
import { getChangeset } from '../core/changesets';
import { getTree } from '../core/trees';
import { newBudget } from './budget';

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

  /** Cancel: the in-flight step finishes, then the loop exits. */
  async cancel(): Promise<{ ok: true }> {
    this.setState({ ...this.state, cancelled: true });
    await run(
      this.env,
      `UPDATE ${T.agentTasks} SET ${C.agentTasks.status} = 'cancelled', ${C.agentTasks.updatedAt} = ? WHERE ${C.agentTasks.id} = ?`,
      [Date.now(), this.state.task_id],
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
    } | null;
    if (!task) {
      throw new Error(`no agent task ${taskId}`);
    }

    if (this.state.task_id !== taskId) {
      this.setState({
        task_id: taskId,
        repo_id: task.repo_id,
        status: 'thinking',
        base_cs: task.base_cs ?? '',
        head_cs: task.base_cs ?? '',
        steps: 0,
        transcript: [],
        attempt,
        cancelled: false,
        total: 0,
        flushed: 0,
      });
    } else {
      // crash-safe resume / queue retry: keep transcript + steps (attempt meta
      // is what distinguishes the runs in the transcript)
      this.setState({ ...this.state, attempt, cancelled: false, status: 'thinking' });
    }

    await this.pushTranscript({
      t: Date.now(),
      kind: 'note',
      text: `attempt ${attempt}`,
    });
    await this.transition('running');

    // deadline: DO alarm + in-loop check (10 min default)
    const deadlineMs = opts.deadlineMs ?? 10 * 60 * 1000;
    await this.ctx.storage.setAlarm(Date.now() + deadlineMs);
    const deadline = Date.now() + deadlineMs;

    if (
      opts.mode !== 'echo' &&
      opts.steps === undefined &&
      opts.failAtStep === undefined
    ) {
      // Workers AI think-act-observe loop (issue #19)
      const { runAgentLoop, onTaskFinished } = await import('./loop');
      try {
        const outcome = await runAgentLoop(this.env, {
          task_id: taskId,
          repo_id: task.repo_id,
          prompt: task.prompt,
          kind: (row as { kind: string }).kind,
          github_issue: (row as { github_issue?: string | null }).github_issue ?? null,
          principal: {
            kind: 'token',
            userId: (row as { created_by: string }).created_by ?? taskId,
            tokenId: taskId,
            scopes: ['repo:read', 'repo:write', 'agent:run'],
            repoId: task.repo_id,
          },
          budget: newBudget({ deadlineMs }),
          state: () => this.state,
          setState: (next) => {
            this.setState(next);
          },
          record: (entry) => this.pushTranscript(entry),
        });
        this.setState({
          ...this.state,
          head_cs: outcome.head_cs,
          status: outcome.status === 'done' ? 'done' : 'failed',
          error: outcome.reason,
          summary: outcome.summary,
        });
        await this.transition(outcome.status === 'done' ? 'landed' : 'failed');
        await this.flushTranscript();
        await this.ctx.storage.deleteAlarm();
        await onTaskFinished(
          this.env,
          {
            kind: (row as { kind: string }).kind,
            github_issue: (row as { github_issue?: string | null }).github_issue ?? null,
            repo_id: task.repo_id,
          },
          outcome,
        );
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

  /** Deadline alarm: fail the task if it is still running. */
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

  private async transition(status: 'running' | 'landed' | 'failed'): Promise<void> {
    await run(
      this.env,
      `UPDATE ${T.agentTasks}
          SET ${C.agentTasks.status} = ?,
              ${C.agentTasks.updatedAt} = ?,
              ${C.agentTasks.resultCs} = ?,
              ${C.agentTasks.agentState} = ?
        WHERE ${C.agentTasks.id} = ?`,
      [
        status,
        Date.now(),
        this.state.head_cs || null,
        this.ctx.id.name,
        this.state.task_id,
      ],
    );
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
    const existing = await this.env.OBJECTS.get(key);
    const prior = existing ? await existing.text() : '';
    const tail = entries.map((e) => JSON.stringify(e)).join('\n');
    await this.env.OBJECTS.put(key, `${prior}${prior.length > 0 ? '\n' : ''}${tail}\n`);
    this.setState({ ...this.state, flushed: total });
  }
}
