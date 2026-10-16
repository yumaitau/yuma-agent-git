import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Real-client smoke for the package registry (issue #53): stock `helm` pushes
 * and pulls a chart over OCI (Bearer challenge, token exchange, blob upload,
 * manifest), and stock `npm` publishes and installs a scoped package, against
 * the Worker under `wrangler dev` with a throwaway local D1/R2 store. Needs
 * helm and npm and a local workerd, so it runs in CI or with YAG_GIT_SMOKE=1,
 * like the Git smoke.
 */

const has = (cmd: string, arg: string): boolean =>
  spawnSync(cmd, [arg], { encoding: 'utf8' }).status === 0;
const smoke = Boolean(process.env.CI || process.env.YAG_GIT_SMOKE);
const hasHelm = has('helm', 'version');
const hasNpm = has('npm', '--version');

const workerDir = resolve(import.meta.dirname, '../../worker');
const port = 19_700 + Math.floor(Math.random() * 1000);
const host = `127.0.0.1:${port}`;
const token = `yag_${randomBytes(20).toString('hex')}`;

let dir = '';
let server: ChildProcess | null = null;
let toolEnv: NodeJS.ProcessEnv = {};

function run(cmd: string, args: string[], cwd: string): string {
  const res = spawnSync(cmd, args, { cwd, env: toolEnv, encoding: 'utf8' });
  if (res.status !== 0)
    throw new Error(`${cmd} ${args.join(' ')} failed:\n${res.stdout}${res.stderr}`);
  return `${res.stdout}${res.stderr}`;
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
      if ((await fetch(`http://${host}/healthz`)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('wrangler dev did not start');
}

describe.runIf(smoke && (hasHelm || hasNpm))(
  'package registry against wrangler dev',
  () => {
    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), 'yag-registry-'));
      const persist = join(dir, 'state');
      await mkdir(join(dir, 'home'));
      toolEnv = {
        PATH: process.env.PATH,
        HOME: join(dir, 'home'),
        HELM_CONFIG_HOME: join(dir, 'home/helm'),
        HELM_CACHE_HOME: join(dir, 'home/helm-cache'),
        HELM_DATA_HOME: join(dir, 'home/helm-data'),
        npm_config_cache: join(dir, 'home/npm-cache'),
        npm_config_update_notifier: 'false',
        npm_config_audit: 'false',
        npm_config_fund: 'false',
      };
      wrangler([
        'd1',
        'migrations',
        'apply',
        'yag-db',
        '--local',
        '--persist-to',
        persist,
      ]);
      const hash = createHash('sha256').update(token).digest('hex');
      wrangler([
        'd1',
        'execute',
        'yag-db',
        '--local',
        '--persist-to',
        persist,
        '--command',
        `INSERT INTO users (id, login, created_at) VALUES ('u1', 'acme', 1);
       INSERT INTO api_tokens (id, token_hash, repo_id, user_id, label, scopes, created_at)
         VALUES ('t1', '${hash}', NULL, 'u1', 'smoke', '["repo:read","repo:write"]', 1);
       INSERT INTO repos (id, slug, default_branch, created_at, visibility, created_by, refs_mode, owner_kind, owner_id)
         VALUES ('r1', 'acme/app', 'main', 1, 'private', 'u1', 'git', 'user', 'acme');`,
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
        ].concat(['--persist-to', persist, '--show-interactive-dev-session=false']),
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

    it('answers anonymous registry requests with 401 and the Bearer challenge', async () => {
      const res = await fetch(`http://${host}/v2/`);
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe(
        `Bearer realm="http://${host}/v2/token",service="${host}"`,
      );
    });

    it.runIf(hasHelm)(
      'helm pushes and pulls a chart over OCI',
      async () => {
        const work = join(dir, 'helm');
        await mkdir(work);
        run('helm', ['create', 'web'], work);
        run('helm', ['package', 'web', '--version', '0.1.0'], work);
        run(
          'helm',
          ['registry', 'login', host, '--plain-http', '-u', 'any', '--password', token],
          work,
        );
        const pushed = run(
          'helm',
          ['push', 'web-0.1.0.tgz', `oci://${host}/acme/app/charts`, '--plain-http'],
          work,
        );
        expect(pushed).toContain('Digest: sha256:');
        const out = join(work, 'pulled');
        await mkdir(out);
        run(
          'helm',
          [
            'pull',
            `oci://${host}/acme/app/charts/web`,
            '--version',
            '0.1.0',
            '--plain-http',
            '-d',
            out,
          ],
          work,
        );
        expect(await readFile(join(out, 'web-0.1.0.tgz'))).toEqual(
          await readFile(join(work, 'web-0.1.0.tgz')),
        );
        // a wrong password is refused
        const bad = spawnSync(
          'helm',
          [
            'pull',
            `oci://${host}/acme/app/charts/web`,
            '--version',
            '0.1.0',
            '--plain-http',
          ],
          {
            cwd: work,
            env: { ...toolEnv, HELM_REGISTRY_CONFIG: join(dir, 'none.json') },
            encoding: 'utf8',
          },
        );
        expect(bad.status).not.toBe(0);
      },
      120_000,
    );

    it.runIf(hasNpm)(
      'npm publishes and installs a scoped package',
      async () => {
        const npmrc = `@acme:registry=http://${host}/npm/\n//${host}/npm/:_authToken=${token}\n`;
        const pkg = join(dir, 'pkg');
        await mkdir(pkg);
        await writeFile(join(pkg, '.npmrc'), npmrc);
        await writeFile(
          join(pkg, 'package.json'),
          JSON.stringify({ name: '@acme/app', version: '1.0.0', main: 'index.js' }),
        );
        await writeFile(
          join(pkg, 'index.js'),
          'module.exports = "hello from the forge";\n',
        );
        run('npm', ['publish'], pkg);
        expect(
          run('npm', ['whoami', '--registry', `http://${host}/npm/`], pkg).trim(),
        ).toBe('acme');

        const app = join(dir, 'consumer');
        await mkdir(app);
        await writeFile(join(app, '.npmrc'), npmrc);
        await writeFile(
          join(app, 'package.json'),
          JSON.stringify({ name: 'consumer', private: true }),
        );
        run('npm', ['install', '@acme/app'], app);
        expect(
          await readFile(join(app, 'node_modules/@acme/app/index.js'), 'utf8'),
        ).toContain('hello from the forge');
        run('npm', ['dist-tag', 'add', '@acme/app@1.0.0', 'stable'], pkg);
        expect(run('npm', ['dist-tag', 'ls', '@acme/app'], pkg)).toContain(
          'stable: 1.0.0',
        );
      },
      120_000,
    );
  },
);
