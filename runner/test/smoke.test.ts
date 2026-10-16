import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * End-to-end smoke (issue #48): the worker under `wrangler dev` with a
 * throwaway local D1/R2 store, a stock `git push` of a pipeline that asks for
 * `runs-on: linux`, then this runner's CLI registering with a one-time token,
 * fetching the commit over Git smart HTTP, running the steps and reporting.
 * Needs git and a local workerd, so it runs in CI or with YAG_GIT_SMOKE=1.
 */

const hasGit = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
const enabled = Boolean((process.env.CI || process.env.YAG_GIT_SMOKE) && hasGit);

const runnerDir = resolve(import.meta.dirname, '..');
const workerDir = resolve(runnerDir, '../worker');
const port = 19_700 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
const apiToken = `yag_${randomBytes(20).toString('hex')}`;
const registration = `yagreg_${randomBytes(24).toString('hex')}`;
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

let dir = '';
let server: ChildProcess | null = null;
let env: NodeJS.ProcessEnv = {};

function run(cmd: string, args: string[], cwd: string, extra: NodeJS.ProcessEnv = {}) {
  const res = spawnSync(cmd, args, {
    cwd,
    env: { ...env, ...extra },
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { code: res.status ?? -1, out: `${res.stdout}${res.stderr}` };
}

function git(cwd: string, ...args: string[]): void {
  const res = run('git', ['-c', 'protocol.version=2', ...args], cwd);
  if (res.code !== 0) throw new Error(`git ${args.join(' ')} failed:\n${res.out}`);
}

function wrangler(args: string[]): void {
  const res = spawnSync('npx', ['wrangler', ...args], {
    cwd: workerDir,
    env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' },
    encoding: 'utf8',
  });
  if (res.status !== 0) throw new Error(`wrangler ${args[0]} failed:\n${res.stderr}`);
}

function cli(args: string[], extra: NodeJS.ProcessEnv = {}) {
  return run(
    process.execPath,
    [
      '--experimental-strip-types',
      '--disable-warning=ExperimentalWarning',
      'src/main.ts',
      ...args,
      '--config',
      join(dir, 'runner.json'),
    ],
    runnerDir,
    extra,
  );
}

async function api<T>(path: string): Promise<T> {
  const res = await fetch(`${base}/api/v1${path}`, {
    headers: { authorization: `Bearer ${apiToken}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

describe.runIf(enabled)('reference runner against wrangler dev (smoke)', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'yag-runner-smoke-'));
    const persist = join(dir, 'state');
    await mkdir(join(dir, 'home'));
    env = {
      PATH: process.env.PATH,
      HOME: join(dir, 'home'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'Ada',
      GIT_AUTHOR_EMAIL: 'ada@example.com',
      GIT_COMMITTER_NAME: 'Ada',
      GIT_COMMITTER_EMAIL: 'ada@example.com',
    };
    wrangler(['d1', 'migrations', 'apply', 'yag-db', '--local', '--persist-to', persist]);
    wrangler([
      'd1',
      'execute',
      'yag-db',
      '--local',
      '--persist-to',
      persist,
      '--command',
      `INSERT INTO users (id, login, created_at) VALUES ('u1', 'ada', 1);
       INSERT INTO api_tokens (id, token_hash, repo_id, user_id, label, scopes, created_at)
         VALUES ('t1', '${sha256(apiToken)}', NULL, 'u1', 'smoke', '["repo:read","repo:write"]', 1);
       INSERT INTO repos (id, slug, default_branch, created_at, visibility, created_by, refs_mode, owner_kind, owner_id)
         VALUES ('r1', 'ada/smoke', 'main', 1, 'private', 'u1', 'git', 'user', 'ada');
       INSERT INTO runner_registration_tokens (token_hash, scope, owner_id, trusted_only, created_by, created_at, expires_at)
         VALUES ('${sha256(registration)}', 'repo', 'r1', 1, 'u1', 1, 99999999999999);`,
    ]);
    server = spawn(
      'npx',
      [
        'wrangler',
        'dev',
        '--local',
        '--ip',
        '127.0.0.1',
        '--port',
        String(port),
        '--persist-to',
        persist,
        '--var',
        'CI_ENABLED:true',
        '--show-interactive-dev-session=false',
      ],
      {
        cwd: workerDir,
        env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
        detached: true,
        stdio: 'ignore',
      },
    );
    for (let i = 0; i < 120; i++) {
      if (
        await fetch(`${base}/healthz`).then(
          (r) => r.ok,
          () => false,
        )
      )
        return;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('wrangler dev did not start');
  }, 180_000);

  afterAll(async () => {
    if (server?.pid) process.kill(-server.pid, 'SIGTERM');
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('registers, runs a linux job from a push and reports success', async () => {
    const src = join(dir, 'src');
    git(dir, 'init', '-q', '-b', 'main', src);
    await mkdir(join(src, '.yuma/pipelines'), { recursive: true });
    await writeFile(join(src, 'README.md'), 'hello from the smoke repo\n');
    await writeFile(
      join(src, '.yuma/pipelines/ci.yml'),
      'on: [push]\njobs:\n  build:\n    runs-on: [linux]\n    steps:\n      - run: cat README.md\n      - run: echo "built on $(uname -s)"\n',
    );
    git(src, 'add', '.');
    git(src, 'commit', '-q', '-m', 'pipeline');
    git(
      src,
      'push',
      '-q',
      `http://git:${apiToken}@127.0.0.1:${port}/ada/smoke.git`,
      'main',
    );

    const registered = cli(
      ['register', '--url', base, '--name', 'smoke', '--labels', 'linux', '--ephemeral'],
      { YAG_RUNNER_TOKEN: registration },
    );
    expect(registered.code, registered.out).toBe(0);
    const ran = cli(['run']);
    expect(ran.code, ran.out).toBe(0);

    const { runs } = await api<{
      runs: { jobs: { key: string; state: string; run_id: string }[] }[];
    }>('/repos/ada/smoke/ci/pipelines');
    const job = runs[0]!.jobs[0]!;
    expect(job).toMatchObject({ key: 'build', state: 'passed' });
    const log = await fetch(`${base}/api/v1/repos/ada/smoke/ci/runs/${job.run_id}/log`, {
      headers: { authorization: `Bearer ${apiToken}` },
    }).then((r) => r.text());
    expect(log).toContain('hello from the smoke repo');
    expect(log).toContain('built on ');

    // ephemeral: the forge deregistered the runner after its one job
    const again = cli(['run']);
    expect(again.code).toBe(1);
    expect(again.out).toContain('no longer accepts this runner credential');
  }, 180_000);
});
