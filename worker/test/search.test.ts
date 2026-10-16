import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import {
  cleanDb,
  instrumentObjects,
  instrumentQueues,
  loginAs,
  makeApp,
  seedSchema,
  type TestEnv,
} from './helpers';
import { createRepo, setRef } from '../src/db/repos';
import { commitChanges } from '../src/core/commit';
import { q, q1, run } from '../src/db/client';
import {
  peekDerived,
  DerivedDeferredError,
  type DerivedMessage,
} from '../src/core/derived';
import { derivedQueue } from '../src/queues/derived';
import {
  CODE_SEARCH,
  indexBlobs,
  languageOf,
  syncSnapshot,
  trigrams,
} from '../src/core/derived/codeSearch';
import { compileQuery, requiredLiterals } from '../src/core/search';
import { linearMatcher, MatchBudgetError } from '../src/core/linear-regex';
import { executeTool, type ToolCtx } from '../src/agents/tools';
import { newBudget } from '../src/agents/budget';
import type { Principal } from '../src/auth/principal';

const testEnv = env as unknown as TestEnv;
const dbEnv = testEnv as unknown as Env;
const app = makeApp(testEnv);
const author = { name: 'Ada', email: 'ada@example.com' };
const b64 = (s: string): string => btoa(s);

type Login = Awaited<ReturnType<typeof loginAs>>;
let ada: Login;
let bob: Login;

interface Hit {
  repo: string;
  path: string;
  lang: string | null;
  cs: string;
  matches: { line: number; text: string; ranges: [number, number][] }[];
}
interface CodeBody {
  results: Hit[];
  truncated: boolean;
  partial: boolean;
  skipped_repos: unknown[];
}

async function get(path: string, as: Login | null = ada): Promise<Response> {
  return app(new Request(`https://x${path}`, { headers: as ? as.headers : {} }));
}

async function search(
  params: Record<string, string>,
  as: Login = ada,
): Promise<CodeBody> {
  const res = await get(`/api/v1/search/code?${new URLSearchParams(params)}`, as);
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as CodeBody;
}

async function seedRepo(
  slug: string,
  files: Record<string, string>,
  opts: { visibility?: 'public' | 'private'; createdBy?: string } = {},
): Promise<{ id: string; cs: string }> {
  const repo = await createRepo(dbEnv, {
    slug,
    visibility: opts.visibility ?? 'private',
    createdBy: opts.createdBy ?? ada.userId,
  });
  const committed = await commitChanges(dbEnv, repo.id, {
    first_parent: null,
    message: 'seed',
    author,
    changes: Object.entries(files).map(([path, text]) => ({
      path,
      op: 'add' as const,
      content_b64: b64(text),
    })),
  });
  await setRef(dbEnv, repo.id, 'main', committed.changeset.id);
  return { id: repo.id, cs: committed.changeset.id };
}

async function commitOn(
  repoId: string,
  parent: string,
  changes: { path: string; op: 'add' | 'mod' | 'del'; text?: string }[],
  probeEnv: Env = dbEnv,
): Promise<string> {
  const res = await commitChanges(probeEnv, repoId, {
    first_parent: parent,
    message: 'change',
    author,
    changes: changes.map((c) =>
      c.op === 'del'
        ? { path: c.path, op: 'del' as const }
        : { path: c.path, op: c.op, content_b64: b64(c.text ?? '') },
    ),
  });
  return res.changeset.id;
}

function batchOf(messages: DerivedMessage[]): MessageBatch<DerivedMessage> {
  return {
    queue: 'derived-data',
    messages: messages.map((body, i) => ({
      id: String(i),
      timestamp: new Date(),
      body,
      attempts: 1,
      ack: () => {},
      retry: () => {},
    })),
    retryAll: () => {},
    ackAll: () => {},
  } as unknown as MessageBatch<DerivedMessage>;
}

async function denyRead(repoId: string, prefix: string, principal = '*'): Promise<void> {
  await run(
    dbEnv,
    `INSERT INTO path_rules (repo_id, path_prefix, effect, principal, perms)
     VALUES (?, ?, 'deny', ?, ?)`,
    [repoId, prefix, principal, JSON.stringify(['read'])],
  );
}

beforeEach(async () => {
  await seedSchema(testEnv);
  await cleanDb(testEnv);
  ada = await loginAs(testEnv, 1, 'ada');
  bob = await loginAs(testEnv, 2, 'bob');
});

describe('code search index', () => {
  it('derives trigrams, languages and the literals a regex requires', () => {
    expect([...trigrams('AbcD\nxy')].sort()).toEqual(['abc', 'bcd']);
    expect(languageOf('src/app.tsx')).toBe('typescript');
    expect(languageOf('Dockerfile')).toBe('dockerfile');
    expect(languageOf('LICENSE')).toBeNull();
    expect(requiredLiterals('fooBar\\(x+\\)')).toEqual(['fooBar(x']);
    expect(requiredLiterals('handle(Request|Response)Body')).toEqual([]);
    expect(requiredLiterals('colou?r_name')).toEqual(['colo', 'r_name']);
    expect(requiredLiterals('get[A-Z]\\w+Async')).toEqual(['get', 'Async']);
    expect(requiredLiterals('(optional)?required')).toEqual(['required']);
    expect(
      compileQuery({ q: 'a.b', regex: false, caseSensitive: false }).matcher.test('a.b'),
    ).toBe(true);
  });

  it('a one-file changeset indexes one blob', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 6; i++) files[`src/f${i}.ts`] = `export const v${i} = ${i};\n`;
    const { id, cs } = await seedRepo('acme/incr', files);
    expect(await q(dbEnv, 'SELECT blob_hash FROM search_blobs')).toHaveLength(6);

    const objects = instrumentObjects(testEnv);
    const queues = instrumentQueues(objects.env as TestEnv);
    const next = await commitOn(
      id,
      cs,
      [{ path: 'src/f3.ts', op: 'mod', text: 'export const renamed = 3;\n' }],
      queues.env,
    );
    // indexed in the commit path, reading exactly the one new blob
    expect(JSON.parse(String(await peekDerived(dbEnv, id, CODE_SEARCH, next)))).toEqual({
      indexed: 1,
      known: 0,
    });
    expect(
      queues.sends.filter((s) => (s.body as DerivedMessage).kind === CODE_SEARCH),
    ).toEqual([]);
    // (Git IDs read the same blob; no other blob is touched)
    expect(new Set(objects.gets.filter((k) => k.includes('/blobs/'))).size).toBe(1);
    expect(await q(dbEnv, 'SELECT blob_hash FROM search_blobs')).toHaveLength(7);

    // re-adding content some changeset already indexed reads nothing
    const again = await commitOn(id, next, [
      { path: 'copy.ts', op: 'add', text: 'export const v1 = 1;\n' },
    ]);
    expect(JSON.parse(String(await peekDerived(dbEnv, id, CODE_SEARCH, again)))).toEqual({
      indexed: 0,
      known: 1,
    });
  });

  it('defers large changes to the queue and keeps progress past the byte budget', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 12; i++) files[`f${i}.txt`] = `needle ${i}\n`;
    const repo = await createRepo(dbEnv, { slug: 'acme/big', createdBy: ada.userId });
    const queues = instrumentQueues(testEnv);
    const res = await commitChanges(queues.env, repo.id, {
      first_parent: null,
      message: 'many files',
      author,
      changes: Object.entries(files).map(([path, text]) => ({
        path,
        op: 'add' as const,
        content_b64: b64(text),
      })),
    });
    const queued = queues.sends
      .map((s) => s.body as DerivedMessage)
      .filter((m) => m.kind === CODE_SEARCH);
    expect(queued).toEqual([
      { repo_id: repo.id, kind: CODE_SEARCH, cs_id: res.changeset.id },
    ]);
    expect(await q(dbEnv, 'SELECT blob_hash FROM search_blobs')).toHaveLength(0);

    // a tiny budget stores what fits, then asks for another run
    const items = res.changeset.changed_files.map((f) => ({ hash: f.hash as string }));
    await expect(indexBlobs(dbEnv, repo.id, items, 20)).rejects.toBeInstanceOf(
      DerivedDeferredError,
    );
    const partial = (await q(dbEnv, 'SELECT blob_hash FROM search_blobs')).length;
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(12);

    await derivedQueue(batchOf(queued), dbEnv);
    expect(await q(dbEnv, 'SELECT blob_hash FROM search_blobs')).toHaveLength(12);
  });

  it('follows the default branch by tree diff and compacts dropped blobs', async () => {
    const { id, cs } = await seedRepo('acme/move', {
      'a.txt': 'old unicorn text\n',
      'b.txt': 'stays here\n',
    });
    await syncSnapshot(dbEnv, { id, default_branch: 'main' });
    const oldHash = (
      await q1<{ blob_hash: string }>(
        dbEnv,
        "SELECT blob_hash FROM search_files WHERE repo_id = ? AND path = 'a.txt'",
        [id],
      )
    )?.blob_hash;
    const next = await commitOn(id, cs, [
      { path: 'a.txt', op: 'mod', text: 'new pegasus text\n' },
    ]);
    await setRef(dbEnv, id, 'main', next);

    expect((await search({ q: 'pegasus' })).results.map((r) => r.path)).toEqual([
      'a.txt',
    ]);
    expect((await search({ q: 'unicorn' })).results).toEqual([]);
    expect(
      await q1(dbEnv, 'SELECT cs_id, files FROM search_repos WHERE repo_id = ?', [id]),
    ).toEqual({ cs_id: next, files: 2 });
    // the old blob left every file list: its postings are gone
    expect(
      await q(dbEnv, 'SELECT gram FROM search_trigrams WHERE blob_hash = ?', [oldHash]),
    ).toEqual([]);
    // …but a search at the old revision still finds it by reading the blob
    const old = await search({ q: 'unicorn', repo: 'acme/move', rev: cs });
    expect(old.results).toMatchObject([{ path: 'a.txt', cs }]);
  });
});

describe('GET /api/v1/search/code', () => {
  it('searches every readable repo with highlights and filters', async () => {
    await seedRepo('acme/api', {
      'src/server.ts': 'const port = 8080;\nexport function startServer() {}\n',
      'docs/guide.md': 'Call startServer to begin.\n',
    });
    await seedRepo('acme/web', { 'app/main.py': 'def start_server():\n    pass\n' });
    await seedRepo(
      'bob/secret',
      { 'x.ts': 'startServer()\n' },
      { createdBy: bob.userId },
    );

    const all = await search({ q: 'startserver' });
    expect(all.results.map((r) => `${r.repo}:${r.path}`)).toEqual([
      'acme/api:docs/guide.md',
      'acme/api:src/server.ts',
    ]);
    const hit = all.results[1] as Hit;
    expect(hit.lang).toBe('typescript');
    expect(hit.matches).toEqual([
      { line: 2, text: 'export function startServer() {}', ranges: [[16, 27]] },
    ]);

    expect((await search({ q: 'startserver', case: '1' })).results).toEqual([]);
    expect((await search({ q: 'startServer', lang: 'markdown' })).results).toHaveLength(
      1,
    );
    expect((await search({ q: 'startServer', path: 'src/' })).results).toHaveLength(1);
    expect((await search({ q: 'startServer', path: '**/*.md' })).results).toHaveLength(1);
    expect(
      (await search({ q: 'start_?server', regex: '1' })).results
        .map((r) => r.repo)
        .sort(),
    ).toEqual(['acme/api', 'acme/api', 'acme/web']);
    expect((await search({ q: 'start', repo: 'acme/web' })).results).toHaveLength(1);
    // bob sees his own repo only
    expect((await search({ q: 'startServer' }, bob)).results.map((r) => r.repo)).toEqual([
      'bob/secret',
    ]);
  });

  it('documents and enforces regex limits', async () => {
    await seedRepo('acme/re', { 'a.txt': 'alpha beta\ngamma\n' });
    const bad = async (params: Record<string, string>): Promise<string> => {
      const res = await get(`/api/v1/search/code?${new URLSearchParams(params)}`);
      expect(res.status).toBe(400);
      return ((await res.json()) as { error: { code: string } }).error.code;
    };
    expect(await bad({ q: '(unclosed', regex: '1' })).toBe('invalid_pattern');
    expect(await bad({ q: 'a(?=b)', regex: '1' })).toBe('invalid_pattern');
    expect(await bad({ q: '(a)\\1', regex: '1' })).toBe('invalid_pattern');
    expect(await bad({ q: '.*', regex: '1' })).toBe('invalid_pattern');
    expect(await bad({ q: 'x'.repeat(201) })).toBe('invalid_request');
    // alternation has no required literal: matched by reading every file
    expect(
      (await search({ q: 'beta|gamma', regex: '1' })).results[0]?.matches.map(
        (m) => m.line,
      ),
    ).toEqual([1, 2]);
  });

  it('matches backtracking patterns in linear time', async () => {
    const line = `${'a'.repeat(999)}!`; // within the 1000 characters matched
    await seedRepo('acme/redos', { 'a.txt': `${line}\n${'a'.repeat(30)}\n` });
    const started = Date.now();
    // RegExp backtracks for seconds to years on the first line; none match it
    for (const [q, want] of [
      ['((a+))+$', [2]],
      ['(a|aa)+$', [2]],
      ['(a*)*b', []],
      ['.*.*.*.*x', []],
      ['(\\w+\\s?)+$', [2]],
    ] as const) {
      const found = await search({ q, regex: '1', repo: 'acme/redos' });
      expect(
        found.results.flatMap((r) => r.matches.map((m) => m.line)),
        q,
      ).toEqual(want);
    }
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('finds the same matches as RegExp', () => {
    const lines = [
      'const fooBar = startServer(port, { host: "0.0.0.0" });',
      'if (x <= 10 && y >= 2) return a_b + c$d;',
      'Hello, World!  tabs\there\u00e9 [brackets] {braces} a|b',
      'aaa bbb aaab abab ba',
      '',
    ];
    const patterns = [
      'start_?[sS]erver',
      '\\bfoo\\w*',
      '[A-Z][a-z]+',
      '\\d+(\\.\\d+)*',
      '(a|ab)(c|bcd)?',
      'a+?b',
      'a{2,3}',
      'b{2}',
      '[^\\s\\w]+',
      '\\$\\w',
      '^const|;$',
      '\\[\\w+\\]',
      '\\{braces}',
      'a\\|b',
      '(?:ab)+',
      '\\x41|\\u00e9',
      '[\\d.]+',
      '\\B\\w\\b',
      '(?<word>W\\w+)',
      '[a-c-]{3,}',
    ];
    for (const p of patterns) {
      for (const ci of [false, true]) {
        const expected = new RegExp(p, `g${ci ? 'i' : ''}`);
        const matcher = linearMatcher(p, ci);
        for (const line of lines) {
          const want = [...line.matchAll(expected)]
            .filter((m) => m[0].length > 0)
            .map((m) => [m.index, m.index + m[0].length]);
          expect(matcher.ranges(line, 100), `${p} on ${line}`).toEqual(want);
          expect(matcher.test(line), `${p} on ${line}`).toBe(
            new RegExp(p, ci ? 'i' : '').test(line),
          );
        }
      }
    }
  });

  it('stops matching when the search spends its budget', () => {
    const matcher = linearMatcher('(a|b)*c', false, { steps: 1000 });
    expect(() => matcher.test('ab'.repeat(500))).toThrow(MatchBudgetError);
  });

  it('never returns files a deny path rule hides', async () => {
    const { id } = await seedRepo(
      'acme/mono',
      {
        'public/a.txt': 'shared token here\n',
        'secret/key.txt': 'shared token secret\n',
      },
      { visibility: 'public' },
    );
    await denyRead(id, 'secret/');
    for (const as of [ada, bob]) {
      const body = await search({ q: 'shared token' }, as);
      expect(body.results.map((r) => r.path)).toEqual(['public/a.txt']);
      const regex = await search({ q: 'shared.*', regex: '1', repo: 'acme/mono' }, as);
      expect(regex.results.map((r) => r.path)).toEqual(['public/a.txt']);
      const paths = await get('/api/v1/search/paths?q=key', as);
      expect(((await paths.json()) as { files: unknown[] }).files).toEqual([]);
    }
  });

  it('answers 401, 404 and 400 like the rest of the API', async () => {
    const { cs } = await seedRepo('acme/err', { 'a.txt': 'x\n' });
    expect((await get('/api/v1/search/code?q=x', null)).status).toBe(401);
    expect((await get('/api/v1/search/code?q=xyz&repo=acme/err', bob)).status).toBe(404);
    expect((await get('/api/v1/search/code?q=xyz&repo=acme/none')).status).toBe(404);
    expect((await get(`/api/v1/search/code?q=xyz&rev=${cs}`)).status).toBe(400);
    expect((await get('/api/v1/search/code?q=xyz&repo=acme/err&rev=nope')).status).toBe(
      404,
    );
    expect((await get('/api/v1/search/code')).status).toBe(400);
  });

  it('searches any revision: an older changeset and a branch', async () => {
    const { id, cs } = await seedRepo('acme/revs', { 'a.txt': 'first draft\n' });
    const branch = await commitOn(id, cs, [
      { path: 'b.txt', op: 'add', text: 'branch only feature\n' },
    ]);
    await setRef(dbEnv, id, 'feature', branch);
    expect((await search({ q: 'feature' })).results).toEqual([]);
    const onBranch = await search({ q: 'feature', repo: 'acme/revs', rev: 'feature' });
    expect(onBranch.results).toMatchObject([{ path: 'b.txt', cs: branch }]);
    const atRoot = await search({ q: 'draft', repo: 'acme/revs', rev: cs });
    expect(atRoot.results).toMatchObject([{ path: 'a.txt', cs }]);
  });

  it('finds content the queue has not indexed yet, then backfills it', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 20; i++) files[`f${i}.txt`] = `filler ${i}\n`;
    files['z.txt'] = 'the rare walrus\n';
    const { id, cs } = await seedRepo('acme/lag', files); // over the commit-path bound
    expect(await q(dbEnv, 'SELECT blob_hash FROM search_blobs')).toHaveLength(0);
    const probe = instrumentQueues(testEnv);
    const res = await makeApp(probe.env)(
      new Request('https://x/api/v1/search/code?q=walrus', { headers: ada.headers }),
    );
    const body = (await res.json()) as CodeBody;
    expect(body.results.map((r) => r.path)).toEqual(['z.txt']);
    expect(body.partial).toBe(false);

    // the new file list asked the queue to index what it holds
    const backfill = probe.sends
      .map((s) => s.body as DerivedMessage)
      .filter((m) => m.kind === CODE_SEARCH);
    expect(backfill).toEqual([{ repo_id: id, kind: CODE_SEARCH, cs_id: `full:${cs}` }]);
    await derivedQueue(batchOf(backfill), dbEnv);
    expect(await q(dbEnv, 'SELECT blob_hash FROM search_blobs')).toHaveLength(21);
    expect((await search({ q: 'walrus' })).results.map((r) => r.path)).toEqual(['z.txt']);
  });

  it('literal search across 50 repos answers under 1 s at p95', async () => {
    for (let r = 0; r < 50; r++) {
      const files: Record<string, string> = {};
      for (let f = 0; f < 6; f++) {
        files[`src/mod${f}.ts`] =
          `// repo ${r} module ${f}\nexport function handler${f}() {\n  return 'value-${r}-${f}';\n}\n`;
      }
      if (r % 10 === 0)
        files['src/special.ts'] = `export const marker = 'zebracorn ${r}';\n`;
      await seedRepo(`load/r${String(r).padStart(2, '0')}`, files, {
        visibility: 'public',
      });
    }
    await search({ q: 'zebracorn' }); // first search builds the 50 file lists
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const started = performance.now();
      const body = await search({ q: i % 2 === 0 ? 'zebracorn' : 'handler3' });
      times.push(performance.now() - started);
      expect(body.results.length).toBe(i % 2 === 0 ? 5 : 50);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.ceil(times.length * 0.95) - 1] as number;
    expect(p95).toBeLessThan(1000);
  });
});

describe('GET /api/v1/search/paths', () => {
  it('finds files by the characters of their path, best first', async () => {
    await seedRepo('acme/finder', {
      'src/components/Button.tsx': 'x\n',
      'src/button/index.ts': 'x\n',
      'docs/buttons-and-more.md': 'x\n',
      'lib/b_u_t_t_o_n.js': 'x\n',
    });
    const res = await get('/api/v1/search/paths?q=button');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { files: { path: string }[] };
    expect(body.files.map((f) => f.path)).toEqual([
      'src/components/Button.tsx',
      'docs/buttons-and-more.md',
      'src/button/index.ts',
      'lib/b_u_t_t_o_n.js',
    ]);
    const ts = (await (
      await get('/api/v1/search/paths?q=btn&lang=typescript')
    ).json()) as {
      files: { path: string }[];
    };
    expect(ts.files.map((f) => f.path).sort()).toEqual([
      'src/button/index.ts',
      'src/components/Button.tsx',
    ]);
  });
});

describe('agent grep tool', () => {
  it('finds matches in large repos past the old 500-path candidate cap', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 600; i++)
      files[`pkg/${String(i).padStart(3, '0')}.txt`] = `row ${i}\n`;
    files['zz/last.txt'] = 'needle in the haystack\n';
    files['secret/k.txt'] = 'needle hidden\n';
    const { id, cs } = await seedRepo('acme/large', files);
    await denyRead(id, 'secret/');
    const ctx: ToolCtx = {
      repo_id: id,
      principal: { kind: 'user', userId: ada.userId } as Principal,
      base_cs: cs,
      head_cs: cs,
      budget: newBudget(),
      task_id: 'task-search',
    };
    const out = await executeTool(dbEnv, ctx, 'grep', { pattern: 'needle' });
    expect(out.matches).toEqual([
      { path: 'zz/last.txt', line: 1, text: 'needle in the haystack' },
    ]);
    expect(await executeTool(dbEnv, ctx, 'grep', { pattern: 'a(?=b)' })).toMatchObject({
      error: 'invalid_pattern',
    });
  });
});

describe('query plans', () => {
  it('probes postings and file lists by key', async () => {
    const plans: [string, unknown[]][] = [
      [
        'SELECT COUNT(*) FROM search_trigrams t WHERE t.blob_hash = ? AND t.gram IN (SELECT value FROM json_each(?))',
        ['b', '["abc","bcd"]'],
      ],
      [
        'SELECT f.path FROM search_files f WHERE f.repo_id IN (SELECT value FROM json_each(?)) AND substr(f.path, 1, ?) = ?',
        ['["r"]', 2, 'sr'],
      ],
      ['SELECT 1 FROM search_files WHERE blob_hash = ?', ['b']],
    ];
    for (const [sql, params] of plans) {
      const rows = await q<{ detail: string }>(
        dbEnv,
        `EXPLAIN QUERY PLAN ${sql}`,
        params,
      );
      const detail = rows.map((r) => r.detail).join(' | ');
      expect(detail, sql).toMatch(/USING (COVERING )?(INDEX|PRIMARY KEY)/);
      expect(detail, sql).not.toMatch(/^SCAN /);
    }
  });
});
