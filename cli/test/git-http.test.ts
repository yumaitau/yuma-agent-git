import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  mkdtemp,
  rm,
  writeFile,
  chmod,
  symlink,
  mkdir,
  readFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Real-git smoke for Git smart HTTP (issues #31, #32): stock `git` against
 * the Worker under `wrangler dev` with a throwaway local D1/R2 store. Clone,
 * incremental fetch, `--depth 1`, `--filter=blob:none`, pushes of new and
 * merge commits, a refused force push to the default branch, and a fresh
 * clone that must hold the exact pushed SHAs. Needs git and a local workerd,
 * so it runs in CI or with YAG_GIT_SMOKE=1, like the fast-import smoke.
 */

const hasGit = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
const enabled = Boolean((process.env.CI || process.env.YAG_GIT_SMOKE) && hasGit);
// Git LFS (#35) runs where git-lfs is installed (GitHub's runners have it)
const hasLfs = enabled && spawnSync('git', ['lfs', 'version']).status === 0;

const workerDir = resolve(import.meta.dirname, '../../worker');
const port = 18_700 + Math.floor(Math.random() * 1000);
const token = `yag_${randomBytes(20).toString('hex')}`;
const remote = `http://git:${token}@127.0.0.1:${port}/ada/smoke.git`;

let dir = '';
let server: ChildProcess | null = null;
let gitEnv: NodeJS.ProcessEnv = {};

function run(cmd: string, args: string[], cwd: string): { code: number; out: string } {
  const res = spawnSync(cmd, args, { cwd, env: gitEnv, encoding: 'utf8' });
  return { code: res.status ?? -1, out: `${res.stdout}${res.stderr}` };
}

function git(cwd: string, ...args: string[]): string {
  const res = run('git', ['-c', 'protocol.version=2', ...args], cwd);
  if (res.code !== 0) throw new Error(`git ${args.join(' ')} failed:\n${res.out}`);
  return res.out.trim();
}

function wrangler(args: string[]): void {
  const res = spawnSync('npx', ['wrangler', ...args], {
    cwd: workerDir,
    env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' },
    encoding: 'utf8',
  });
  if (res.status !== 0) throw new Error(`wrangler ${args[0]} failed:\n${res.stderr}`);
}

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('wrangler dev did not start');
}

describe.runIf(enabled)('git smart HTTP against wrangler dev (CI smoke)', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'yag-git-http-'));
    const persist = join(dir, 'state');
    await mkdir(join(dir, 'home'));
    gitEnv = {
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
    const hash = createHash('sha256').update(token).digest('hex');
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
         VALUES ('t1', '${hash}', NULL, 'u1', 'smoke', '["repo:read","repo:write"]', 1);
       INSERT INTO repos (id, slug, default_branch, created_at, visibility, created_by, refs_mode, owner_kind, owner_id)
         VALUES ('r1', 'ada/smoke', 'main', 1, 'private', 'u1', 'git', 'user', 'ada');`,
    ]);
    server = spawn(
      'npx',
      ['wrangler', 'dev', '--local', '--ip', '127.0.0.1', '--port', String(port)].concat([
        '--persist-to',
        persist,
        '--show-interactive-dev-session=false',
        // signs Git LFS transfer actions
        '--var',
        'CACHE_SIGNING_KEY:smoke-signing-key',
      ]),
      {
        cwd: workerDir,
        env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
        detached: true,
        stdio: 'ignore',
      },
    );
    await waitForServer();
  }, 180_000);

  afterAll(async () => {
    if (server?.pid) process.kill(-server.pid, 'SIGTERM');
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('answers anonymous Git requests with 401 and WWW-Authenticate', async () => {
    const res = await fetch(
      `http://127.0.0.1:${port}/ada/smoke.git/info/refs?service=git-upload-pack`,
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/^Basic /);
    const anon = run(
      'git',
      ['clone', `http://127.0.0.1:${port}/ada/smoke.git`, join(dir, 'anon')],
      dir,
    );
    expect(anon.code).not.toBe(0);
  });

  it('pushes, clones, fetches, shallow and partial clones with identical SHAs', async () => {
    const src = join(dir, 'src');
    git(dir, 'init', '-q', '-b', 'main', src);
    await mkdir(join(src, 'a/b'), { recursive: true });
    await writeFile(join(src, 'README.md'), 'hello\n');
    await writeFile(join(src, 'a/b/deep.txt'), 'deep\n');
    await writeFile(join(src, 'run.sh'), 'echo hi\n');
    await chmod(join(src, 'run.sh'), 0o755);
    await symlink('README.md', join(src, 'link'));
    git(src, 'add', '.');
    git(src, 'commit', '-qm', 'first commit');
    git(src, 'remote', 'add', 'origin', remote);
    git(src, 'push', '-q', 'origin', 'main');

    const c1 = join(dir, 'c1');
    git(dir, 'clone', '-q', remote, c1);
    expect(git(c1, 'rev-parse', 'HEAD')).toBe(git(src, 'rev-parse', 'HEAD'));
    expect(git(c1, 'ls-files', '-s', 'run.sh')).toMatch(/^100755 /);
    expect(git(c1, 'ls-files', '-s', 'link')).toMatch(/^120000 /);

    // new commits (thin-pack deltas against stored blobs) and a merge commit
    for (let i = 1; i <= 3; i++) {
      await writeFile(join(src, 'README.md'), `hello\n${'line\n'.repeat(i * 100)}`);
      git(src, 'commit', '-qam', `edit ${i}`);
    }
    git(src, 'checkout', '-qb', 'feature');
    await writeFile(join(src, 'feature.txt'), 'feature\n');
    git(src, 'add', 'feature.txt');
    git(src, 'commit', '-qm', 'feature work');
    git(src, 'checkout', '-q', 'main');
    await writeFile(join(src, 'a/b/deep.txt'), 'deeper\n');
    git(src, 'commit', '-qam', 'main work');
    git(src, 'merge', '-q', '--no-ff', 'feature', '-m', 'merge feature');
    git(src, 'push', '-q', 'origin', 'main', 'feature');
    const head = git(src, 'rev-parse', 'main');
    expect(git(src, 'rev-list', '--parents', '-n', '1', 'main').split(' ')).toHaveLength(
      3,
    );

    git(c1, 'fetch', '-q');
    expect(git(c1, 'rev-parse', 'origin/main')).toBe(head);
    expect(git(c1, 'rev-parse', 'origin/feature')).toBe(git(src, 'rev-parse', 'feature'));
    git(c1, 'fsck', '--strict');

    const shallow = join(dir, 'shallow');
    git(dir, 'clone', '-q', '--depth', '1', remote, shallow);
    expect(git(shallow, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(shallow, 'rev-list', '--count', 'HEAD')).toBe('1');

    const partial = join(dir, 'partial');
    git(dir, 'clone', '-q', '--filter=blob:none', remote, partial);
    expect(git(partial, 'rev-parse', 'HEAD')).toBe(head);
    expect(await readFile(join(partial, 'feature.txt'), 'utf8')).toBe('feature\n');

    // a fresh clone after the pushes holds exactly the pushed commits
    const fresh = join(dir, 'fresh');
    git(dir, 'clone', '-q', remote, fresh);
    const all = (cwd: string, ref: string): string[] =>
      git(cwd, 'rev-list', ref).split('\n').sort();
    expect(all(fresh, 'origin/main')).toEqual(all(src, 'main'));
    expect(all(fresh, 'origin/feature')).toEqual(all(src, 'feature'));
  }, 180_000);

  it('refuses a force push to the default branch and allows one elsewhere', () => {
    const src = join(dir, 'src');
    git(src, 'checkout', '-qb', 'rewrite', 'main~1');
    git(src, 'commit', '-q', '--allow-empty', '-m', 'rewritten');
    const refused = run('git', ['push', '--force', 'origin', 'rewrite:main'], src);
    expect(refused.code).not.toBe(0);
    expect(refused.out).toContain('protected_branch');
    git(src, 'push', '-q', '--force', 'origin', 'rewrite:feature');
    expect(git(src, 'ls-remote', 'origin', 'refs/heads/feature').split('\t')[0]).toBe(
      git(src, 'rev-parse', 'rewrite'),
    );
  }, 60_000);

  it('refuses a pushed secret with its location; an admin bypasses with -o', async () => {
    const src = join(dir, 'src');
    git(src, 'checkout', '-qb', 'leak', 'main');
    // built at run time so this file holds no key-shaped literal
    const key = `AKIA${'Q3JXZ7M5N4P6R2TW'}`;
    await writeFile(join(src, 'deploy.env'), `REGION=ap-southeast-2\nKEY=${key}\n`);
    git(src, 'add', 'deploy.env');
    git(src, 'commit', '-qm', 'add deploy settings');
    const refused = run('git', ['push', 'origin', 'leak'], src);
    expect(refused.code).not.toBe(0);
    expect(refused.out).toContain('secret_scanning: AWS access key ID at deploy.env:2');
    expect(refused.out).not.toContain(key);
    git(src, 'push', '-q', '-o', 'secret-scanning.bypass=test_data', 'origin', 'leak');
    expect(git(src, 'ls-remote', 'origin', 'refs/heads/leak').split('\t')[0]).toBe(
      git(src, 'rev-parse', 'leak'),
    );
  }, 60_000);

  it('exports a Git bundle that clones with the same commit SHAs (#70)', async () => {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/v1/repos/ada/smoke/export/bundle`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(res.status).toBe(200);
    const file = join(dir, 'smoke.bundle');
    await writeFile(file, Buffer.from(await res.arrayBuffer()));
    const src = join(dir, 'src');
    git(src, 'bundle', 'verify', '-q', file);
    const heads = (out: string): string[] =>
      out
        .split('\n')
        .map((l) => l.trim().split(/\s+/).join(' '))
        .filter(Boolean)
        .sort();
    expect(heads(git(src, 'bundle', 'list-heads', file))).toEqual(
      heads(git(src, 'ls-remote', 'origin')),
    );
    const restored = join(dir, 'restored');
    git(dir, 'clone', '-q', file, restored);
    expect(git(restored, 'rev-parse', 'HEAD')).toBe(git(src, 'rev-parse', 'origin/main'));
    git(restored, 'fsck', '--strict');
  }, 60_000);

  it.runIf(hasLfs)(
    'pushes and pulls Git LFS objects (#35)',
    async () => {
      const src = join(dir, 'src');
      git(dir, 'lfs', 'install');
      git(src, 'checkout', '-qb', 'assets', 'main');
      git(src, 'lfs', 'track', '*.bin');
      const bytes = randomBytes(300_000);
      await writeFile(join(src, 'model.bin'), bytes);
      git(src, 'add', '.gitattributes', 'model.bin');
      git(src, 'commit', '-qm', 'add a large binary');
      git(src, 'push', '-q', 'origin', 'assets');
      const clone = join(dir, 'lfs-clone');
      git(dir, 'clone', '-q', '--branch', 'assets', remote, clone);
      expect(await readFile(join(clone, 'model.bin'))).toEqual(bytes);
      git(clone, 'lfs', 'fsck');
      expect(git(clone, 'lfs', 'locks')).toBe('');
    },
    120_000,
  );

  it('tells protocol v0 clients to use protocol v2', () => {
    const res = run(
      'git',
      ['-c', 'protocol.version=0', 'clone', remote, join(dir, 'v0')],
      dir,
    );
    expect(res.code).not.toBe(0);
    expect(res.out).toContain('protocol v2');
  }, 60_000);
});

describe('git smart HTTP smoke gate', () => {
  it('is skipped without git or CI', () => {
    if (!enabled) {
      console.warn(
        'git smart HTTP smoke skipped (set CI or YAG_GIT_SMOKE=1 with git installed)',
      );
    }
    expect(true).toBe(true);
  });
});
