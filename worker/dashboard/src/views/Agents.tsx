import { useCallback, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  AGENT_KINDS,
  api,
  asApiError,
  type AgentIdentity,
  type AgentState,
  type AgentTask,
  type ApiError,
  type TaskKind,
  type TranscriptEntry,
} from '../api';
import { usePolling, useSincePolling } from '../hooks';
import { useSlug } from '../slug';
import { useToast } from '../toast';
import {
  Empty,
  ErrorNotice,
  Field,
  Loading,
  StatusChip,
  formatRelative,
  formatTime,
  shortId,
} from '../ui';

const TERMINAL = new Set(['landed', 'failed', 'cancelled']);

const TASK_KINDS: TaskKind[] = ['freeform', 'fix_issue', 'post_merge_check', 'superfan'];

function NewTaskForm({
  onCreated,
}: {
  onCreated: (taskId: string) => void;
}): ReactElement {
  const slug = useSlug();
  const toast = useToast();
  const [kind, setKind] = useState<TaskKind>('freeform');
  const [prompt, setPrompt] = useState('');
  const [baseCs, setBaseCs] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const started = await api.createTask(slug, {
        kind,
        prompt: prompt.trim(),
        base_cs: baseCs.trim() === '' ? undefined : baseCs.trim(),
      });
      toast.show(`task ${started.task_id} queued`);
      setPrompt('');
      onCreated(started.task_id);
    } catch (err) {
      setError(asApiError(err));
    } finally {
      setBusy(false);
    }
  }, [slug, kind, prompt, baseCs, toast, onCreated]);

  return (
    <div className="panel">
      <h3>New task</h3>
      {error && <ErrorNotice error={error} />}
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Kind">
          <select value={kind} onChange={(e) => setKind(e.target.value as TaskKind)}>
            {TASK_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Prompt">
          <textarea
            placeholder="What should the agent do?"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </Field>
        <Field label="Base revision (optional — defaults to ref:main)">
          <input type="text" value={baseCs} onChange={(e) => setBaseCs(e.target.value)} />
        </Field>
        <button type="submit" className="primary" disabled={busy || prompt.trim() === ''}>
          Queue task
        </button>
      </form>
    </div>
  );
}

/**
 * Agent identities (#57): agents act for a person through short-lived tokens
 * from `POST /oauth/token`. Disabling one is the kill switch: its live tokens
 * stop working on the next request.
 */
export function AgentIdentities(): ReactElement {
  const toast = useToast();
  const {
    data: agents,
    error,
    refresh,
  } = usePolling<AgentIdentity[]>(() => api.listAgents(), 15000);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<AgentIdentity['kind']>('claude_code');
  const [busy, setBusy] = useState(false);

  const act = useCallback(
    async (work: () => Promise<unknown>, done: string) => {
      setBusy(true);
      try {
        await work();
        toast.show(done);
        refresh();
      } catch (err) {
        toast.showError(err);
      } finally {
        setBusy(false);
      }
    },
    [toast, refresh],
  );

  return (
    <div className="panel">
      <h3>Agent identities</h3>
      <p className="small muted">
        Agents act for you with tokens that last minutes, bound to named repos. Disabling
        an agent revokes its live tokens at once.
      </p>
      {error && <ErrorNotice error={error} />}
      {agents && agents.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Kind</th>
              <th>Scopes</th>
              <th>Live tokens</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {agents.map((agent) => (
              <tr key={agent.id}>
                <td>
                  {agent.name} <span className="mono small faint">{agent.id}</span>
                </td>
                <td className="small">{agent.kind}</td>
                <td className="small">{agent.max_scopes.join(' ')}</td>
                <td className="small">{agent.live_tokens ?? 0}</td>
                <td>
                  <StatusChip status={agent.disabled ? 'disabled' : 'active'} />
                </td>
                <td>
                  <button
                    className={agent.disabled ? undefined : 'danger'}
                    disabled={busy}
                    onClick={() =>
                      void act(
                        () => api.setAgentDisabled(agent.id, !agent.disabled),
                        agent.disabled
                          ? `${agent.name} enabled`
                          : `${agent.name} disabled`,
                      )
                    }
                  >
                    {agent.disabled ? 'Enable' : 'Disable'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        agents && <Empty>No agent identities yet.</Empty>
      )}
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void act(async () => {
            await api.createAgent({ name: name.trim(), kind });
            setName('');
          }, 'agent added');
        }}
      >
        <input
          type="text"
          aria-label="Agent name"
          placeholder="Agent name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <select
          aria-label="Agent kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as AgentIdentity['kind'])}
        >
          {AGENT_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <button type="submit" disabled={busy || name.trim() === ''}>
          Add agent
        </button>
      </form>
    </div>
  );
}

export function AgentsView(): ReactElement {
  const slug = useSlug();
  const navigate = useNavigate();
  const [status, setStatus] = useState('');
  const {
    data: tasks,
    error,
    loading,
    refresh,
  } = usePolling<AgentTask[]>(
    () => api.listTasks(slug, { status: status === '' ? undefined : status, limit: 50 }),
    5000,
  );

  return (
    <div>
      <div className="row between">
        <h1 style={{ margin: 0 }}>Agent tasks</h1>
        <div className="row">
          <Link className="btn" to={`/r/${slug}`}>
            ← repo
          </Link>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">all statuses</option>
            {['queued', 'running', 'landed', 'failed', 'cancelled'].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <button onClick={refresh}>Refresh</button>
        </div>
      </div>

      {error && <ErrorNotice error={error} />}
      {loading && !tasks ? (
        <Loading label="Loading tasks…" />
      ) : tasks && tasks.length > 0 ? (
        <div className="panel tight">
          <table>
            <thead>
              <tr>
                <th>Status</th>
                <th>Kind</th>
                <th>Prompt</th>
                <th>Base</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => (
                <tr key={task.id} className="clickable">
                  <td>
                    <StatusChip status={task.status} />
                  </td>
                  <td className="small">{task.kind}</td>
                  <td className="wrap-any">
                    <Link to={`/r/${slug}/agents/${task.id}`}>
                      {task.prompt.split('\n')[0].slice(0, 90)}
                    </Link>
                  </td>
                  <td className="mono small muted">{shortId(task.base_cs)}</td>
                  <td className="small muted">{formatRelative(task.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>No agent tasks yet.</Empty>
      )}

      <NewTaskForm onCreated={(id) => navigate(`/r/${slug}/agents/${id}`)} />
      <AgentIdentities />
    </div>
  );
}

function TranscriptRow({ entry }: { entry: TranscriptEntry }): ReactElement {
  return (
    <div className="transcript-entry">
      <div className="row small">
        <span className="chip">{entry.kind}</span>
        {entry.name && <code>{entry.name}</code>}
        <span className="faint">{formatTime(entry.t)}</span>
      </div>
      {entry.text && <pre className="code">{entry.text}</pre>}
      {entry.input !== undefined && entry.input !== null && (
        <pre className="code">{JSON.stringify(entry.input, null, 2)}</pre>
      )}
      {entry.output !== undefined && entry.output !== null && (
        <pre className="code">{JSON.stringify(entry.output, null, 2)}</pre>
      )}
    </div>
  );
}

export function TaskDetailView(): ReactElement {
  const slug = useSlug();
  const { taskId = '' } = useParams();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const { data, error, refresh } = usePolling<{ task: AgentTask; state: AgentState }>(
    () => api.getTask(taskId),
    2000,
    true,
    { stopWhen: (d) => TERMINAL.has(d.task.status) },
  );
  const terminal = data ? TERMINAL.has(data.task.status) : false;

  const fetchTranscript = useMemo(
    () => (since: number) => api.getTranscript(taskId, since),
    [taskId],
  );
  const transcript = useSincePolling<TranscriptEntry>(
    fetchTranscript,
    (e) => e.t,
    (e) =>
      `${e.t}:${e.kind}:${e.name ?? ''}:${JSON.stringify(e.input ?? null)}:${JSON.stringify(e.output ?? null)}:${e.text ?? ''}`,
    2000,
    true,
  );

  const cancel = useCallback(async () => {
    setBusy(true);
    try {
      await api.cancelTask(taskId);
      toast.show('cancel requested');
      refresh();
    } catch (err) {
      toast.showError(err);
    } finally {
      setBusy(false);
    }
  }, [taskId, toast, refresh]);

  if (error) return <ErrorNotice error={error} />;
  if (!data) return <Loading label="Loading task…" />;

  const { task, state } = data;

  return (
    <div>
      <div className="small muted">
        <Link to={`/r/${slug}/agents`}>agent tasks</Link> /{' '}
        <span className="mono">{taskId}</span>
      </div>
      <div className="row between">
        <h1 style={{ margin: '4px 0' }}>{task.kind} task</h1>
        <div className="row">
          <StatusChip status={task.status} />
          <StatusChip status={state.status} />
          {!terminal && (
            <button className="danger" disabled={busy} onClick={() => void cancel()}>
              Cancel
            </button>
          )}
          <button onClick={refresh}>Refresh</button>
        </div>
      </div>

      <div className="panel">
        <div className="kv">
          <span className="k">Prompt</span>
          <span className="wrap-any">{task.prompt}</span>
          <span className="k">Base cs</span>
          <span className="mono">
            <Link to={`/r/${slug}/cs/${task.base_cs ?? ''}`}>
              {shortId(task.base_cs)}
            </Link>
          </span>
          <span className="k">Head cs</span>
          <span className="mono">
            {state.head_cs ? (
              <Link to={`/r/${slug}/cs/${state.head_cs}`}>{shortId(state.head_cs)}</Link>
            ) : (
              '—'
            )}
          </span>
          <span className="k">Steps</span>
          <span>{state.steps ?? 0}</span>
          <span className="k">Created</span>
          <span>{formatTime(task.created_at)}</span>
          {state.summary && (
            <>
              <span className="k">Summary</span>
              <span className="wrap-any">{state.summary}</span>
            </>
          )}
          {state.error && (
            <>
              <span className="k">Error</span>
              <span className="wrap-any">{state.error}</span>
            </>
          )}
        </div>
      </div>

      <h2>Transcript ({transcript.entries.length})</h2>
      {transcript.error && <ErrorNotice error={transcript.error} />}
      {transcript.loading && transcript.entries.length === 0 ? (
        <Loading label="Streaming transcript…" />
      ) : transcript.entries.length === 0 ? (
        <Empty>No transcript entries yet.</Empty>
      ) : (
        <div className="panel">
          {transcript.entries.map((entry, i) => (
            <TranscriptRow key={`${i}:${entry.t}:${entry.kind}`} entry={entry} />
          ))}
          {!terminal && <div className="small faint">live — polling every 2s…</div>}
        </div>
      )}
    </div>
  );
}
