// Local target for the load harness (issue #78): a throwaway `wrangler dev
// --local` with its own D1/R2 state, a second D1 shard (DB_SHARD_1) that exists
// only in a generated config, and seeded users, orgs, repos and a token.
// Nothing here talks to Cloudflare: every binding is local to workerd.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const workerDir = resolve(import.meta.dirname, '../../worker');

/** worker/wrangler.jsonc has whole-line comments only. */
function readJsonc(path) {
  const text = readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n')
    .replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(text);
}

/** The top-level (dev) config with absolute paths and a local-only second shard. */
function devConfig(dir) {
  const config = readJsonc(join(workerDir, 'wrangler.jsonc'));
  delete config.env; // prod (containers, AI) is never started here
  config.main = join(workerDir, config.main);
  const assets = join(workerDir, config.assets.directory);
  if (existsSync(assets)) config.assets.directory = assets;
  else delete config.assets;
  const migrations = join(workerDir, 'migrations');
  config.d1_databases = [
    {
      binding: 'DB',
      database_name: 'yag-db',
      database_id: 'local-db',
      migrations_dir: migrations,
    },
    {
      binding: 'DB_SHARD_1',
      database_name: 'yag-shard-1',
      database_id: 'local-shard-1',
      migrations_dir: migrations,
    },
  ];
  const path = join(dir, 'wrangler.load.json');
  writeFileSync(path, JSON.stringify(config, null, 2));
  return path;
}

const env = {
  ...process.env,
  CI: '1',
  WRANGLER_SEND_METRICS: 'false',
  // containers are prod-only; never reach a Docker daemon from here
  DOCKER_HOST: 'unix:///nonexistent.sock',
};

function wrangler(args) {
  const res = spawnSync('npx', ['wrangler', ...args], {
    cwd: workerDir,
    env,
    encoding: 'utf8',
  });
  if (res.status !== 0) throw new Error(`wrangler ${args[0]} failed:\n${res.stderr}`);
}

/**
 * Start the local target. Returns `{ url, token, stop }`; the token is a
 * random local value whose hash is seeded, never a real credential.
 */
export async function startLocal(dir, port) {
  const config = devConfig(dir);
  const persist = join(dir, 'state');
  const token = `yag_${randomBytes(20).toString('hex')}`;
  const hash = createHash('sha256').update(token).digest('hex');
  for (const db of ['DB', 'DB_SHARD_1'])
    wrangler([
      'd1',
      'migrations',
      'apply',
      db,
      '--local',
      '-c',
      config,
      '--persist-to',
      persist,
    ]);
  const seed = [
    "INSERT INTO users (id, login, created_at) VALUES ('u1', 'ada', 1)",
    `INSERT INTO api_tokens (id, token_hash, repo_id, user_id, label, scopes, created_at)
       VALUES ('t1', '${hash}', NULL, 'u1', 'load', '["repo:read","repo:write"]', 1)`,
    "INSERT INTO orgs (id, slug, display_name, created_at) VALUES ('o1', 'acme', 'Acme', 1), ('o2', 'beta', 'Beta', 1)",
    "INSERT INTO org_members (org_id, user_id, role) VALUES ('o1', 'u1', 'owner'), ('o2', 'u1', 'owner')",
    // beta's routed tables live on the second shard
    "INSERT INTO shard_directory (org_id, shard, updated_at) VALUES ('o2', 'DB_SHARD_1', 1)",
    ...[
      ['r1', 'acme/app', 'o1'],
      ['r2', 'beta/app', 'o2'],
      ['r3', 'acme/big', 'o1'],
    ].flatMap(([id, slug, org]) => [
      `INSERT INTO repos (id, slug, default_branch, created_at, visibility, created_by, refs_mode, owner_kind, owner_id)
         VALUES ('${id}', '${slug}', 'main', 1, 'private', 'u1', 'git', 'org', '${org}')`,
      `INSERT INTO repo_members (repo_id, user_id, role) VALUES ('${id}', 'u1', 'admin')`,
    ]),
  ];
  wrangler([
    'd1',
    'execute',
    'DB',
    '--local',
    '-c',
    config,
    '--persist-to',
    persist,
    '--command',
    seed.join(';\n'),
  ]);
  const server = spawn(
    'npx',
    [
      'wrangler',
      'dev',
      '--local',
      '-c',
      config,
      '--ip',
      '127.0.0.1',
      '--port',
      String(port),
      '--persist-to',
      persist,
      '--show-interactive-dev-session=false',
      '--inspector-port',
      String(port + 1),
      '--log-level',
      'error',
      // the harness measures the forge, not the per-principal rate limits
      '--var',
      `RATE_LIMIT_BUCKETS:${JSON.stringify(
        Object.fromEntries(
          ['api_read', 'api_write', 'agent_run', 'object_fetch', 'auth', 'git'].map(
            (b) => [b, 1_000_000],
          ),
        ),
      )}`,
    ],
    { cwd: workerDir, env, detached: true, stdio: 'ignore' },
  );
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${url}/healthz`)).ok) break;
    } catch {
      // not listening yet
    }
    if (i > 240) {
      process.kill(-server.pid, 'SIGTERM');
      throw new Error('wrangler dev did not start');
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return {
    url,
    token,
    stop: () => {
      try {
        process.kill(-server.pid, 'SIGTERM');
      } catch {
        // already gone
      }
    },
  };
}
