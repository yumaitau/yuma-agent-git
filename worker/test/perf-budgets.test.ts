import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import {
  cleanDb,
  instrumentDb,
  instrumentObjects,
  loginAs,
  makeApp,
  seedSchema,
  type TestEnv,
} from './helpers';
import { commandBody } from './git-helpers';
import type { Env } from '../src/env';
import { createRepo, setRef } from '../src/db/repos';
import { commitChanges } from '../src/core/commit';
import { createApiToken } from '../src/auth/tokens';
import { commitShas } from '../src/git/upload-pack';

/**
 * Per-endpoint performance budgets (issue #78), run in CI with the rest of the
 * suite (`npm run bench:endpoints -w worker` runs it alone). Each endpoint
 * gets a budget of D1 statements and R2 calls per request, which is exact
 * and stable on any machine, and a generous p95 wall-clock budget over a few
 * runs in miniflare that only a large regression trips. Statements run
 * inside Durable Objects (the ref lock) are not counted. Raising a budget is
 * a reviewed change; see docs/performance.md.
 */

const testEnv = env as unknown as TestEnv;
const dbEnv = testEnv as unknown as Env;
const RUNS = 8;
const SLUG = 'acme/bench';

interface Budget {
  name: string;
  d1: number;
  r2: number;
  p95_ms: number;
  request: (i: number) => Request;
  status: number;
}

let token = '';
let head = '';
let sha = '';

function api(method: string, path: string, body?: unknown): Request {
  return new Request(`https://x/api/v1/repos/${SLUG}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const budgets: Budget[] = [
  {
    name: 'GET repo',
    d1: 6,
    r2: 0,
    p95_ms: 250,
    status: 200,
    request: () => api('GET', ''),
  },
  {
    name: 'GET tree',
    d1: 11,
    r2: 2,
    p95_ms: 250,
    status: 200,
    request: () => api('GET', `/tree?cs=${head}`),
  },
  {
    name: 'GET file',
    d1: 9,
    r2: 4,
    p95_ms: 250,
    status: 200,
    request: () => api('GET', `/file?cs=${head}&path=src/a.ts`),
  },
  {
    name: 'GET history',
    d1: 11,
    r2: 0,
    p95_ms: 250,
    status: 200,
    request: () => api('GET', '/history?cs=ref:main&limit=50'),
  },
  {
    name: 'POST changesets (commit RPC)',
    d1: 64,
    r2: 16,
    p95_ms: 500,
    status: 201,
    request: (i) =>
      api('POST', '/changesets', {
        first_parent: head,
        message: `bench ${i}\n`,
        author: { name: 'Ada', email: 'ada@example.com' },
        changes: [{ path: `bench/${i}.txt`, op: 'add', content_b64: btoa(`${i}\n`) }],
      }),
  },
  {
    name: 'GET usage report',
    d1: 11,
    r2: 0,
    p95_ms: 250,
    status: 200,
    request: () => api('GET', '/usage'),
  },
  {
    name: 'git ls-refs',
    d1: 9,
    r2: 0,
    p95_ms: 250,
    status: 200,
    request: () => git('ls-refs', ['symrefs', 'peel']),
  },
  {
    name: 'git fetch (clone)',
    d1: 12,
    r2: 7,
    p95_ms: 500,
    status: 200,
    request: () => git('fetch', [`want ${sha}`, 'done']),
  },
];

function git(command: string, args: string[]): Request {
  return new Request(`https://x/${SLUG}.git/git-upload-pack`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${btoa(`bench:${token}`)}`,
      'content-type': 'application/x-git-upload-pack-request',
      'git-protocol': 'version=2',
    },
    body: commandBody(command, args),
  });
}

describe('endpoint budgets (#78)', () => {
  beforeAll(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
    const owner = await loginAs(testEnv, 7804, 'owner');
    const repo = await createRepo(dbEnv, { slug: SLUG, createdBy: owner.userId });
    token = (await createApiToken(dbEnv, owner.userId, { label: 'bench' })).raw;
    const { changeset } = await commitChanges(dbEnv, repo.id, {
      first_parent: null,
      message: 'base\n',
      author: { name: 'Ada', email: 'ada@example.com' },
      changes: [
        { path: 'README.md', op: 'add', content_b64: btoa('hello\n') },
        { path: 'src/a.ts', op: 'add', content_b64: btoa('export const a = 1;\n') },
      ],
    });
    head = changeset.id;
    await setRef(dbEnv, repo.id, 'main', head);
    sha = (await commitShas(dbEnv, repo.id, [head])).get(head)!;
  });

  it.each(budgets)('$name stays within its budget', async (budget) => {
    const objects = instrumentObjects(testEnv);
    const db = instrumentDb(objects.env as TestEnv);
    const app = makeApp(db.env);
    const ms: number[] = [];
    let d1 = 0;
    let r2 = 0;
    for (let i = 0; i < RUNS; i++) {
      const r2Calls = () =>
        objects.gets.length + objects.puts.length + objects.heads.length;
      const before = [db.prepares.length, r2Calls()];
      const request = budget.request(i);
      const t = performance.now();
      const res = await app(request);
      await res.arrayBuffer();
      ms.push(performance.now() - t);
      expect(res.status, budget.name).toBe(budget.status);
      d1 = Math.max(d1, db.prepares.length - before[0]!);
      r2 = Math.max(r2, r2Calls() - before[1]!);
    }
    const p95 = [...ms].sort((a, b) => a - b)[Math.ceil(0.95 * ms.length) - 1]!;
    console.log(
      JSON.stringify({ bench: budget.name, d1, r2, p95_ms: Math.round(p95 * 10) / 10 }),
    );
    expect(d1, `${budget.name}: D1 statements`).toBeLessThanOrEqual(budget.d1);
    expect(r2, `${budget.name}: R2 calls`).toBeLessThanOrEqual(budget.r2);
    expect(p95, `${budget.name}: p95 ms`).toBeLessThanOrEqual(budget.p95_ms);
  });
});
