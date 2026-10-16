#!/usr/bin/env node
// Load harness (issue #78): clone, fetch, push, the commit RPC, pull request
// create and merge, a large-repo clone and two-org isolation, timed from the
// client. See docs/performance.md for how to run it and what has been measured.
//
//   node scripts/load/run.mjs --scenario all --target local
//   node scripts/load/run.mjs --scenario clone-large --files 20000 --size-mb 40
//   YAG_LOAD_URL=… YAG_LOAD_TOKEN=… node scripts/load/run.mjs --target staging
//
// `local` starts its own throwaway `wrangler dev --local` (scripts/load/local.mjs).
// Any other target needs YAG_LOAD_URL and YAG_LOAD_TOKEN, and the repos named by
// YAG_LOAD_REPO (default acme/app), YAG_LOAD_BIG_REPO (acme/big) and
// YAG_LOAD_OTHER_REPO (beta/app) must exist and be writable by the token.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { startLocal } from './local.mjs';

const SCENARIOS = [
  'clone',
  'fetch',
  'push',
  'commit',
  'pr',
  'merge',
  'clone-large',
  'two-org',
];
const { values: opts } = parseArgs({
  options: {
    scenario: { type: 'string', default: 'all' },
    target: { type: 'string', default: 'local' },
    iterations: { type: 'string', default: '20' },
    concurrency: { type: 'string', default: '4' },
    files: { type: 'string', default: '20000' },
    'size-mb': { type: 'string', default: '40' },
    port: { type: 'string', default: String(19_400 + Math.floor(Math.random() * 500)) },
    out: { type: 'string' },
  },
});
const scenarios = opts.scenario === 'all' ? SCENARIOS : opts.scenario.split(',');
for (const s of scenarios)
  if (!SCENARIOS.includes(s)) throw new Error(`unknown scenario ${s}`);
const ITER = Number(opts.iterations);
const CONC = Number(opts.concurrency);

// --- measurement --------------------------------------------------------------

function summary(ms) {
  const sorted = [...ms].sort((a, b) => a - b);
  const at = (p) =>
    sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
  const r = (n) => Math.round(n * 10) / 10;
  return {
    n: sorted.length,
    p50_ms: r(at(50)),
    p95_ms: r(at(95)),
    max_ms: r(sorted.at(-1)),
  };
}

/** Run `op(i, worker)` `n` times, `conc` at once; returns per-op latencies and wall time. */
async function pool(n, conc, op) {
  const ms = [];
  let next = 0;
  const start = performance.now();
  await Promise.all(
    Array.from({ length: Math.min(conc, n) }, async (_, w) => {
      for (let i = next++; i < n; i = next++) {
        const t = performance.now();
        await op(i, w);
        ms.push(performance.now() - t);
      }
    }),
  );
  return { ms, wall_ms: performance.now() - start };
}

// --- clients ----------------------------------------------------------------------

let base = '';
let token = '';
let work = '';

function sh(cmd, args, cwd, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env } });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${cmd} ${args.join(' ')}: ${out}`)),
    );
  });
}

/** Git with the token in its environment only, never on a command line. */
function git(cwd, ...args) {
  return sh('git', ['-c', 'protocol.version=2', ...args], cwd, {
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Load',
    GIT_AUTHOR_EMAIL: 'load@example.com',
    GIT_COMMITTER_NAME: 'Load',
    GIT_COMMITTER_EMAIL: 'load@example.com',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`load:${token}`).toString('base64')}`,
  });
}

const remote = (slug) => `${base}/${slug}.git`;

async function api(method, path, body) {
  const res = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

let seq = 0;
const fresh = (prefix) => join(work, `${prefix}-${seq++}`);

/** A local clone of `slug` with one commit on main, pushed if the repo was empty. */
async function seeded(slug) {
  const dir = fresh('seed');
  await git(work, 'clone', '-q', remote(slug), dir);
  if (!(await git(dir, 'branch', '-r')).trim()) {
    await git(dir, 'checkout', '-q', '-b', 'main');
    await writeFile(join(dir, 'README.md'), `# ${slug}\n`);
    await mkdir(join(dir, 'src'), { recursive: true });
    for (let i = 0; i < 50; i++)
      await writeFile(join(dir, 'src', `m${i}.ts`), `export const v = ${i};\n`);
    await git(dir, 'add', '-A');
    await git(dir, 'commit', '-q', '-m', 'seed');
    await git(dir, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  }
  return dir;
}

/** `n` seeded clones, one after another so only the first can push the seed. */
async function clones(slug, n) {
  const dirs = [];
  for (let i = 0; i < n; i++) dirs.push(await seeded(slug));
  return dirs;
}

/** A changeset off `main` touching one file; the commit RPC. */
async function changeset(slug, label) {
  const res = await api('POST', `/repos/${slug}/changesets`, {
    first_parent: 'ref:main',
    message: `load ${label}\n`,
    author: { name: 'Load', email: 'load@example.com' },
    changes: [
      {
        path: `load/${label}.txt`,
        op: 'add',
        content_b64: Buffer.from(label).toString('base64'),
      },
    ],
  });
  return res.changeset.id;
}

// --- scenarios ----------------------------------------------------------------------

const small = process.env.YAG_LOAD_REPO ?? 'acme/app';
const big = process.env.YAG_LOAD_BIG_REPO ?? 'acme/big';
const other = process.env.YAG_LOAD_OTHER_REPO ?? 'beta/app';

const run = {
  async clone() {
    await seeded(small);
    return pool(ITER, CONC, () =>
      git(work, 'clone', '-q', remote(small), fresh('clone')),
    );
  },

  async fetch() {
    const writers = await clones(small, CONC);
    const readers = await Promise.all(
      Array.from({ length: CONC }, async () => {
        const dir = fresh('reader');
        await git(work, 'clone', '-q', remote(small), dir);
        return dir;
      }),
    );
    return pool(ITER, CONC, async (i, w) => {
      const writer = writers[w];
      await writeFile(join(writer, `fetch-${i}.txt`), `${i}\n`);
      await git(writer, 'add', '-A');
      await git(writer, 'commit', '-q', '-m', `fetch ${i}`);
      await git(writer, 'push', '-q', 'origin', `HEAD:refs/heads/fetch-${i}`);
      await git(readers[w], 'fetch', '-q', 'origin', `fetch-${i}`);
    });
  },

  async push() {
    const dirs = await clones(small, CONC);
    return pool(ITER, CONC, async (i, w) => {
      const dir = dirs[w];
      await writeFile(join(dir, `push-${i}.txt`), `${i}\n`);
      await git(dir, 'add', '-A');
      await git(dir, 'commit', '-q', '-m', `push ${i}`);
      await git(dir, 'push', '-q', 'origin', `HEAD:refs/heads/push-${i}`);
    });
  },

  async commit() {
    await seeded(small);
    return pool(ITER, CONC, async (i) => {
      const id = await changeset(small, `commit-${Date.now()}-${i}`);
      await api('PUT', `/repos/${small}/refs/rpc-${i}-${seq++}`, { from: null, to: id });
    });
  },

  async pr() {
    await seeded(small);
    return pool(ITER, CONC, async (i) => {
      const head = await changeset(small, `pr-${Date.now()}-${i}`);
      await api('POST', `/repos/${small}/pulls`, { title: `load ${i}`, head_cs: head });
    });
  },

  async merge() {
    await seeded(small);
    await api('PUT', `/repos/${small}/ci`, {
      commands: ['true'],
      required_approvals: 0,
      require_checks: false,
    });
    const pulls = [];
    for (let i = 0; i < ITER; i++) {
      const head = await changeset(small, `merge-${Date.now()}-${i}`);
      pulls.push(
        (await api('POST', `/repos/${small}/pulls`, { title: `m ${i}`, head_cs: head }))
          .pull,
      );
    }
    // merges move one branch, so they run one after another (the ref lock serialises them)
    return pool(ITER, 1, async (i) => {
      const pull = (
        await api('GET', `/repos/${small}/pulls/${pulls[i].number ?? pulls[i].id}`)
      ).pull;
      await api('POST', `/repos/${small}/pulls/${pull.number ?? pull.id}/merge`, {
        head_cs: pull.head_cs,
        revision: pull.revision,
      });
    });
  },

  async 'clone-large'() {
    const files = Number(opts.files);
    const bytes = Math.max(
      64,
      Math.floor((Number(opts['size-mb']) * 1024 * 1024) / files),
    );
    // a commit stores at most 5,000 changes and a push carries at most 24 MiB of pack
    const perCommit = Math.max(1, Math.min(5000, Math.floor((16 * 1024 * 1024) / bytes)));
    const dir = fresh('large');
    await git(work, 'init', '-q', '-b', 'main', dir);
    await git(dir, 'remote', 'add', 'origin', remote(big));
    const t0 = performance.now();
    for (let start = 0; start < files; start += perCommit) {
      for (let i = start; i < Math.min(files, start + perCommit); i++) {
        const sub = join(dir, `d${i % 100}`);
        await mkdir(sub, { recursive: true });
        await writeFile(join(sub, `f${i}.bin`), randomBytes(bytes));
      }
      await git(dir, 'add', '-A');
      await git(dir, 'commit', '-q', '-m', `files from ${start}`);
      await git(dir, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    }
    const pushMs = performance.now() - t0;
    const pack = (await git(dir, 'count-objects', '-vH')).match(/size-pack: (.*)/)?.[1];
    const timed = async (label, args) => {
      const t = performance.now();
      await git(work, 'clone', '-q', ...args, remote(big), fresh(label));
      return performance.now() - t;
    };
    const cold = await timed('cold', []);
    const warm = await timed('warm', []);
    const shallow = await timed('shallow', ['--depth', '1']);
    return {
      files,
      bytes_per_file: bytes,
      commits: Math.ceil(files / perCommit),
      local_pack_size: pack ?? null,
      push_all_ms: Math.round(pushMs),
      clone_cold_ms: Math.round(cold),
      clone_warm_ms: Math.round(warm),
      clone_depth1_ms: Math.round(shallow),
    };
  },

  async 'two-org'() {
    await Promise.all([seeded(small), seeded(other)]);
    const report = (slug, label) =>
      api('POST', '/usage', {
        repo: slug,
        model: 'gpt-x',
        input_tokens: 10,
        ticket: label,
      });
    /** `small`'s write latency while `noisy` takes a burst of writes. */
    const during = async (noisy, label) => {
      let bursting = true;
      let writes = 0;
      const burster = Promise.all(
        Array.from({ length: CONC * 2 }, async () => {
          while (bursting) {
            await report(noisy, `${label}-${writes}`);
            writes++;
          }
        }),
      );
      const ms = (await pool(ITER, 1, (i) => report(small, `${label}-quiet-${i}`))).ms;
      bursting = false;
      await burster;
      return { ...summary(ms), burst_writes: writes };
    };
    const quiet = await pool(ITER, 1, (i) => report(small, `quiet-${i}`));
    const otherShard = await during(other, 'burst');
    // control: the same burst on another repo of the same org, so the same database
    const sameShard = await during(big, 'control');
    // each repo's report reads only its org's shard
    const events = async (slug) =>
      (await api('GET', `/repos/${slug}/usage`)).totals.events;
    return {
      [`${small}_events`]: await events(small),
      [`${other}_events`]: await events(other),
      quiet: summary(quiet.ms),
      burst_on_other_shard: otherShard,
      burst_on_same_shard: sameShard,
    };
  },
};

// --- main -----------------------------------------------------------------------------

work = await mkdtemp(join(tmpdir(), 'yag-load-'));
let stop = () => {};
try {
  if (opts.target === 'local') {
    const local = await startLocal(work, Number(opts.port));
    ({ url: base, token, stop } = local);
  } else {
    base = process.env.YAG_LOAD_URL ?? '';
    token = process.env.YAG_LOAD_TOKEN ?? '';
    if (!base || !token)
      throw new Error('set YAG_LOAD_URL and YAG_LOAD_TOKEN for a remote target');
  }
  const results = {
    target: opts.target === 'local' ? 'local wrangler dev' : base,
    measured_at: new Date().toISOString(),
    node: process.version,
    iterations: ITER,
    concurrency: CONC,
    scenarios: {},
  };
  for (const name of scenarios) {
    process.stderr.write(`scenario ${name}…\n`);
    const out = await run[name]();
    results.scenarios[name] = out.ms
      ? {
          ...summary(out.ms),
          ops_per_s: Math.round((out.ms.length / out.wall_ms) * 10000) / 10,
        }
      : out;
  }
  const json = JSON.stringify(results, null, 2);
  if (opts.out) await writeFile(opts.out, `${json}\n`);
  process.stdout.write(`${json}\n`);
} finally {
  stop();
  await rm(work, { recursive: true, force: true });
}
