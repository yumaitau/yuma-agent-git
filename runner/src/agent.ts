import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createMasker, type Masker } from '../../worker/src/ci/mask.ts';

/**
 * Reference runner for the self-hosted runner protocol (issue #48,
 * docs/runner-protocol.md). It claims one job at a time, fetches the job's
 * commit over Git smart HTTP with the job's clone token, and runs each step
 * with bash directly on the host. Every injected secret is masked with the
 * built-in runner's masker (#50) before a log line leaves the machine. For
 * isolation, run it with `--ephemeral` inside a throwaway VM or container.
 */

export interface Job {
  id: string;
  repo: string;
  job: string | null;
  commit: string;
  clone: { url: string; token: string };
  steps: string[];
  services: { name: string; image: string; env: Record<string, string> }[];
  deadline: number;
  env: Record<string, string>;
  files: { path: string; content: string }[];
  mask: string[];
  summary: string;
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
export type JobResult = 'passed' | 'failed' | 'cancelled';

export class RunnerError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function failure(res: Response): Promise<RunnerError> {
  const body = (await res.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;
  return new RunnerError(res.status, body?.error?.message ?? `HTTP ${res.status}`);
}

/** The forge's `/runner/v1` API. 429, 5xx and network errors are retried with backoff. */
export class Client {
  readonly url: string;
  private readonly credential: string;
  private readonly send: Fetch;

  constructor(url: string, credential: string, send: Fetch = fetch) {
    this.url = url.replace(/\/+$/, '');
    this.credential = credential;
    this.send = send;
  }

  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    const send = this.send;
    for (let attempt = 1; ; attempt++) {
      let res: Response | null = null;
      try {
        res = await send(`${this.url}/runner/v1${path}`, {
          ...init,
          headers: { authorization: `Bearer ${this.credential}`, ...init.headers },
        });
      } catch (err) {
        if (attempt >= 6) throw err;
      }
      if (res && res.status !== 429 && res.status < 500) {
        if (!res.ok) throw await failure(res);
        return res;
      }
      if (res && attempt >= 6) throw await failure(res);
      const after = Number(res?.headers.get('retry-after'));
      await sleep(after > 0 ? after * 1000 : Math.min(30_000, 500 * 2 ** attempt));
    }
  }

  private json(path: string, body: unknown): Promise<Response> {
    return this.call(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  /** Long-poll for a job; null when none arrived within `wait` seconds. */
  async claim(wait: number): Promise<Job | null> {
    const res = await this.call(`/jobs/claim?wait=${wait}`, { method: 'POST' });
    if (res.status === 204) return null;
    return ((await res.json()) as { job: Job }).job;
  }

  /** Extend the lease; true when the job was cancelled. */
  async heartbeat(id: string): Promise<boolean> {
    const res = await this.call(`/jobs/${id}/heartbeat`, { method: 'POST' });
    return ((await res.json()) as { cancel: boolean }).cancel;
  }

  /** Append masked text to a step's log; true when the job was cancelled. */
  async log(id: string, step: number, text: string): Promise<boolean> {
    const res = await this.call(`/jobs/${id}/logs?step=${step}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: text,
    });
    return ((await res.json()) as { cancel: boolean }).cancel;
  }

  async step(
    id: string,
    step: number,
    body: { state: 'running' | 'passed' | 'failed' | 'skipped'; exit_code?: number },
  ): Promise<void> {
    await this.json(`/jobs/${id}/steps/${step}`, body);
  }

  async complete(id: string, result: 'passed' | 'failed'): Promise<void> {
    await this.json(`/jobs/${id}/complete`, { result });
  }
}

/** Trade a one-time registration token for this runner's credential. */
export async function register(
  url: string,
  input: {
    token: string;
    name: string;
    labels: string[];
    ephemeral: boolean;
    capabilities: Record<string, string>;
  },
  send: Fetch = fetch,
): Promise<{ id: string; credential: string }> {
  const res = await send(`${url.replace(/\/+$/, '')}/runner/v1/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await failure(res);
  const body = (await res.json()) as { runner: { id: string }; credential: string };
  return { id: body.runner.id, credential: body.credential };
}

/** Text larger than a log chunk (64 KiB) goes in pieces; 15 000 UTF-16 units fit. */
const PIECE = 15_000;

/** Ordered, batched log upload: one request at a time, flushed every `flushMs`. */
class LogStream {
  private pending: { step: number; text: string }[] = [];
  private chain: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly client: Client;
  private readonly id: string;
  private readonly flushMs: number;
  private readonly onCancel: () => void;

  constructor(client: Client, id: string, flushMs: number, onCancel: () => void) {
    this.client = client;
    this.id = id;
    this.flushMs = flushMs;
    this.onCancel = onCancel;
  }

  write(step: number, text: string): void {
    if (!text) return;
    const last = this.pending.at(-1);
    if (last?.step === step) last.text += text;
    else this.pending.push({ step, text });
    this.timer ??= setTimeout(() => void this.flush(), this.flushMs);
  }

  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    const batch = this.pending;
    this.pending = [];
    this.chain = this.chain.then(async () => {
      for (const { step, text } of batch)
        for (let i = 0; i < text.length; i += PIECE) {
          const cancel = await this.client
            .log(this.id, step, text.slice(i, i + PIECE))
            .catch((err: unknown) => {
              console.error(`Log upload failed: ${(err as Error).message}`);
              return false;
            });
          if (cancel) this.onCancel();
        }
    });
    return this.chain;
  }
}

/** Only these come from the runner's own environment; its config never reaches a step. */
const HOST_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'SHELL'];

function hostEnv(): Record<string, string> {
  return Object.fromEntries(
    HOST_ENV.flatMap((k) => (process.env[k] === undefined ? [] : [[k, process.env[k]!]])),
  );
}

export interface RunOptions {
  /** Parent of each job's temporary workspace (default: the OS temp directory). */
  workRoot?: string;
  heartbeatMs?: number;
  flushMs?: number;
}

/** Run one claimed job to completion and report it. The workspace is always removed. */
export async function runJob(
  client: Client,
  job: Job,
  opts: RunOptions = {},
): Promise<JobResult> {
  const masker: Masker = createMasker(job.mask);
  const dir = await mkdtemp(join(opts.workRoot ?? tmpdir(), 'yag-job-'));
  let current: ChildProcess | null = null;
  let stopped: 'cancelled' | 'expired' | null = null;
  const stop = (why: 'cancelled' | 'expired'): void => {
    stopped ??= why;
    // the step runs in its own process group: end everything it started
    if (current?.pid) process.kill(-current.pid, 'SIGKILL');
  };
  const log = new LogStream(client, job.id, opts.flushMs ?? 1000, () =>
    stop('cancelled'),
  );
  const beat = setInterval(() => {
    client.heartbeat(job.id).then(
      (cancel) => cancel && stop('cancelled'),
      () => {},
    );
  }, opts.heartbeatMs ?? 15_000);
  const timer = setTimeout(() => stop('expired'), Math.max(0, job.deadline - Date.now()));

  const exec = (
    cmd: string,
    args: string[],
    cwd: string,
    env: Record<string, string>,
    step: number,
  ): Promise<number> =>
    new Promise((resolve) => {
      if (stopped) return resolve(1);
      const child = spawn(cmd, args, {
        cwd,
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      current = child;
      const out = (chunk: Buffer): void => log.write(step, masker.push(chunk.toString()));
      child.stdout.on('data', out);
      child.stderr.on('data', out);
      child.on('error', () => resolve(127));
      child.on('close', (code) => {
        current = null;
        log.write(step, masker.flush());
        resolve(code ?? 1);
      });
    });

  // read through a call: TypeScript would keep `stopped` narrowed to null
  const halted = (): typeof stopped => stopped;
  const work = async (): Promise<'passed' | 'failed'> => {
    if (job.summary) log.write(0, `${job.summary}\n`);
    if (job.services.length > 0) {
      log.write(
        0,
        'This runner runs steps on the host and cannot start services. Use the built-in pool or a container runner for this job.\n',
      );
      return 'failed';
    }
    // job files (the AWS web identity token) live in the workspace, mode 0600
    const files = new Map<string, string>();
    if (job.files.length) await mkdir(join(dir, 'files'), { mode: 0o700 });
    for (const file of job.files) {
      const local = join(dir, 'files', basename(file.path));
      await writeFile(local, file.content, { mode: 0o600 });
      files.set(file.path, local);
    }
    const env = {
      ...hostEnv(),
      CI: 'true',
      YAG_JOB_ID: job.id,
      YAG_REPOSITORY: job.repo,
      YAG_COMMIT: job.commit,
      ...Object.fromEntries(
        Object.entries(job.env).map(([k, v]) => [k, files.get(v) ?? v]),
      ),
    };
    const src = join(dir, 'src');
    // the clone token travels in Git's environment, never on a command line
    const gitEnv = {
      ...hostEnv(),
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraHeader',
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`runner:${job.clone.token}`).toString('base64')}`,
    };
    log.write(0, `Fetching ${job.repo} at ${job.commit}\n`);
    for (const args of [
      ['init', '-q', src],
      ['-C', src, 'fetch', '-q', '--depth=1', job.clone.url, job.commit],
      ['-C', src, 'checkout', '-q', '--detach', 'FETCH_HEAD'],
    ]) {
      if ((await exec('git', args, dir, gitEnv, 0)) !== 0) {
        log.write(0, 'Fetching the repository failed.\n');
        return 'failed';
      }
    }
    for (const [i, command] of job.steps.entries()) {
      await client.step(job.id, i, { state: 'running' });
      log.write(i, masker.mask(`$ ${command}\n`));
      const code = await exec(
        '/bin/bash',
        ['-euo', 'pipefail', '-c', command],
        src,
        env,
        i,
      );
      if (halted()) return 'failed';
      await client.step(job.id, i, {
        state: code === 0 ? 'passed' : 'failed',
        exit_code: code,
      });
      if (code !== 0) {
        log.write(i, `\nCommand exited with status ${code}.\n`);
        for (let j = i + 1; j < job.steps.length; j++)
          await client.step(job.id, j, { state: 'skipped' });
        return 'failed';
      }
    }
    return 'passed';
  };

  let result: 'passed' | 'failed' = 'failed';
  try {
    result = await work();
  } finally {
    clearInterval(beat);
    clearTimeout(timer);
    if (halted() === 'expired') log.write(0, '\nThe job ran past its deadline.\n');
    await log.flush();
    await rm(dir, { recursive: true, force: true });
  }
  // a cancelled job is already final on the forge; an expired one ends as timed out there
  if (halted() === 'cancelled') return 'cancelled';
  await client.complete(job.id, result);
  return result;
}

/** Claim and run jobs until `once` is satisfied; throws when the credential stops working. */
export async function serve(
  client: Client,
  opts: RunOptions & { once?: boolean; say?: (line: string) => void } = {},
): Promise<void> {
  for (;;) {
    const job = await client.claim(30);
    if (!job) continue;
    opts.say?.(`Running ${job.repo} ${job.job ?? ''} (${job.id})`);
    try {
      opts.say?.(`Job ${job.id} ${await runJob(client, job, opts)}`);
    } catch (err) {
      // the forge fails the job when its lease runs out; a revoked runner stops here
      if (err instanceof RunnerError && err.status === 401) throw err;
      opts.say?.(`Job ${job.id} stopped: ${(err as Error).message}`);
    }
    if (opts.once) return;
  }
}
