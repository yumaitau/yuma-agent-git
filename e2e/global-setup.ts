import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { port } from './playwright.config.ts';

/**
 * Starts the Worker under `wrangler dev --local` with a throwaway D1/R2 store
 * (issue #80), like `cli/test/git-http.test.ts`. The only rows written
 * directly are two users and their browser sessions, since signing in needs
 * a real identity provider; the tests create everything else through the
 * public API and the dashboard.
 */
const workerDir = resolve(import.meta.dirname, '../worker');
// containers only exist in env.prod; this keeps any Docker call off the host
const env = {
  ...process.env,
  CI: '1',
  WRANGLER_SEND_METRICS: 'false',
  DOCKER_HOST: 'unix:///nonexistent.sock',
};

function wrangler(args: string[]): void {
  const res = spawnSync('npx', ['wrangler', ...args], {
    cwd: workerDir,
    env,
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

export default async function globalSetup(): Promise<() => Promise<void>> {
  const dir = await mkdtemp(join(tmpdir(), 'yag-e2e-'));
  const persist = join(dir, 'state');
  const sessions = {
    ada: randomBytes(32).toString('hex'),
    grace: randomBytes(32).toString('hex'),
  };
  const hash = (token: string): string =>
    createHash('sha256').update(token).digest('hex');
  const now = Date.now();
  const expires = now + 86_400_000;
  wrangler(['d1', 'migrations', 'apply', 'yag-db', '--local', '--persist-to', persist]);
  wrangler([
    'd1',
    'execute',
    'yag-db',
    '--local',
    '--persist-to',
    persist,
    '--command',
    `INSERT INTO users (id, login, created_at) VALUES ('u1', 'ada', 1), ('u2', 'grace', 1);
     INSERT INTO sessions (token_hash, user_id, created_at, expires_at)
       VALUES ('${hash(sessions.ada)}', 'u1', ${now}, ${expires}),
              ('${hash(sessions.grace)}', 'u2', ${now}, ${expires});`,
  ]);
  const server = spawn(
    'npx',
    [
      'wrangler',
      'dev',
      '--local',
      '--ip',
      '127.0.0.1',
      '--port',
      String(port),
      '--inspector-port',
      String(port + 1),
      '--persist-to',
      persist,
      '--show-interactive-dev-session=false',
    ],
    { cwd: workerDir, env, detached: true, stdio: 'ignore' },
  );
  process.env.YAG_E2E_ADA = sessions.ada;
  process.env.YAG_E2E_GRACE = sessions.grace;
  const stop = async (): Promise<void> => {
    if (server.pid) process.kill(-server.pid, 'SIGTERM');
    await rm(dir, { recursive: true, force: true });
  };
  try {
    await waitForServer();
  } catch (err) {
    await stop();
    throw err;
  }
  return stop;
}
