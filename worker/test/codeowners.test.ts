import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { cleanDb, loginAs, makeApp, seedSchema, type TestEnv } from './helpers';
import { createRepo, setRef } from '../src/db/repos';
import { commitChanges } from '../src/core/commit';
import { getChangeset } from '../src/core/changesets';
import { resolvePath } from '../src/core/trees';
import { createApiToken } from '../src/auth/tokens';
import { q1, run } from '../src/db/client';
import {
  MAX_CODEOWNERS_BYTES,
  ownersOf,
  parseCodeowners,
  patternMatches,
} from '../src/reviews/codeowners';
import type {
  Codeowners,
  Pull,
  PullCodeowners,
  ReviewRequest,
} from '../shared/collaboration';

const testEnv = env as unknown as TestEnv;
const app = makeApp(testEnv);
type Login = Awaited<ReturnType<typeof loginAs>>;
const author = { name: 'Ada', email: 'ada@example.com' };

describe('CODEOWNERS parser (#40)', () => {
  it('keeps valid lines and reports the ones GitHub skips', () => {
    const { rules, errors } = parseCodeowners(
      [
        '# Owners',
        '',
        '*       @global  # trailing comment',
        '\\#notes @ada',
        '/docs/  docs@example.com @acme/docs',
        '/vendor/',
        '!keep.md @ada',
        '*.[ch]  @ada',
        'src/    not-an-owner',
        'bots/   @agent:reviewer-bot\r',
      ].join('\n'),
    );
    expect(rules.map((r) => [r.line, r.pattern, r.owners.map((o) => o.raw)])).toEqual([
      [3, '*', ['@global']],
      [4, '#notes', ['@ada']],
      [5, '/docs/', ['docs@example.com', '@acme/docs']],
      [6, '/vendor/', []],
      [10, 'bots/', ['@agent:reviewer-bot']],
    ]);
    expect(errors.map((e) => [e.line, e.column, e.kind])).toEqual([
      [7, 1, 'invalid_pattern'],
      [8, 1, 'invalid_pattern'],
      [9, 9, 'invalid_owner'],
    ]);
    expect(errors[2]!.source).toBe('src/    not-an-owner');
  });

  it('matches paths as GitHub does', () => {
    const cases: [string, string, boolean][] = [
      ['*', 'a/b/c.txt', true],
      ['*.js', 'app.js', true],
      ['*.js', 'src/deep/app.js', true],
      ['*.js', 'app.ts', false],
      ['/build/logs/', 'build/logs/a.log', true],
      ['/build/logs/', 'build/logs/deep/a.log', true],
      ['/build/logs/', 'x/build/logs/a.log', false],
      ['docs/*', 'docs/getting-started.md', true],
      ['docs/*', 'docs/build-app/troubleshooting.md', false],
      ['apps/', 'apps/x.ts', true],
      ['apps/', 'src/apps/y/z.ts', true],
      ['apps/', 'apps', false],
      ['/docs/', 'src/docs/a.md', false],
      ['**/logs', 'logs/a', true],
      ['**/logs', 'build/logs/a', true],
      ['**/logs', 'deep/x/logs', true],
      ['/apps/github', 'apps/github', true],
      ['/apps/github', 'apps/github/x.ts', true],
      ['/apps/github', 'apps/githubx', false],
      ['a/**/b', 'a/b', true],
      ['a/**/b', 'a/x/y/b', true],
      ['a/**/b', 'a/x/c', false],
      ['src/pay?.ts', 'src/pay1.ts', true],
      ['src/pay?.ts', 'src/pay/.ts', false],
    ];
    for (const [pattern, path, want] of cases)
      expect(patternMatches(pattern, path), `${pattern} ~ ${path}`).toBe(want);
  });

  it('gives a path to the last matching rule, and a rule with no owners unowns it', () => {
    const codeowners = {
      rules: [
        { line: 1, pattern: '*', owners: ['user:a'] },
        { line: 2, pattern: '/src/', owners: ['team:t'] },
        { line: 3, pattern: '/src/generated/', owners: [] },
      ],
    };
    expect(ownersOf(codeowners, 'README.md')).toEqual(['user:a']);
    expect(ownersOf(codeowners, 'src/app.ts')).toEqual(['team:t']);
    expect(ownersOf(codeowners, 'src/generated/api.ts')).toEqual([]);
  });
});

describe('CODEOWNERS on pull requests (#40)', () => {
  let owner: Login;
  let dev: Login;
  let ada: Login;
  let payer: Login;
  let repo: Awaited<ReturnType<typeof createRepo>>;

  async function call(
    method: string,
    tail: string,
    body?: unknown,
    headers: Record<string, string> = owner.headers,
  ): Promise<Response> {
    return app(
      new Request(`https://x/api/v1${tail}`, {
        method,
        headers: { ...headers, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  }

  async function json<T>(res: Response, status = 200): Promise<T> {
    const body = (await res.json()) as T;
    expect(res.status, JSON.stringify(body)).toBe(status);
    return body;
  }

  async function commit(
    parent: string | null,
    files: Record<string, string | null>,
  ): Promise<string> {
    const root = parent
      ? (await getChangeset(testEnv, repo.id, parent))?.root_tree
      : null;
    const existing = new Set<string>();
    for (const path of Object.keys(files))
      if (root && (await resolvePath(testEnv, repo.id, root, path.split('/'))))
        existing.add(path);
    return (
      await commitChanges(testEnv, repo.id, {
        first_parent: parent,
        message: 'change',
        author,
        changes: Object.entries(files).map(([path, content]) =>
          content === null
            ? { path, op: 'del' as const }
            : {
                path,
                op: existing.has(path) ? ('mod' as const) : ('add' as const),
                content_b64: btoa(content),
              },
        ),
      })
    ).changeset.id;
  }

  async function openPull(head: string, draft = false): Promise<Pull> {
    return (
      await json<{ pull: Pull }>(
        await call(
          'POST',
          '/repos/acme/shop/pulls',
          { title: 'Change', head_cs: head, draft },
          dev.headers,
        ),
        201,
      )
    ).pull;
  }

  async function requests(pull: Pull): Promise<ReviewRequest[]> {
    return (
      await json<{ review_requests: ReviewRequest[] }>(
        await call('GET', `/repos/acme/shop/pulls/${pull.id}/reviewers`),
      )
    ).review_requests;
  }

  async function gate(pull: Pull): Promise<{ mergeable: boolean; reasons: string[] }> {
    return (
      await json<{ gate: { mergeable: boolean; reasons: string[] } }>(
        await call('GET', `/repos/acme/shop/pulls/${pull.id}`),
      )
    ).gate;
  }

  async function approve(pull: Pull, headers: Record<string, string>): Promise<void> {
    const now = (
      await json<{ pull: Pull }>(await call('GET', `/repos/acme/shop/pulls/${pull.id}`))
    ).pull;
    await json(
      await call(
        'POST',
        `/repos/acme/shop/pulls/${pull.id}/review`,
        { head_cs: now.head_cs, revision: now.revision, decision: 'approve', body: '' },
        headers,
      ),
    );
  }

  async function requireOwners(): Promise<void> {
    await json(
      await call('POST', '/repos/acme/shop/rulesets', {
        name: 'Owners',
        target: 'branch',
        conditions: { ref_name: { include: ['~DEFAULT_BRANCH'] } },
        rules: [{ type: 'require_code_owner_review' }],
      }),
      201,
    );
  }

  /** An acme agent identity, delegated by ada (an org admin), and a token for it. */
  async function reviewerAgent(): Promise<{
    id: string;
    bearer: Record<string, string>;
  }> {
    const delegate = await createApiToken(testEnv, ada.userId, {
      label: 'delegate',
      scopes: ['repo:read', 'repo:write', 'agent:run'],
    });
    const created = await json<{ id: string }>(
      await call(
        'POST',
        '/agents',
        { name: 'reviewer-bot', kind: 'claude_code', org: 'acme' },
        ada.headers,
      ),
      201,
    );
    const form = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      subject_token: delegate.raw,
      agent_id: created.id,
      resource: 'acme/shop',
      scope: 'contents:write pulls:write',
    });
    const token = await json<{ access_token: string }>(
      await app(
        new Request('https://x/oauth/token', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: form,
        }),
      ),
    );
    return { id: created.id, bearer: { authorization: `Bearer ${token.access_token}` } };
  }

  const CODEOWNERS = [
    '# Owners for the shop',
    '*.md                @ada',
    '/src/payments/      @acme/payments',
    '/bots/              @agent:reviewer-bot',
    '/legacy/            @nobody',
    '*.[ch]              @ada',
  ].join('\n');

  let base: string;

  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
    owner = await loginAs(testEnv, 901, 'owner');
    dev = await loginAs(testEnv, 902, 'dev');
    ada = await loginAs(testEnv, 903, 'ada');
    payer = await loginAs(testEnv, 904, 'payer');
    const now = Date.now();
    await run(
      testEnv,
      "INSERT INTO orgs (id, slug, display_name, created_at) VALUES ('o1','acme','Acme',?)",
      [now],
    );
    await run(
      testEnv,
      "INSERT INTO teams (id, org_id, slug, created_at) VALUES ('t1','o1','payments',?)",
      [now],
    );
    await run(testEnv, "INSERT INTO team_members (team_id, user_id) VALUES ('t1', ?)", [
      payer.userId,
    ]);
    await run(
      testEnv,
      "INSERT INTO org_members (org_id, user_id, role) VALUES ('o1', ?, 'admin')",
      [ada.userId],
    );
    repo = await createRepo(testEnv, { slug: 'acme/shop', createdBy: owner.userId });
    await run(
      testEnv,
      "UPDATE repos SET owner_kind = 'org', owner_id = 'o1' WHERE id = ?",
      [repo.id],
    );
    await run(
      testEnv,
      "INSERT INTO team_repos (team_id, repo_id, role) VALUES ('t1', ?, 'write')",
      [repo.id],
    );
    for (const who of [dev, ada])
      await run(
        testEnv,
        "INSERT INTO repo_members (repo_id, user_id, role) VALUES (?, ?, 'write')",
        [repo.id, who.userId],
      );
    base = await commit(null, {
      '.github/CODEOWNERS': CODEOWNERS,
      'README.md': 'hello\n',
      'src/payments/pay.ts': 'pay\n',
      'src/other.ts': 'other\n',
    });
    await setRef(testEnv, repo.id, 'main', base);
  });

  it('surfaces the file, resolved owners and validation errors', async () => {
    // a same-named personal agent cannot take the org agent's place
    await json(
      await call(
        'POST',
        '/agents',
        { name: 'reviewer-bot', kind: 'claude_code' },
        dev.headers,
      ),
      201,
    );
    const agent = await reviewerAgent();
    const res = await json<
      Codeowners & { owners: string[]; names: Record<string, string> }
    >(await call('GET', '/repos/acme/shop/codeowners?path=src/payments/pay.ts'));
    expect(res.file).toBe('.github/CODEOWNERS');
    expect(res.revision).toBe(base);
    expect(res.owners).toEqual(['team:t1']);
    expect(res.rules.map((r) => [r.pattern, r.owners])).toEqual([
      ['*.md', [`user:${ada.userId}`]],
      ['/src/payments/', ['team:t1']],
      ['/bots/', [`agent:${agent.id}`]],
      ['/legacy/', []],
    ]);
    expect(res.names).toMatchObject({
      [`user:${ada.userId}`]: 'ada',
      'team:t1': 'acme/payments',
    });
    expect(res.errors.map((e) => [e.line, e.kind])).toEqual([
      [5, 'unknown_owner'],
      [6, 'invalid_pattern'],
    ]);
    expect(res.errors[0]!.source).toBe('/legacy/            @nobody');
    // whole-repository read, like the other review routes
    const stranger = await loginAs(testEnv, 905, 'stranger');
    expect(
      (await call('GET', '/repos/acme/shop/codeowners', undefined, stranger.headers))
        .status,
    ).toBe(404);
  });

  it('requests owners when a pull request opens', async () => {
    const head = await commit(base, {
      'README.md': 'changed\n',
      'src/payments/pay.ts': 'pay more\n',
      'src/other.ts': 'other 2\n',
    });
    const pull = await openPull(head);
    const reqs = await requests(pull);
    expect(reqs.map((r) => [r.principal, r.requested_by, r.state]).sort()).toEqual([
      ['team:t1', 'codeowners', 'pending'],
      [`user:${ada.userId}`, 'codeowners', 'pending'],
    ]);
    const audit = await q1<{ target: string }>(
      testEnv,
      "SELECT target FROM audit_events WHERE action = 'pull.reviewers.update'",
    );
    expect(JSON.parse(audit!.target)).toMatchObject({ via: 'codeowners', removed: [] });
    const owned = await json<PullCodeowners & { names: Record<string, string> }>(
      await call('GET', `/repos/acme/shop/pulls/${pull.id}/codeowners`),
    );
    expect(owned.files).toEqual([
      { path: 'README.md', owners: [`user:${ada.userId}`], approved: false },
      { path: 'src/other.ts', owners: [], approved: true },
      { path: 'src/payments/pay.ts', owners: ['team:t1'], approved: false },
    ]);
    // no reviewer-bot agent exists in this test, so its line reports too
    expect(owned.errors.map((e) => e.line)).toEqual([4, 5, 6]);
  });

  it('never requests the author', async () => {
    // dev owns the README; dev's own pull request requests nobody for it
    const own = await commit(base, { '.github/CODEOWNERS': '*.md @dev\n' });
    await setRef(testEnv, repo.id, 'main', own);
    base = own;
    const pull = await openPull(await commit(own, { 'README.md': 'x\n' }));
    expect(await requests(pull)).toEqual([]);
  });

  it('blocks the merge until an owner of every owned file approves', async () => {
    await requireOwners();
    const head = await commit(base, {
      'README.md': 'changed\n',
      'src/payments/pay.ts': 'pay more\n',
      'src/other.ts': 'other 2\n',
    });
    const pull = await openPull(head);
    expect((await gate(pull)).reasons).toEqual([
      '1 approval required for this revision.',
      'Code owner approval required for README.md, src/payments/pay.ts.',
    ]);
    await approve(pull, ada.headers);
    expect((await gate(pull)).reasons).toEqual([
      'Code owner approval required for src/payments/pay.ts.',
    ]);
    const merge = async () =>
      call('POST', `/repos/acme/shop/pulls/${pull.id}/merge`, {
        head_cs: head,
        revision: 1,
      });
    expect((await merge()).status).toBe(409);
    // a member of @acme/payments stands for the team
    await approve(pull, payer.headers);
    expect(await gate(pull)).toMatchObject({ mergeable: true, reasons: [] });
    expect((await merge()).status).toBe(200);
  });

  it('reads owners from the target, so a pull request cannot drop its own', async () => {
    await requireOwners();
    const head = await commit(base, {
      '.github/CODEOWNERS': '# nobody owns anything\n',
      'src/payments/pay.ts': 'free money\n',
    });
    const pull = await openPull(head);
    await approve(pull, ada.headers);
    expect((await gate(pull)).reasons).toEqual([
      'Code owner approval required for src/payments/pay.ts.',
    ]);
  });

  it('requests owners when a draft is ready and when new paths arrive', async () => {
    const agent = await reviewerAgent();
    const head = await commit(base, { 'src/payments/pay.ts': 'v2\n' });
    const pull = await openPull(head, true);
    expect(await requests(pull)).toEqual([]);
    await json(
      await call(
        'POST',
        `/repos/acme/shop/pulls/${pull.id}/update`,
        { state: 'open' },
        dev.headers,
      ),
    );
    expect((await requests(pull)).map((r) => r.principal)).toEqual(['team:t1']);
    const next = await commit(head, { 'bots/run.ts': 'bot\n' });
    await json(
      await call(
        'POST',
        `/repos/acme/shop/pulls/${pull.id}/update`,
        { head_cs: next },
        dev.headers,
      ),
    );
    expect((await requests(pull)).map((r) => r.principal).sort()).toEqual(
      [`agent:${agent.id}`, 'team:t1'].sort(),
    );
  });

  it('lets only the agent satisfy an agent owner', async () => {
    await requireOwners();
    const agent = await reviewerAgent();
    const head = await commit(base, { 'bots/run.ts': 'bot\n' });
    const pull = await openPull(head);
    await approve(pull, ada.headers);
    // ada delegates to the agent, but her own approval is not the agent's
    expect((await gate(pull)).reasons).toEqual([
      'Code owner approval required for bots/run.ts.',
    ]);
    await approve(pull, agent.bearer);
    expect(
      await q1(testEnv, 'SELECT agent_id FROM pull_reviews WHERE agent_id IS NOT NULL'),
    ).toEqual({ agent_id: agent.id });
    expect(await gate(pull)).toMatchObject({ mergeable: true });
  });

  it('prefers .yuma/CODEOWNERS, finds docs/CODEOWNERS and ignores files over 3 MB', async () => {
    const both = await commit(base, { '.yuma/CODEOWNERS': '* @ada\n' });
    const read = async (rev: string) =>
      json<Codeowners>(await call('GET', `/repos/acme/shop/codeowners?rev=${rev}`));
    expect((await read(both)).file).toBe('.yuma/CODEOWNERS');
    const docs = await commit(both, {
      '.yuma/CODEOWNERS': null,
      '.github/CODEOWNERS': null,
      'docs/CODEOWNERS': '* @ada\n',
    });
    expect(await read(docs)).toMatchObject({ file: 'docs/CODEOWNERS', errors: [] });
    const huge = await commit(docs, {
      'docs/CODEOWNERS': `* @ada\n${'#'.repeat(MAX_CODEOWNERS_BYTES)}\n`,
    });
    const big = await read(huge);
    expect(big.rules).toEqual([]);
    expect(big.errors.map((e) => e.kind)).toEqual(['too_large']);
    expect((await read('main')).file).toBe('.github/CODEOWNERS');
    expect((await call('GET', '/repos/acme/shop/codeowners?rev=nope')).status).toBe(404);
  });
});
