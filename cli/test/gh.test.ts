import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerGhCommands } from '../src/commands/index';
import { apiPath, fieldsOf } from '../src/commands/api';
import { parseCredentialInput } from '../src/commands/auth';
import {
  defaultStore,
  fileStore,
  macKeychain,
  secretTool,
  type CredentialStore,
} from '../src/credentials';
import { parseRemote, runGit, type Deps } from '../src/forge';

const hasGit = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
const gitEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Ada',
  GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_COMMITTER_NAME: 'Ada',
  GIT_COMMITTER_EMAIL: 'ada@example.com',
};
function git(cwd: string, ...args: string[]): string {
  const res = spawnSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

interface Call {
  method: string;
  path: string;
  auth: string | null;
  body: unknown;
}
type Route = (call: Call) => Response | undefined;

const user = { login: 'ada' };
const side = (ref: string, sha: string, changeset: string) => ({ ref, sha, changeset });
const pull = (n: number, sha = 'a'.repeat(40)) => ({
  number: n,
  title: `Pull ${n}`,
  body: 'Adds things',
  state: 'open',
  draft: false,
  merged: false,
  user,
  head: side(`pull/${n}/head`, sha, 'c'.repeat(64)),
  base: side('main', 'b'.repeat(40), 'd'.repeat(64)),
  html_url: `https://forge.test/r/team/app/pulls/${n}`,
});
const issue = (n: number, state = 'open') => ({
  number: n,
  title: `Issue ${n}`,
  body: 'Steps',
  state,
  state_reason: state === 'closed' ? 'not_planned' : null,
  user,
  labels: [{ name: 'bug' }],
  assignees: [],
  html_url: `https://forge.test/r/team/app/issues/${n}`,
  comments: 0,
});

let dir: string;
let calls: Call[];
let out: string[];
let errs: string[];
let exitCode: number | undefined;
let store: CredentialStore;
let routes: Route[];
let stdin: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'yag-gh-'));
  calls = [];
  out = [];
  errs = [];
  exitCode = undefined;
  store = fileStore(join(dir, 'config', 'hosts.json'));
  routes = [];
  stdin = '';
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function deps(env: NodeJS.ProcessEnv = { YAG_API: 'https://forge.test' }): Deps {
  return {
    fetch: async (input) => {
      const req = input as Request;
      const url = new URL(req.url);
      const text = await req.text();
      const call = {
        method: req.method,
        path: `${url.pathname}${url.search}`,
        auth: req.headers.get('authorization'),
        body: text ? (JSON.parse(text) as unknown) : undefined,
      };
      calls.push(call);
      for (const route of routes) {
        const res = route(call);
        if (res) return res;
      }
      return Response.json(
        { error: { code: 'not_found', message: 'no route' } },
        { status: 404 },
      );
    },
    out: (line) => out.push(line),
    err: (line) => errs.push(line),
    cwd: dir,
    env,
    git: (args, cwd) => runGit(args, cwd),
    store: async () => store,
    stdin: async () => stdin,
    exit: (code) => {
      exitCode = code;
    },
  };
}

async function yag(args: string[], d: Deps = deps()): Promise<void> {
  const program = new Command().exitOverride();
  registerGhCommands(program, d);
  await program.parseAsync(['node', 'yag', ...args]);
}

const on =
  (method: string, path: string | RegExp, body: unknown, status = 200): Route =>
  (call) =>
    call.method === method &&
    (typeof path === 'string' ? call.path === path : path.test(call.path))
      ? Response.json(body, { status })
      : undefined;

const R = '/api/github/v3/repos/team/app';

describe('repository and token resolution', () => {
  it('parses forge remotes and leaves other remotes alone', () => {
    expect(parseRemote('https://forge.test/team/app.git')).toEqual({
      api: 'https://forge.test',
      repo: 'team/app',
    });
    expect(parseRemote('http://localhost:8787/team/app')).toEqual({
      api: 'http://localhost:8787',
      repo: 'team/app',
    });
    expect(parseRemote('git@github.com:team/app.git')).toBeNull();
    expect(parseRemote('/srv/git/app.git')).toBeNull();
  });

  it.skipIf(!hasGit)(
    'finds the repo from origin and the token from yag auth login',
    async () => {
      git(dir, 'init', '-q');
      git(dir, 'remote', 'add', 'origin', 'https://forge.test/team/app.git');
      await store.set('forge.test', 'yag_stored');
      routes.push(on('GET', `${R}/issues?state=open&per_page=30`, [issue(1)]));
      await yag(['issue', 'list'], deps({}));
      expect(calls[0]).toMatchObject({ auth: 'Bearer yag_stored' });
      expect(out).toEqual(['#1\tOPEN\tIssue 1\tbug']);
    },
  );

  it('prefers YAG_TOKEN and --repo', async () => {
    await store.set('forge.test', 'yag_stored');
    routes.push(on('GET', /\/repos\/other\/thing\/issues/, []));
    await yag(
      ['issue', 'list', '-R', 'other/thing'],
      deps({ YAG_API: 'https://forge.test', YAG_TOKEN: 'yag_env' }),
    );
    expect(calls[0]!.auth).toBe('Bearer yag_env');
    expect(errs).toEqual(['No issues match.']);
  });
});

describe('yag issue', () => {
  const R0 = ['-R', 'team/app'];

  it('lists with filters, creates, views and closes like gh', async () => {
    routes.push(
      on('GET', /\/issues\?/, [issue(1), issue(2)]),
      on('POST', `${R}/issues`, issue(3), 201),
      on('GET', `${R}/issues/3`, { ...issue(3), comments: 1 }),
      on('GET', `${R}/issues/3/comments`, [{ body: 'Me too', user, created_at: null }]),
      on('PATCH', `${R}/issues/3`, issue(3, 'closed')),
      on('POST', `${R}/issues/3/comments`, { html_url: 'x' }, 201),
    );
    await yag(['issue', 'list', ...R0, '-s', 'all', '-l', 'bug', 'ready', '-L', '5']);
    expect(calls[0]!.path).toBe(`${R}/issues?state=all&per_page=5&labels=bug%2Cready`);
    expect(out).toEqual(['#1\tOPEN\tIssue 1\tbug', '#2\tOPEN\tIssue 2\tbug']);

    out = [];
    await yag(['issue', 'create', ...R0, '-t', 'Crash', '-b', 'Steps', '-l', 'bug']);
    expect(calls.at(-1)).toMatchObject({
      method: 'POST',
      body: { title: 'Crash', body: 'Steps', labels: ['bug'] },
    });
    expect(out).toEqual(['https://forge.test/r/team/app/issues/3']);

    out = [];
    await yag(['issue', 'view', ...R0, '3', '--comments']);
    expect(out[0]).toBe('Issue 3 #3');
    expect(out).toContain('\nada:\nMe too');

    out = [];
    await yag(['issue', 'close', ...R0, '3', '-r', 'not planned', '-c', 'Wontfix']);
    expect(calls.at(-2)).toMatchObject({ method: 'POST', body: { body: 'Wontfix' } });
    expect(calls.at(-1)).toMatchObject({
      method: 'PATCH',
      body: { state: 'closed', state_reason: 'not_planned' },
    });
    expect(out).toEqual(['Closed issue #3']);
  });
});

describe('yag pr', () => {
  const R0 = ['-R', 'team/app'];

  it.skipIf(!hasGit)(
    'creates from the current branch against the default branch',
    async () => {
      git(dir, 'init', '-q', '-b', 'feature');
      routes.push(
        on('GET', R, { default_branch: 'main' }),
        on('POST', `${R}/pulls`, pull(4), 201),
      );
      await yag(['pr', 'create', ...R0, '-t', 'Add app', '-b', 'Body']);
      expect(calls.at(-1)).toMatchObject({
        body: {
          title: 'Add app',
          body: 'Body',
          head: 'feature',
          base: 'main',
          draft: false,
        },
      });
      expect(out).toEqual(['https://forge.test/r/team/app/pulls/4']);
    },
  );

  it('keeps the old `yag pr -t` form and explains an unpushed branch', async () => {
    routes.push(
      on(
        'POST',
        `${R}/pulls`,
        { error: { code: 'revision_not_found', message: 'No commit found for topic' } },
        404,
      ),
    );
    await expect(
      yag(['pr', ...R0, '-t', 'Old form', '-H', 'topic', '-B', 'main']),
    ).rejects.toThrow('git push origin topic');
  });

  it('lists, views, merges, reviews and reports checks with gh exit codes', async () => {
    routes.push(
      on('GET', /\/pulls\?/, [pull(1)]),
      on('GET', `${R}/pulls/1`, { ...pull(1), mergeable: true }),
      on('PUT', `${R}/pulls/1/merge`, { sha: 'e'.repeat(40), merged: true }),
      on('POST', `${R}/pulls/1/reviews`, { state: 'APPROVED' }),
    );
    await yag(['pr', 'list', ...R0, '-s', 'all']);
    expect(out).toEqual(['#1\tOPEN\tPull 1\tpull/1/head']);

    out = [];
    await yag(['pr', 'view', ...R0, '1']);
    expect(out.slice(0, 3)).toEqual([
      'Pull 1 #1',
      'OPEN • ada wants to merge pull/1/head into main',
      'Ready to merge',
    ]);

    out = [];
    await yag([
      'pr',
      'merge',
      ...R0,
      '1',
      '--squash',
      '--match-head-commit',
      'a'.repeat(40),
    ]);
    expect(calls.at(-1)).toMatchObject({
      method: 'PUT',
      body: { merge_method: 'squash', sha: 'a'.repeat(40) },
    });
    expect(out).toEqual([`Merged pull request #1 (${'e'.repeat(12)})`]);
    await expect(
      yag(['pr', 'merge', ...R0, '1', '--squash', '--rebase']),
    ).rejects.toThrow('Pick one');

    out = [];
    await yag(['pr', 'review', ...R0, '1', '--approve', '-b', 'LGTM']);
    expect(calls.at(-1)).toMatchObject({
      body: { event: 'APPROVE', body: 'LGTM', commit_id: 'a'.repeat(40) },
    });
    expect(out).toEqual(['Reviewed pull request #1: APPROVED']);

    const checks = (runs: unknown[]) =>
      on('GET', `${R}/commits/${'a'.repeat(40)}/check-runs`, {
        total_count: runs.length,
        check_runs: runs,
      });
    routes.unshift(
      checks([
        { name: 'build', status: 'completed', conclusion: 'success', details_url: 'u' },
        { name: 'test', status: 'in_progress', conclusion: null, details_url: 'u' },
      ]),
    );
    out = [];
    await yag(['pr', 'checks', ...R0, '1']);
    expect(out).toEqual(['build\tsuccess\tu', 'test\tin_progress\tu']);
    expect(exitCode).toBe(8);
    routes[0] = checks([
      { name: 'test', status: 'completed', conclusion: 'failure', details_url: null },
    ]);
    await yag(['pr', 'checks', ...R0, '1']);
    expect(exitCode).toBe(1);
  });

  it.skipIf(!hasGit)('checks out pull request 12 with a plain Git remote', async () => {
    // the "forge" remote: a bare repo holding the head commit off any branch,
    // served by SHA as the forge's upload-pack does
    const remote = join(dir, 'remote.git');
    const seed = join(dir, 'seed');
    const work = join(dir, 'work');
    git(dir, 'init', '-q', '--bare', remote);
    git(remote, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
    git(dir, 'init', '-q', '-b', 'main', seed);
    git(seed, 'commit', '-q', '--allow-empty', '-m', 'base');
    git(seed, 'push', '-q', remote, 'main');
    git(seed, 'commit', '-q', '--allow-empty', '-m', 'pull request change');
    const head = git(seed, 'rev-parse', 'HEAD');
    git(seed, 'push', '-q', remote, `${head}:refs/pull/12/head`);
    git(dir, 'clone', '-q', remote, work);

    routes.push(on('GET', `${R}/pulls/12`, pull(12, head)));
    const d = {
      ...deps(),
      cwd: work,
      git: async (args: string[], cwd: string) => git(cwd, ...args),
    };
    await yag(['pr', 'checkout', '12', ...R0], d);
    expect(git(work, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('pr-12');
    expect(git(work, 'rev-parse', 'HEAD')).toBe(head);
    expect(out).toEqual([`Switched to branch pr-12 at ${head.slice(0, 12)}`]);

    // again: the existing branch fast-forwards
    git(work, 'checkout', '-q', 'main');
    await yag(['pr', 'checkout', '12', ...R0], d);
    expect(git(work, 'rev-parse', 'pr-12')).toBe(head);
  });
});

describe('yag run', () => {
  const R0 = ['-R', 'team/app'];
  const N = '/api/v1/repos/team/app';

  it('lists pipeline and CI runs, prints logs and reruns failed jobs', async () => {
    routes.push(
      on('GET', `${N}/ci/pipelines`, {
        runs: [
          {
            id: 'pr_1',
            name: 'build',
            event: 'push',
            ref: 'refs/heads/main',
            head_cs: 'f'.repeat(64),
            state: 'failed',
            created_at: 2000,
            jobs: [
              { key: 'lint', job: 'lint', state: 'passed', run_id: 'run_a', error: null },
              {
                key: 'test',
                job: 'test',
                state: 'failed',
                run_id: 'run_b',
                error: 'exit 1',
              },
            ],
          },
        ],
      }),
      on('GET', `${N}/ci`, {
        runs: [
          {
            id: 'run_c',
            head_cs: 'e'.repeat(64),
            state: 'passed',
            created_at: 1000,
            error: null,
          },
        ],
      }),
      (call) =>
        call.method === 'GET' && call.path.endsWith('/log')
          ? new Response(`log of ${call.path.split('/').at(-2)}`)
          : undefined,
      on(
        'POST',
        `${N}/ci/runs/run_b/retry`,
        { run: { id: 'run_d', state: 'queued' } },
        202,
      ),
    );
    await yag(['run', 'list', ...R0]);
    expect(out.map((l) => l.split('\t').slice(0, 3).join(' '))).toEqual([
      'pr_1 failed build',
      'run_c passed ci',
    ]);

    out = [];
    await yag(['run', 'view', 'pr_1', '--log', ...R0]);
    expect(out).toEqual([
      '== lint (passed)',
      'log of run_a',
      '== test (failed)',
      'log of run_b',
    ]);

    out = [];
    await yag(['run', 'rerun', 'pr_1', ...R0]);
    expect(out).toEqual(['test: run_d queued']);
  });
});

describe('yag api', () => {
  it('expands {owner}/{repo}, sends fields and maps bare paths onto /api/github/v3', async () => {
    expect(apiPath('repos/{owner}/{repo}/issues', 'team/app')).toBe(`${R}/issues`);
    expect(apiPath('/api/v1/repos', null)).toBe('/api/v1/repos');
    expect(fieldsOf(['title=Hi'], ['n=3', 'draft=true', 'x=null', 'v=1.0.0a'])).toEqual({
      title: 'Hi',
      n: 3,
      draft: true,
      x: null,
      v: '1.0.0a',
    });

    routes.push(on('POST', `${R}/issues`, issue(9), 201));
    await yag(['api', 'repos/{owner}/{repo}/issues', '-f', 'title=Hi', '-R', 'team/app']);
    expect(calls[0]).toMatchObject({ method: 'POST', body: { title: 'Hi' } });
    expect(JSON.parse(out.join('\n'))).toMatchObject({ number: 9 });

    await yag(['api', '/user', '-X', 'GET', '-F', 'per_page=5']);
    expect(calls[1]).toMatchObject({
      method: 'GET',
      path: '/api/github/v3/user?per_page=5',
    });
    expect(exitCode).toBe(1); // the fake has no /user
  });
});

describe('yag auth', () => {
  it('logs in with a token, serves git credentials, reports status and logs out', async () => {
    routes.push((call) =>
      call.path === '/api/github/v3/user'
        ? call.auth === 'Bearer yag_good'
          ? Response.json(user)
          : Response.json(
              { error: { code: 'unauthorized', message: 'no' } },
              { status: 401 },
            )
        : undefined,
    );
    stdin = 'yag_bad\n';
    await expect(yag(['auth', 'login', '--with-token'])).rejects.toThrow('HTTP 401');
    expect(await store.get('forge.test')).toBeNull();

    stdin = 'yag_good\n';
    await yag(['auth', 'login', '--with-token', '-h', 'forge.test']);
    expect(out).toEqual([
      'Logged in to forge.test as ada (token kept in the yag hosts file)',
    ]);
    expect(await store.get('forge.test')).toBe('yag_good');
    const mode = (await stat(join(dir, 'config', 'hosts.json'))).mode & 0o777;
    expect(mode).toBe(0o600);

    out = [];
    stdin = 'protocol=https\nhost=forge.test\n\n';
    await yag(['auth', 'git-credential', 'get']);
    expect(out).toEqual(['username=yag', 'password=yag_good']);
    out = [];
    stdin = 'protocol=https\nhost=elsewhere.test\n';
    await yag(['auth', 'git-credential', 'get']);
    expect(out).toEqual([]);

    await yag(['auth', 'status']);
    expect(out).toEqual(['Logged in to forge.test as ada']);
    await yag(['auth', 'logout']);
    expect(await store.get('forge.test')).toBeNull();
    await yag(['auth', 'status']);
    expect(exitCode).toBe(1);

    await expect(yag(['auth', 'login'])).rejects.toThrow('--with-token');
    expect(parseCredentialInput('a=1\nb=x=y\n')).toEqual({ a: '1', b: 'x=y' });
  });

  it('uses the OS keychain tools without putting tokens in files', async () => {
    const ran: { cmd: string; args: string[]; input?: string }[] = [];
    const exec = async (cmd: string, args: string[], input?: string) => {
      ran.push({ cmd, args, input });
      return cmd === 'which' ? '/usr/bin/x' : 'yag_k\n';
    };
    const mac = macKeychain(exec);
    await mac.set('forge.test', 'yag_k');
    expect(await mac.get('forge.test')).toBe('yag_k');
    expect(ran[0]!.args).toEqual([
      'add-generic-password',
      '-U',
      '-s',
      'yag',
      '-a',
      'forge.test',
      '-w',
      'yag_k',
    ]);
    ran.length = 0;
    const linux = secretTool(exec);
    await linux.set('forge.test', 'yag_k');
    expect(ran[0]).toEqual({
      cmd: 'secret-tool',
      args: ['store', '--label=yag forge.test', 'service', 'yag', 'host', 'forge.test'],
      input: 'yag_k',
    });
    expect((await defaultStore({}, exec, 'darwin')).kind).toBe('keychain');
    expect((await defaultStore({}, exec, 'linux')).kind).toBe('keychain');
    expect(
      (await defaultStore({ YAG_CREDENTIAL_STORE: 'file' }, exec, 'darwin')).kind,
    ).toBe('file');
    const none = async () => {
      throw new Error('missing');
    };
    expect((await defaultStore({ YAG_CONFIG_DIR: dir }, none, 'win32')).kind).toBe(
      'file',
    );
    await expect(
      defaultStore({ YAG_CREDENTIAL_STORE: 'keychain' }, none, 'linux'),
    ).rejects.toThrow('No OS keychain');
  });
});
