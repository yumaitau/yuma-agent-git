import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { cleanDb, loginAs, makeApp, seedSchema, type TestEnv } from './helpers';
import { createRepo, setRef } from '../src/db/repos';
import { commitChanges } from '../src/core/commit';
import { diffRevisions } from '../src/core/diff';
import { getBlob } from '../src/core/blobs';
import { createApiToken } from '../src/auth/tokens';
import { q, q1, run } from '../src/db/client';
import { parseSuggestion } from '../src/reviews/threads';
import type { Pull, ReviewRequest, ReviewThread } from '../shared/collaboration';

const testEnv = env as unknown as TestEnv;
const app = makeApp(testEnv);
type Login = Awaited<ReturnType<typeof loginAs>>;
let owner: Login;
let reviewer: Login;
let repo: Awaited<ReturnType<typeof createRepo>>;
let base: string;
let head: string;
const author = { name: 'Ada', email: 'ada@example.com' };
const PATH = 'src/app.ts';

/** `line 1\n` … `line 60\n`, with optional replacements by 1-based line number. */
function text(edits: Record<number, string> = {}, prefix: string[] = []): string {
  const lines = Array.from({ length: 60 }, (_, i) => edits[i + 1] ?? `line ${i + 1}`);
  return [...prefix, ...lines].map((l) => `${l}\n`).join('');
}

async function commit(
  parent: string | null,
  content: string,
  path = PATH,
): Promise<string> {
  return (
    await commitChanges(testEnv, repo.id, {
      first_parent: parent,
      message: 'change',
      author,
      changes: [{ path, op: parent ? 'mod' : 'add', content_b64: btoa(content) }],
    })
  ).changeset.id;
}

async function call(
  method: string,
  tail: string,
  body?: unknown,
  headers: Record<string, string> = owner.headers,
): Promise<Response> {
  return app(
    new Request(`https://x/api/v1/repos/team/project${tail}`, {
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

async function openPull(): Promise<Pull> {
  return (
    await json<{ pull: Pull }>(
      await call('POST', '/pulls', { title: 'Change', head_cs: head }),
      201,
    )
  ).pull;
}

async function current(pull: Pull): Promise<Pull> {
  return (await json<{ pull: Pull }>(await call('GET', `/pulls/${pull.id}`))).pull;
}

async function thread(
  pull: Pull,
  input: Record<string, unknown>,
  as: Login = reviewer,
): Promise<ReviewThread> {
  const now = await current(pull);
  return (
    await json<{ thread: ReviewThread }>(
      await call(
        'POST',
        `/pulls/${pull.id}/threads`,
        { path: PATH, head_cs: now.head_cs, revision: now.revision, ...input },
        as.headers,
      ),
      201,
    )
  ).thread;
}

async function threads(pull: Pull): Promise<ReviewThread[]> {
  return (
    await json<{ threads: ReviewThread[] }>(
      await call('GET', `/pulls/${pull.id}/threads`),
    )
  ).threads;
}

async function update(pull: Pull, headCs: string): Promise<void> {
  await json(await call('POST', `/pulls/${pull.id}/update`, { head_cs: headCs }));
}

async function approve(pull: Pull): Promise<Response> {
  const now = await current(pull);
  return call(
    'POST',
    `/pulls/${pull.id}/review`,
    { head_cs: now.head_cs, revision: now.revision, decision: 'approve', body: '' },
    reviewer.headers,
  );
}

async function merge(pull: Pull): Promise<Response> {
  const now = await current(pull);
  return call('POST', `/pulls/${pull.id}/merge`, {
    head_cs: now.head_cs,
    revision: now.revision,
  });
}

beforeEach(async () => {
  await seedSchema(testEnv);
  await cleanDb(testEnv);
  owner = await loginAs(testEnv, 801, 'owner');
  reviewer = await loginAs(testEnv, 802, 'reviewer');
  repo = await createRepo(testEnv, { slug: 'team/project', createdBy: owner.userId });
  await run(
    testEnv,
    "INSERT INTO repo_members(repo_id,user_id,role) VALUES (?,?,'write')",
    [repo.id, reviewer.userId],
  );
  base = await commit(null, text());
  await setRef(testEnv, repo.id, 'main', base);
  head = await commit(base, text({ 10: 'line ten' }));
});

describe('line-level review threads (#39)', () => {
  it('keeps a comment on line 42 on the same code after an unrelated change', async () => {
    const pull = await openPull();
    const t = await thread(pull, { line: 42, body: 'Why 42?' });
    expect(t).toMatchObject({
      side: 'head',
      start_line: 42,
      end_line: 42,
      outdated: false,
    });
    expect(t.snippet).toBe('line 42\n');

    // three new lines at the top shift line 42 to 45; the code itself is untouched
    const next = await commit(head, text({ 10: 'line ten' }, ['a', 'b', 'c']));
    await update(pull, next);
    const [moved] = await threads(pull);
    expect(moved).toMatchObject({
      start_line: 45,
      end_line: 45,
      outdated: false,
      anchor_cs: next,
      original_head_cs: head,
      revision: 2,
      snippet: 'line 42\n',
    });
  });

  it('marks a comment outdated when its line changes, and keeps it readable', async () => {
    const pull = await openPull();
    await thread(pull, { line: 42, start_line: 41, body: 'Rename these' });
    const untouched = await thread(pull, { line: 5, body: 'Fine' });
    const next = await commit(head, text({ 10: 'line ten', 42: 'line forty-two' }));
    await update(pull, next);
    const [old, kept] = await threads(pull);
    expect(old).toMatchObject({
      outdated: true,
      start_line: 41,
      end_line: 42,
      anchor_cs: head,
      revision: 1,
      snippet: 'line 41\nline 42\n',
    });
    expect(old!.comments[0]!.body).toBe('Rename these');
    expect(kept).toMatchObject({ id: untouched.id, outdated: false, start_line: 5 });
  });

  it('anchors base-side comments to the left of the diff and validates lines', async () => {
    const pull = await openPull();
    const t = await thread(pull, { side: 'base', line: 10, body: 'Old value' });
    expect(t).toMatchObject({ side: 'base', anchor_cs: base, snippet: 'line 10\n' });
    const now = await current(pull);
    const at = { path: PATH, head_cs: now.head_cs, revision: now.revision };
    const post = (body: Record<string, unknown>): Promise<Response> =>
      call('POST', `/pulls/${pull.id}/threads`, { ...at, ...body }, reviewer.headers);
    const beyond = await json<{ error: { code: string } }>(
      await post({ line: 61, body: 'x' }),
      400,
    );
    expect(beyond.error.code).toBe('invalid_anchor');
    expect((await post({ path: 'nope.ts', line: 1, body: 'x' })).status).toBe(400);
    const suggestion = await json<{ error: { code: string } }>(
      await post({ side: 'base', line: 1, body: '```suggestion\nx\n```' }),
      400,
    );
    expect(suggestion.error.code).toBe('invalid_suggestion');
    expect((await post({ line: 3, start_line: 4, body: 'backwards' })).status).toBe(400);
    const stale = await call(
      'POST',
      `/pulls/${pull.id}/threads`,
      { ...at, revision: 7, line: 1, body: 'x' },
      reviewer.headers,
    );
    expect(stale.status).toBe(409);
  });

  it('takes replies, resolves and unresolves, and audits each', async () => {
    const pull = await openPull();
    const t = await thread(pull, { line: 3, body: 'First' });
    const replied = await json<{ thread: ReviewThread }>(
      await call('POST', `/pulls/${pull.id}/threads/${t.id}/replies`, { body: 'Agreed' }),
      201,
    );
    expect(replied.thread.comments.map((c) => c.body)).toEqual(['First', 'Agreed']);
    expect(replied.thread.comments[1]!.author).toBe(`user:${owner.userId}`);
    const resolved = await json<{ thread: ReviewThread }>(
      await call('PUT', `/pulls/${pull.id}/threads/${t.id}/resolution`, {
        resolved: true,
      }),
    );
    expect(resolved.thread.resolved_by).toBe(`user:${owner.userId}`);
    expect(resolved.thread.resolved_at).toBeTypeOf('number');
    const reopened = await json<{ thread: ReviewThread }>(
      await call('PUT', `/pulls/${pull.id}/threads/${t.id}/resolution`, {
        resolved: false,
      }),
    );
    expect(reopened.thread.resolved_at).toBeNull();
    const actions = (
      await q<{ action: string }>(
        testEnv,
        "SELECT action FROM audit_events WHERE action LIKE 'pull.thread.%' ORDER BY rowid",
      )
    ).map((r) => r.action);
    expect(actions).toEqual([
      'pull.thread.create',
      'pull.thread.reply',
      'pull.thread.resolve',
      'pull.thread.unresolve',
    ]);
    expect(
      (await call('POST', `/pulls/${pull.id}/threads/999/replies`, { body: 'x' })).status,
    ).toBe(404);
    await json(await call('POST', `/pulls/${pull.id}/update`, { state: 'closed' }));
    expect(
      (await call('POST', `/pulls/${pull.id}/threads/${t.id}/replies`, { body: 'late' }))
        .status,
    ).toBe(409);
  });

  it('links issues that thread comments reference (#38 references)', async () => {
    await json(await call('POST', '/issues', { title: 'Tracked bug' }), 201);
    const pull = await openPull();
    await json(await call('POST', '/issues', { title: 'Second bug' }), 201);
    await thread(pull, { line: 3, body: 'See #1' });
    await json(
      await call(
        'POST',
        `/pulls/${pull.id}/review`,
        {
          head_cs: head,
          revision: 1,
          decision: 'comment',
          body: '',
          comments: [{ path: PATH, line: 4, body: 'And #3' }],
        },
        reviewer.headers,
      ),
    );
    const events = await q<{ issue_id: number; payload: string }>(
      testEnv,
      "SELECT issue_id, payload FROM issue_events WHERE kind = 'referenced' ORDER BY id",
    );
    expect(events).toHaveLength(2);
    for (const event of events)
      expect(JSON.parse(event.payload)).toEqual({
        source: { kind: 'pull', repo: 'team/project', ref: pull.number },
      });
  });
});

describe('suggested changes (#39)', () => {
  it('parses the first fenced suggestion block', () => {
    expect(parseSuggestion('Try:\r\n```suggestion\r\nconst x = 1;\r\n```\r\n')).toBe(
      'const x = 1;',
    );
    expect(parseSuggestion('```suggestion\n```')).toBe('');
    expect(parseSuggestion('```suggestion\nunclosed')).toBeNull();
    expect(parseSuggestion('```ts\nnot one\n```')).toBeNull();
  });

  it('applies a suggestion as a changeset equal to it and invalidates approvals', async () => {
    const pull = await openPull();
    const t = await thread(pull, {
      line: 21,
      start_line: 20,
      body: 'Simpler:\n```suggestion\nline twenty\n```',
    });
    expect(t.comments[0]!.suggestion_patch).toBe('line twenty');
    expect((await approve(pull)).status).toBe(200);

    const before = await current(pull);
    const applied = await json<{
      pull: Pull;
      changeset: { id: string; parents: string[] };
    }>(
      await call('POST', `/pulls/${pull.id}/suggestions/apply`, {
        comment_ids: [t.comments[0]!.id],
        head_cs: before.head_cs,
        revision: before.revision,
      }),
    );
    expect(applied.pull.head_cs).toBe(applied.changeset.id);
    expect(applied.pull.revision).toBe(before.revision + 1);
    expect(applied.changeset.parents).toEqual([before.head_cs]);

    const diff = await diffRevisions(
      testEnv,
      repo.id,
      before.head_cs,
      applied.changeset.id,
      {
        includeText: true,
      },
    );
    expect(diff.files.map((f) => [f.path, f.kind])).toEqual([[PATH, 'mod']]);
    expect(diff.texts?.[0]?.unified).toContain('-line 20\n-line 21\n+line twenty\n');
    const file = diff.files[0]!;
    const content = new TextDecoder().decode(
      (await getBlob(testEnv, repo.id, file.new_hash!))!.content,
    );
    expect(content).toBe(
      text({ 10: 'line ten' }).replace('line 20\nline 21\n', 'line twenty\n'),
    );

    // the approval was for the old revision
    const gate = await json<{ gate: { reasons: string[] } }>(
      await call('GET', `/pulls/${pull.id}`),
    );
    expect(gate.gate.reasons).toContain('1 approval required for this revision.');
    // the applied thread is resolved, and its lines changed
    const [after] = await threads(pull);
    expect(after).toMatchObject({ outdated: true });
    expect(after!.resolved_by).toBe(`user:${owner.userId}`);
    // applying again: the suggestion no longer matches the head
    const again = await json<{ error: { code: string } }>(
      await call('POST', `/pulls/${pull.id}/suggestions/apply`, {
        comment_ids: [t.comments[0]!.id],
        head_cs: applied.pull.head_cs,
        revision: applied.pull.revision,
      }),
      409,
    );
    expect(again.error.code).toBe('suggestion_outdated');
    const audit = await q1<{ target: string }>(
      testEnv,
      "SELECT target FROM audit_events WHERE action = 'pull.suggestion.apply'",
    );
    expect(JSON.parse(audit!.target)).toMatchObject({ changeset: applied.changeset.id });
  });

  it('applies several suggestions in one changeset and refuses overlaps', async () => {
    const pull = await openPull();
    const a = await thread(pull, { line: 2, body: '```suggestion\nTWO\n```' });
    const b = await thread(pull, { line: 50, body: '```suggestion\n```' });
    const c = await thread(pull, {
      line: 50,
      start_line: 49,
      body: '```suggestion\nX\n```',
    });
    const now = await current(pull);
    const ids = (...ts: ReviewThread[]): number[] => ts.map((t) => t.comments[0]!.id);
    const overlap = await json<{ error: { code: string } }>(
      await call('POST', `/pulls/${pull.id}/suggestions/apply`, {
        comment_ids: ids(b, c),
        head_cs: now.head_cs,
        revision: now.revision,
      }),
      400,
    );
    expect(overlap.error.code).toBe('suggestion_conflict');
    const applied = await json<{ changeset: { id: string } }>(
      await call('POST', `/pulls/${pull.id}/suggestions/apply`, {
        comment_ids: ids(a, b),
        head_cs: now.head_cs,
        revision: now.revision,
        message: 'Apply review',
      }),
    );
    const diff = await diffRevisions(
      testEnv,
      repo.id,
      now.head_cs,
      applied.changeset.id,
      {
        includeText: true,
      },
    );
    const unified = diff.texts![0]!.unified;
    expect(unified).toContain('-line 2\n+TWO\n');
    expect(unified).toContain('-line 50\n');
    expect(unified).not.toContain('+line 50');
  });
});

describe('review gate and batch reviews (#39)', () => {
  it('blocks merge on unresolved threads when the ruleset asks for it', async () => {
    await json(
      await call('POST', '/rulesets', {
        name: 'Conversations',
        target: 'branch',
        conditions: { ref_name: { include: ['~DEFAULT_BRANCH'] } },
        rules: [
          { type: 'pull_request', required_approvals: 1 },
          { type: 'required_review_thread_resolution' },
        ],
      }),
      201,
    );
    const pull = await openPull();
    const t = await thread(pull, { line: 7, body: 'Please fix' });
    expect((await approve(pull)).status).toBe(200);
    const detail = await json<{ gate: { mergeable: boolean; reasons: string[] } }>(
      await call('GET', `/pulls/${pull.id}`),
    );
    expect(detail.gate.mergeable).toBe(false);
    expect(detail.gate.reasons).toEqual(['Resolve 1 review thread before merging.']);
    expect((await merge(pull)).status).toBe(409);
    await json(
      await call('PUT', `/pulls/${pull.id}/threads/${t.id}/resolution`, {
        resolved: true,
      }),
    );
    expect((await merge(pull)).status).toBe(200);
  });

  it('lets unresolved threads through without the rule', async () => {
    const pull = await openPull();
    await thread(pull, { line: 7, body: 'Nit' });
    expect((await approve(pull)).status).toBe(200);
    expect((await merge(pull)).status).toBe(200);
  });

  it('takes a batch review with 20 inline comments from an agent token', async () => {
    const pull = await openPull();
    const delegate = await createApiToken(testEnv, reviewer.userId, {
      label: 'delegate',
      scopes: ['repo:read', 'repo:write', 'agent:run'],
    });
    const created = await json<{ id: string }>(
      await app(
        new Request('https://x/api/v1/agents', {
          method: 'POST',
          headers: { ...reviewer.headers, 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'Reviewer bot', kind: 'claude_code' }),
        }),
      ),
      201,
    );
    const exchange = async (scope: string): Promise<string> => {
      const form = new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        subject_token: delegate.raw,
        agent_id: created.id,
        resource: 'team/project',
        scope,
      });
      const res = await app(
        new Request('https://x/oauth/token', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: form,
        }),
      );
      return (await json<{ access_token: string }>(res)).access_token;
    };
    const token = await exchange('contents:write pulls:write');
    const bearer = { authorization: `Bearer ${token}` };
    await json(
      await call('PUT', `/pulls/${pull.id}/reviewers`, {
        reviewers: [`agent:${created.id}`],
      }),
    );
    const comments = Array.from({ length: 20 }, (_, i) => ({
      path: PATH,
      line: i + 1,
      body: `Finding ${i + 1}`,
    }));
    const res = await json<{ ok: boolean; comments: number }>(
      await call(
        'POST',
        `/pulls/${pull.id}/review`,
        {
          head_cs: head,
          revision: 1,
          decision: 'request_changes',
          body: 'See inline',
          comments,
        },
        bearer,
      ),
    );
    expect(res.comments).toBe(20);
    const all = await threads(pull);
    expect(all).toHaveLength(20);
    expect(all.every((t) => t.author === `agent:${created.id}`)).toBe(true);
    const review = await q1<{ id: number }>(
      testEnv,
      'SELECT id FROM pull_reviews WHERE pull_id = ?',
      [pull.id],
    );
    expect(new Set(all.map((t) => t.comments[0]!.review_id))).toEqual(
      new Set([review!.id]),
    );
    const requests = await json<{ review_requests: ReviewRequest[] }>(
      await call('GET', `/pulls/${pull.id}/reviewers`),
    );
    expect(requests.review_requests).toMatchObject([
      { principal: `agent:${created.id}`, state: 'reviewed' },
    ]);

    // a bad anchor refuses the whole batch
    const bad = await call(
      'POST',
      `/pulls/${pull.id}/review`,
      {
        head_cs: head,
        revision: 1,
        decision: 'comment',
        body: '',
        comments: [...comments, { path: PATH, line: 999, body: 'x' }],
      },
      bearer,
    );
    expect(bad.status).toBe(400);
    expect(await threads(pull)).toHaveLength(20);

    // agents need pulls:write to start threads
    const writer = { authorization: `Bearer ${await exchange('contents:write')}` };
    const scoped = await call(
      'POST',
      `/pulls/${pull.id}/threads`,
      { path: PATH, line: 1, body: 'x', head_cs: head, revision: 1 },
      writer,
    );
    expect(scoped.status).toBe(403);
    expect(((await scoped.json()) as { error: { code: string } }).error.code).toBe(
      'insufficient_scope',
    );
  });
});

describe('review requests (#39)', () => {
  it('requests people and teams and marks them reviewed', async () => {
    const now = Date.now();
    await run(
      testEnv,
      "INSERT INTO orgs (id, slug, display_name, created_at) VALUES ('o1','team','Team',?)",
      [now],
    );
    await run(
      testEnv,
      "INSERT INTO teams (id, org_id, slug, created_at) VALUES ('t1','o1','core',?)",
      [now],
    );
    await run(testEnv, "INSERT INTO team_members (team_id, user_id) VALUES ('t1', ?)", [
      reviewer.userId,
    ]);
    await run(
      testEnv,
      "UPDATE repos SET owner_kind = 'org', owner_id = 'o1' WHERE id = ?",
      [repo.id],
    );
    const pull = await openPull();
    const set = await json<{
      review_requests: ReviewRequest[];
      names: Record<string, string>;
    }>(
      await call('PUT', `/pulls/${pull.id}/reviewers`, {
        reviewers: ['reviewer', 'team:t1'],
      }),
    );
    expect(set.review_requests.map((r) => [r.principal, r.state]).sort()).toEqual([
      ['team:t1', 'pending'],
      [`user:${reviewer.userId}`, 'pending'],
    ]);
    expect(set.names).toMatchObject({
      [`user:${reviewer.userId}`]: 'reviewer',
      'team:t1': 'team/core',
    });
    const self = await json<{ error: { code: string } }>(
      await call('PUT', `/pulls/${pull.id}/reviewers`, { reviewers: ['owner'] }),
      400,
    );
    expect(self.error.code).toBe('invalid_reviewer');
    expect(
      (await call('PUT', `/pulls/${pull.id}/reviewers`, { reviewers: ['nobody'] }))
        .status,
    ).toBe(400);

    expect((await approve(pull)).status).toBe(200);
    const after = await json<{ review_requests: ReviewRequest[] }>(
      await call('GET', `/pulls/${pull.id}/reviewers`),
    );
    expect(after.review_requests.every((r) => r.state === 'reviewed')).toBe(true);
    // dropping a reviewer removes the request
    const dropped = await json<{ review_requests: ReviewRequest[] }>(
      await call('PUT', `/pulls/${pull.id}/reviewers`, { reviewers: ['team:t1'] }),
    );
    expect(dropped.review_requests.map((r) => r.principal)).toEqual(['team:t1']);
    expect(
      await q1(
        testEnv,
        "SELECT 1 FROM audit_events WHERE action = 'pull.reviewers.update'",
      ),
    ).not.toBeNull();
  });

  it('hides threads from callers path rules restrict', async () => {
    const pull = await openPull();
    await thread(pull, { line: 3, body: 'x' });
    await run(
      testEnv,
      `INSERT INTO path_rules (repo_id, path_prefix, effect, principal, perms) VALUES (?, 'secret/', 'deny', ?, '["read"]')`,
      [repo.id, `user:${reviewer.userId}`],
    );
    const res = await call(
      'GET',
      `/pulls/${pull.id}/threads`,
      undefined,
      reviewer.headers,
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'whole_repository_required',
    );
  });
});
