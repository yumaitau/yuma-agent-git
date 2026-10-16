import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, runJob, type Job } from '../src/agent.ts';

/**
 * The reference runner against an in-memory forge: real bash steps and a real
 * `git fetch` of a local repository, fake HTTP. The forge side of the protocol
 * is covered by worker/test/ci-runners.test.ts.
 */

const SECRET = 'hunter2-very-secret';
let root = '';
let origin = '';
let commit = '';

function git(cwd: string, ...args: string[]): string {
  const res = spawnSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args],
    {
      cwd,
      encoding: 'utf8',
    },
  );
  if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

interface Forge {
  client: Client;
  logs: Map<number, string>;
  steps: { step: number; state: string; exit_code?: number }[];
  completed: string[];
  cancel: boolean;
}

function forge(): Forge {
  const f: Forge = {
    client: null as unknown as Client,
    logs: new Map(),
    steps: [],
    completed: [],
    cancel: false,
  };
  f.client = new Client('https://forge.test/', 'yagrun_test', async (url, init) => {
    const path = new URL(url).pathname;
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer yagrun_test');
    const body = typeof init?.body === 'string' ? init.body : '';
    if (path.endsWith('/logs')) {
      const step = Number(new URL(url).searchParams.get('step'));
      f.logs.set(step, (f.logs.get(step) ?? '') + body);
      return Response.json({ cancel: f.cancel });
    }
    if (path.endsWith('/heartbeat')) return Response.json({ cancel: f.cancel });
    if (/\/steps\/\d+$/.test(path)) {
      f.steps.push({ step: Number(path.split('/').pop()), ...JSON.parse(body) });
      return Response.json({ cancel: false });
    }
    if (path.endsWith('/complete')) {
      f.completed.push((JSON.parse(body) as { result: string }).result);
      return Response.json({ state: 'done' });
    }
    return new Response('not found', { status: 404 });
  });
  return f;
}

function job(over: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    repo: 'yuma/app',
    job: 'build',
    commit,
    clone: { url: origin, token: 'yagclone_abc' },
    steps: [],
    services: [],
    deadline: Date.now() + 60_000,
    env: {},
    files: [],
    mask: [],
    summary: '',
    ...over,
  };
}

const opts = (): { workRoot: string; flushMs: number; heartbeatMs: number } => ({
  workRoot: root,
  flushMs: 20,
  heartbeatMs: 50,
});

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'yag-runner-test-'));
  origin = join(root, 'origin');
  git(root, 'init', '-q', origin);
  await writeFile(join(origin, 'hello.txt'), 'hello from the repo\n');
  git(origin, 'add', 'hello.txt');
  git(origin, 'commit', '-q', '-m', 'first');
  commit = git(origin, 'rev-parse', 'HEAD');
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('reference runner', () => {
  it('fetches the commit, runs steps with injected secrets masked and passes', async () => {
    const f = forge();
    const result = await runJob(
      f.client,
      job({
        steps: [
          'cat hello.txt',
          'echo "token=$DEPLOY_TOKEN" && echo "$DEPLOY_TOKEN" | base64',
          'cat "$AWS_WEB_IDENTITY_TOKEN_FILE" && stat -c %a "$AWS_WEB_IDENTITY_TOKEN_FILE" 2>/dev/null || stat -f %Lp "$AWS_WEB_IDENTITY_TOKEN_FILE"',
          'test -z "${YAG_RUNNER_CREDENTIAL:-}" && echo "$CI $YAG_COMMIT"',
        ],
        env: {
          DEPLOY_TOKEN: SECRET,
          AWS_WEB_IDENTITY_TOKEN_FILE: '/run/yag/aws-web-identity-token',
        },
        files: [{ path: '/run/yag/aws-web-identity-token', content: 'oidc-jwt-value' }],
        mask: [SECRET, 'oidc-jwt-value', 'yagclone_abc'],
        summary: 'Job access: secrets DEPLOY_TOKEN.',
      }),
      opts(),
    );
    expect(result).toBe('passed');
    expect(f.completed).toEqual(['passed']);
    const all = [...f.logs.values()].join('');
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain(Buffer.from(`${SECRET}\n`).toString('base64').slice(0, 20));
    expect(all).not.toContain('oidc-jwt-value');
    expect(f.logs.get(0)).toContain('Job access: secrets DEPLOY_TOKEN.');
    expect(f.logs.get(0)).toContain('hello from the repo');
    expect(f.logs.get(1)).toContain('token=***');
    expect(f.logs.get(2)).toContain('***');
    expect(f.logs.get(2)).toContain('600');
    expect(f.logs.get(3)).toContain(`true ${commit}`);
    expect(f.steps.filter((s) => s.state !== 'running')).toEqual([
      { step: 0, state: 'passed', exit_code: 0 },
      { step: 1, state: 'passed', exit_code: 0 },
      { step: 2, state: 'passed', exit_code: 0 },
      { step: 3, state: 'passed', exit_code: 0 },
    ]);
    // the workspace, with the token file, is gone
    expect(await readdir(root)).toEqual(['origin']);
  });

  it('stops at a failing step and skips the rest', async () => {
    const f = forge();
    const result = await runJob(
      f.client,
      job({ steps: ['echo before', 'exit 3', 'echo never'] }),
      opts(),
    );
    expect(result).toBe('failed');
    expect(f.completed).toEqual(['failed']);
    expect(f.steps.filter((s) => s.state !== 'running')).toEqual([
      { step: 0, state: 'passed', exit_code: 0 },
      { step: 1, state: 'failed', exit_code: 3 },
      { step: 2, state: 'skipped' },
    ]);
    expect(f.logs.get(1)).toContain('Command exited with status 3.');
    expect(f.logs.get(2)).toBeUndefined();
  });

  it('kills the step when the forge cancels the job', async () => {
    const f = forge();
    const started = Date.now();
    const running = runJob(f.client, job({ steps: ['echo go; sleep 30'] }), opts());
    setTimeout(() => {
      f.cancel = true;
    }, 300);
    expect(await running).toBe('cancelled');
    expect(Date.now() - started).toBeLessThan(10_000);
    // a cancelled job is already final on the forge
    expect(f.completed).toEqual([]);
  });

  it('fails when the commit cannot be fetched or the job needs services', async () => {
    const f = forge();
    expect(
      await runJob(f.client, job({ commit: 'f'.repeat(40), steps: ['true'] }), opts()),
    ).toBe('failed');
    expect(f.logs.get(0)).toContain('Fetching the repository failed.');
    const g = forge();
    const services = [{ name: 'db', image: 'postgres:16', env: {} }];
    expect(await runJob(g.client, job({ services, steps: ['true'] }), opts())).toBe(
      'failed',
    );
    expect(g.logs.get(0)).toContain('cannot start services');
    expect(g.completed).toEqual(['failed']);
  });
});
