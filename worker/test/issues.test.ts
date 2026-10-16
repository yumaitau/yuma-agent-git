import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { createApiToken } from '../src/auth/tokens';
import { cleanDb, loginAs, makeApp, seedSchema, type TestEnv } from './helpers';
import type { Env } from '../src/env';
import { createRepo, getRef, setRef } from '../src/db/repos';
import { commitChanges } from '../src/core/commit';
import { q, run } from '../src/db/client';
import type { Pull } from '../shared/collaboration';
import {
  blob,
  commit as gitCommit,
  packOf,
  parseReport,
  pushBody,
  tree,
  ZERO,
} from './git-helpers';
import type { Issue, IssueDetail, IssueTemplate } from '../shared/issues';

const testEnv = env as unknown as TestEnv;
type Actor = Awaited<ReturnType<typeof loginAs>>;
let owner: Actor;
let writer: Actor;
let triager: Actor;
let reader: Actor;
let stranger: Actor;
let repo: Awaited<ReturnType<typeof createRepo>>;
let base: string;
const author = { name: 'Ada', email: 'ada@example.com' };

async function commit(
  parent: string | null,
  message: string,
  files: Record<string, string> = { [`${message.length}-${Date.now()}.txt`]: 'x' },
): Promise<string> {
  return (
    await commitChanges(testEnv, repo.id, {
      first_parent: parent,
      message,
      author,
      changes: Object.entries(files).map(([path, text]) => ({
        path,
        op: 'add' as const,
        content_b64: btoa(text),
      })),
    })
  ).changeset.id;
}

async function call(
  actor: Actor | { headers: Record<string, string> } | null,
  method: string,
  tail: string,
  body?: unknown,
  slug = 'team/project',
  bindings: Env = testEnv,
): Promise<Response> {
  return makeApp(bindings)(
    new Request(`https://x/api/v1/repos/${slug}${tail}`, {
      method,
      headers: { ...(actor?.headers ?? {}), 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

async function json<T>(res: Response, status = 200): Promise<T> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  return JSON.parse(text) as T;
}

async function openIssue(
  title: string,
  extra: Record<string, unknown> = {},
): Promise<Issue> {
  return (
    await json<{ issue: Issue }>(
      await call(owner, 'POST', '/issues', { title, ...extra }),
      201,
    )
  ).issue;
}

async function detail(number: number, actor: Actor = owner): Promise<IssueDetail> {
  return json<IssueDetail>(await call(actor, 'GET', `/issues/${number}`));
}

async function member(user: Actor, role: string): Promise<void> {
  await run(testEnv, 'INSERT INTO repo_members (repo_id, user_id, role) VALUES (?,?,?)', [
    repo.id,
    user.userId,
    role,
  ]);
}

beforeEach(async () => {
  await seedSchema(testEnv);
  await cleanDb(testEnv);
  owner = await loginAs(testEnv, 801, 'owner');
  writer = await loginAs(testEnv, 802, 'writer');
  triager = await loginAs(testEnv, 803, 'triager');
  reader = await loginAs(testEnv, 804, 'reader');
  stranger = await loginAs(testEnv, 805, 'stranger');
  repo = await createRepo(testEnv, { slug: 'team/project', createdBy: owner.userId });
  await member(writer, 'write');
  await member(triager, 'triage');
  await member(reader, 'read');
  base = await commit(null, 'base');
  await setRef(testEnv, repo.id, 'main', base);
  for (const name of ['bug', 'ready']) {
    await json(await call(owner, 'POST', '/labels', { name, color: '#d74c2f' }), 201);
  }
});

describe('issues API', () => {
  it('creates, comments, labels, assigns, closes with a reason, reopens and locks', async () => {
    const created = await json<{ issue: Issue }>(
      await call(reader, 'POST', '/issues', {
        title: 'Crash on save',
        body: 'Steps',
        labels: ['bug'],
      }),
      201,
    );
    // a reader cannot label, so template labels are not applied
    expect(created.issue).toMatchObject({ number: 1, state: 'open', labels: [] });
    const n = created.issue.number;

    await json(
      await call(reader, 'POST', `/issues/${n}/comments`, { body: 'Me too' }),
      201,
    );
    expect(
      (await call(reader, 'PUT', `/issues/${n}/labels`, { labels: ['bug'] })).status,
    ).toBe(403);
    const labelled = await json<{ issue: Issue }>(
      await call(triager, 'PUT', `/issues/${n}/labels`, { labels: ['bug', 'ready'] }),
    );
    expect(labelled.issue.labels.map((l) => l.name)).toEqual(['bug', 'ready']);
    expect(
      (await call(triager, 'PUT', `/issues/${n}/labels`, { labels: ['nope'] })).status,
    ).toBe(400);
    const assigned = await json<{ issue: Issue }>(
      await call(triager, 'PUT', `/issues/${n}/assignees`, { assignees: ['writer'] }),
    );
    expect(assigned.issue.assignees).toEqual([`user:${writer.userId}`]);
    expect(
      (await call(triager, 'PUT', `/issues/${n}/assignees`, { assignees: ['stranger'] }))
        .status,
    ).toBe(400);

    const closed = await json<{ issue: Issue }>(
      await call(triager, 'PATCH', `/issues/${n}`, {
        state: 'closed',
        state_reason: 'not_planned',
      }),
    );
    expect(closed.issue).toMatchObject({ state: 'closed', state_reason: 'not_planned' });
    const reopened = await json<{ issue: Issue }>(
      await call(reader, 'PATCH', `/issues/${n}`, { state: 'open' }), // the author
    );
    expect(reopened.issue).toMatchObject({ state: 'open', state_reason: 'reopened' });
    expect((await call(stranger, 'PATCH', `/issues/${n}`, { title: 'x' })).status).toBe(
      404,
    );

    expect((await call(reader, 'PUT', `/issues/${n}/lock`, { on: true })).status).toBe(
      403,
    );
    await json(await call(triager, 'PUT', `/issues/${n}/lock`, { on: true }));
    expect(
      (await call(reader, 'POST', `/issues/${n}/comments`, { body: 'again' })).status,
    ).toBe(423);
    await json(await call(triager, 'POST', `/issues/${n}/comments`, { body: 'ok' }), 201);

    const view = await detail(n, reader);
    expect(view.issue.locked).toBe(true);
    expect(view.can_triage).toBe(false);
    expect(view.comments.map((c) => c.body)).toEqual(['Me too', 'ok']);
    expect(view.events.map((e) => e.kind)).toEqual([
      'labeled',
      'labeled',
      'assigned',
      'closed',
      'reopened',
      'locked',
    ]);
    expect(view.names[`user:${writer.userId}`]).toBe('writer');
    const audit = await q<{ action: string }>(
      testEnv,
      "SELECT action FROM audit_events WHERE action LIKE 'issue.%' ORDER BY id",
    );
    expect(audit.map((a) => a.action)).toContain('issue.create');
    expect(audit.map((a) => a.action)).toContain('issue.comment');
  });

  it('keeps the RBAC contract: 401 anonymous, 404 unreadable, 403 with denied_by', async () => {
    await openIssue('Private');
    expect((await call(null, 'GET', '/issues')).status).toBe(401);
    expect((await call(stranger, 'GET', '/issues')).status).toBe(404);
    expect((await call(stranger, 'GET', '/issues/1')).status).toBe(404);
    const denied = await call(reader, 'PUT', '/issues/1/pin', { on: true });
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: { code: string } }).error.code).toBe(
      'forbidden',
    );
    // triage cannot touch code or labels' definitions
    expect(
      (await call(triager, 'POST', '/labels', { name: 'x', color: '000000' })).status,
    ).toBe(403);
    expect(
      (await call(triager, 'PUT', '/refs/main', { from: base, to: base })).status,
    ).toBe(403);
  });

  it('lets an agent token of a triage user label but never write code', async () => {
    await openIssue('Agent work');
    const token = await createApiToken(testEnv, triager.userId, {
      label: 'agent',
      scopes: ['repo:read', 'repo:write'],
    });
    const bot = { headers: { authorization: `Bearer ${token.raw}` } };
    await json(await call(bot, 'PUT', '/issues/1/labels', { labels: ['ready'] }));
    await json(
      await call(owner, 'PUT', '/issues/1/assignees', {
        assignees: [`agent:${token.id}`],
      }),
    );
    const head = await commit(base, 'agent change');
    expect((await call(bot, 'PUT', '/refs/main', { from: base, to: head })).status).toBe(
      403,
    );
    const readOnly = await createApiToken(testEnv, reader.userId, {
      label: 'ro',
      scopes: ['repo:read'],
    });
    const ro = { headers: { authorization: `Bearer ${readOnly.raw}` } };
    await json(await call(ro, 'GET', '/issues/1'));
    expect((await call(ro, 'POST', '/issues/1/comments', { body: 'hi' })).status).toBe(
      403,
    );
  });

  it('assigns teams of the owning org only', async () => {
    const now = Date.now();
    await run(
      testEnv,
      "INSERT INTO orgs (id, slug, display_name, created_at) VALUES ('o1','yuma','Yuma',?),('o2','other','Other',?)",
      [now, now],
    );
    await run(
      testEnv,
      "INSERT INTO teams (id, org_id, slug, created_at) VALUES ('t1','o1','platform',?),('t2','o2','x',?)",
      [now, now],
    );
    const orgRepo = await createRepo(testEnv, {
      slug: 'yuma/app',
      createdBy: owner.userId,
      ownerKind: 'org',
      ownerId: 'o1',
    });
    expect(orgRepo.owner_kind).toBe('org');
    await json(
      await call(owner, 'POST', '/issues', { title: 'Team work' }, 'yuma/app'),
      201,
    );
    const res = await json<{ issue: Issue }>(
      await call(
        owner,
        'PUT',
        '/issues/1/assignees',
        { assignees: ['team:t1'] },
        'yuma/app',
      ),
    );
    expect(res.issue.assignees).toEqual(['team:t1']);
    expect(
      (
        await call(
          owner,
          'PUT',
          '/issues/1/assignees',
          { assignees: ['team:t2'] },
          'yuma/app',
        )
      ).status,
    ).toBe(400);
    const names = (
      await json<IssueDetail>(
        await call(owner, 'GET', '/issues/1', undefined, 'yuma/app'),
      )
    ).names;
    expect(names['team:t1']).toBe('yuma/platform');
  });

  it('filters by state, label, assignee and milestone with cursor pagination', async () => {
    const m = await json<{ milestone: { id: number } }>(
      await call(writer, 'POST', '/milestones', { title: 'v1' }),
      201,
    );
    for (let i = 1; i <= 5; i++) {
      await openIssue(`Issue ${i}`, {
        labels: i % 2 ? ['bug'] : [],
        assignees: i === 3 ? ['writer'] : [],
        milestone_id: i <= 2 ? m.milestone.id : null,
      });
    }
    await call(owner, 'PATCH', '/issues/5', { state: 'closed' });
    const list = async (query: string): Promise<number[]> =>
      (
        await json<{ issues: Issue[] }>(await call(owner, 'GET', `/issues?${query}`))
      ).issues.map((i) => i.number);
    expect(await list('')).toEqual([4, 3, 2, 1]);
    expect(await list('state=all&label=bug')).toEqual([5, 3, 1]);
    expect(await list('assignee=writer')).toEqual([3]);
    expect(await list('assignee=none&label=bug')).toEqual([1]);
    expect(await list(`milestone=${m.milestone.id}`)).toEqual([2, 1]);
    const page = await json<{ issues: Issue[]; next_cursor: number }>(
      await call(owner, 'GET', '/issues?state=all&limit=2'),
    );
    expect(page.issues.map((i) => i.number)).toEqual([5, 4]);
    expect(await list(`state=all&limit=2&before=${page.next_cursor}`)).toEqual([3, 2]);
    expect((await call(owner, 'GET', '/issues?label=missing')).status).toBe(400);
    const milestones = await json<{
      milestones: { open_issues: number; closed_issues: number }[];
    }>(await call(reader, 'GET', '/milestones'));
    expect(milestones.milestones[0]).toMatchObject({ open_issues: 2, closed_issues: 0 });
  });

  it('pins at most three issues and lists them first', async () => {
    for (let i = 1; i <= 4; i++) await openIssue(`Issue ${i}`);
    for (const n of [2, 3, 4])
      await json(await call(triager, 'PUT', `/issues/${n}/pin`, { on: true }));
    expect((await call(triager, 'PUT', '/issues/1/pin', { on: true })).status).toBe(409);
    const res = await json<{ pinned: Issue[] }>(await call(reader, 'GET', '/issues'));
    expect(res.pinned.map((i) => i.number)).toEqual([2, 3, 4]);
  });

  it('shows sub-issue progress and keeps their order', async () => {
    const parent = await openIssue('Epic');
    for (let i = 1; i <= 5; i++) await openIssue(`Child ${i}`, { parent: parent.number });
    for (const n of [2, 3, 4])
      await call(triager, 'PATCH', `/issues/${n}`, { state: 'closed' });
    const view = await detail(parent.number);
    expect(view.issue.sub_issues).toEqual({ total: 5, done: 3 });
    expect(view.sub_issues.map((s) => s.number)).toEqual([2, 3, 4, 5, 6]);
    await json(
      await call(triager, 'PUT', `/issues/${parent.number}/sub-issues`, {
        order: [6, 2, 5, 3, 4],
      }),
    );
    expect((await detail(parent.number)).sub_issues.map((s) => s.number)).toEqual([
      6, 2, 5, 3, 4,
    ]);
    expect(
      (await call(triager, 'PUT', `/issues/${parent.number}/sub-issues`, { order: [6] }))
        .status,
    ).toBe(400);
    // one parent per issue, never itself, and no cycles
    const other = await openIssue('Other');
    const add = async (to: number, number: number): Promise<number> =>
      (await call(triager, 'POST', `/issues/${to}/sub-issues`, { number })).status;
    expect(await add(other.number, 2)).toBe(409);
    expect(await add(1, 1)).toBe(400);
    expect(await add(2, 1)).toBe(409);
    expect(await add(2, other.number)).toBe(201);
    expect(await add(other.number, 1)).toBe(409);
    expect((await detail(other.number)).parent?.number).toBe(2);
    await json(await call(triager, 'DELETE', `/issues/${parent.number}/sub-issues/6`));
    expect((await detail(parent.number)).issue.sub_issues.total).toBe(4);
  });

  it('never gives an issue and a pull request the same number', async () => {
    const one = await openIssue('First');
    const head = await commit(base, 'change');
    const pull = await json<{ pull: Pull }>(
      await call(owner, 'POST', '/pulls', { title: 'PR', head_cs: head }),
      201,
    );
    const three = await openIssue('Third');
    expect([one.number, pull.pull.number, three.number]).toEqual([1, 2, 3]);
    const res = await call(owner, 'GET', '/issues/2');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      error: { code: 'pull_request', pull_id: pull.pull.id },
    });
    // a deleted issue's number is not reused
    await json(await call(owner, 'DELETE', `/issues/${three.number}`));
    expect((await openIssue('Fourth')).number).toBe(4);
  });

  it('reads Markdown templates and issue forms, honouring path rules', async () => {
    const head = await commit(base, 'templates', {
      '.yuma/ISSUE_TEMPLATE/bug.md':
        '---\nname: Bug report\nabout: Something broke\nlabels: bug, ready\ntitle: "[bug] "\n---\n## Steps\n',
      '.github/ISSUE_TEMPLATE/feature.yml': [
        'name: Feature',
        'description: Ask for something',
        'labels: [ready]',
        'body:',
        '  - type: textarea',
        '    id: why',
        '    attributes:',
        '      label: Why?',
        '    validations:',
        '      required: true',
        '  - type: dropdown',
        '    id: size',
        '    attributes:',
        '      label: Size',
        '      options: [S, M, L]',
      ].join('\n'),
      '.github/ISSUE_TEMPLATE/bug.md': '---\nname: Shadowed\n---\n',
      '.github/ISSUE_TEMPLATE/config.yml': 'blank_issues_enabled: false\n',
      '.github/ISSUE_TEMPLATE/broken.yml': 'name: [unclosed\n',
    });
    await setRef(testEnv, repo.id, 'main', head);
    const res = await json<{
      templates: IssueTemplate[];
      errors: { path: string }[];
    }>(await call(reader, 'GET', '/issue-templates'));
    expect(res.templates.map((t) => t.name)).toEqual(['Bug report', 'Feature']);
    expect(res.templates[0]).toMatchObject({
      labels: ['bug', 'ready'],
      title: '[bug] ',
      body: '## Steps\n',
    });
    expect(res.templates[1]!.fields).toMatchObject([
      { type: 'textarea', id: 'why', label: 'Why?', required: true },
      { type: 'dropdown', options: ['S', 'M', 'L'] },
    ]);
    expect(res.errors.map((e) => e.path)).toEqual(['.github/ISSUE_TEMPLATE/broken.yml']);
    await run(
      testEnv,
      `INSERT INTO path_rules (repo_id, path_prefix, effect, principal, perms)
       VALUES (?, '.github/', 'deny', ?, '["read"]')`,
      [repo.id, `user:${reader.userId}`],
    );
    const hidden = await json<{ templates: IssueTemplate[] }>(
      await call(reader, 'GET', '/issue-templates'),
    );
    expect(hidden.templates.map((t) => t.name)).toEqual(['Bug report']);
  });
});

describe('cross-references', () => {
  async function approveAndMerge(pull: Pull): Promise<Response> {
    await json(
      await call(writer, 'POST', `/pulls/${pull.id}/review`, {
        head_cs: pull.head_cs,
        decision: 'approve',
        body: '',
        revision: 1,
      }),
    );
    return call(owner, 'POST', `/pulls/${pull.id}/merge`, {
      head_cs: pull.head_cs,
      revision: 1,
    });
  }

  it('closes an issue named by "Closes #N" only when the PR merges to the default branch', async () => {
    const issue = await openIssue('Bug');
    const other = await openIssue('Mentioned');
    const head = await commit(base, 'Fix the crash');
    const pull = (
      await json<{ pull: Pull }>(
        await call(owner, 'POST', '/pulls', {
          title: 'Fix',
          body: `Closes #${issue.number}, see #${other.number}`,
          head_cs: head,
        }),
        201,
      )
    ).pull;
    expect((await detail(issue.number)).issue.state).toBe('open');
    expect((await detail(other.number)).events).toMatchObject([
      { kind: 'referenced', payload: { source: { kind: 'pull', ref: pull.number } } },
    ]);
    expect((await approveAndMerge(pull)).status).toBe(200);
    const closed = await detail(issue.number);
    expect(closed.issue).toMatchObject({ state: 'closed', state_reason: 'completed' });
    expect(closed.events.at(-1)).toMatchObject({ kind: 'closed' });
    expect((await detail(other.number)).issue.state).toBe('open');
    // path-restricted readers do not see pull request sources
    await run(
      testEnv,
      `INSERT INTO path_rules (repo_id, path_prefix, effect, principal, perms)
       VALUES (?, 'secret/', 'deny', ?, '["read"]')`,
      [repo.id, `user:${reader.userId}`],
    );
    expect((await detail(other.number, reader)).events).toEqual([]);
  });

  it('does not close when the pull targets a branch that is not the default', async () => {
    const issue = await openIssue('Bug');
    const head = await commit(base, 'Fix');
    const pull = (
      await json<{ pull: Pull }>(
        await call(owner, 'POST', '/pulls', {
          title: 'Fix',
          body: `Fixes #${issue.number}`,
          head_cs: head,
        }),
        201,
      )
    ).pull;
    await run(testEnv, "UPDATE repos SET default_branch = 'trunk' WHERE id = ?", [
      repo.id,
    ]);
    expect((await approveAndMerge(pull)).status).toBe(200);
    expect((await getRef(testEnv, repo.id, 'main'))?.head).toBe(head);
    expect((await detail(issue.number)).issue.state).toBe('open');
  });

  it('closes from commit messages that land on the default branch', async () => {
    const issue = await openIssue('Bug');
    const first = await commit(base, `Resolves #${issue.number}`);
    const second = await commit(first, 'Unrelated');
    await json(await call(owner, 'PUT', '/refs/feature', { from: null, to: second }));
    expect((await detail(issue.number)).issue.state).toBe('open');
    await json(await call(owner, 'PUT', '/refs/main', { from: base, to: second }));
    const view = await detail(issue.number);
    expect(view.issue.state).toBe('closed');
    expect(view.events.at(-1)).toMatchObject({
      kind: 'closed',
      payload: { source: { kind: 'changeset', ref: first } },
    });
  });

  it('links pushed commit messages on any branch and closes only on the default branch', async () => {
    const slug = 'team/pushed';
    await createRepo(testEnv, { slug, createdBy: owner.userId });
    const token = (
      await createApiToken(testEnv, owner.userId, {
        label: 'git',
        scopes: ['repo:read', 'repo:write'],
      })
    ).raw;
    async function push(old: string, message: string, ref: string, parents: string[]) {
      const file = await blob(message);
      const root = await tree([{ name: 'a.txt', sha: file.sha }]);
      const head = await gitCommit(root.sha, parents, `${message}\n`);
      const res = await makeApp(testEnv)(
        new Request(`https://x/${slug}.git/git-receive-pack`, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-git-receive-pack-request',
            authorization: `Basic ${btoa(`git:${token}`)}`,
          },
          body: pushBody([[old, head.sha, ref]], await packOf([head, root, file])),
        }),
      );
      expect(parseReport(new Uint8Array(await res.arrayBuffer())).refs[ref]).toBe('ok');
      return head.sha;
    }
    const issue = (
      await json<{ issue: Issue }>(
        await call(owner, 'POST', '/issues', { title: 'Bug' }, slug),
        201,
      )
    ).issue;
    const root = await push(ZERO, 'root', 'refs/heads/main', []);
    const fix = await push(ZERO, `Fixes #${issue.number}`, 'refs/heads/feature', [root]);
    const pushed = await json<IssueDetail>(
      await call(owner, 'GET', `/issues/${issue.number}`, undefined, slug),
    );
    expect(pushed.issue.state).toBe('open');
    expect(pushed.events).toMatchObject([
      { kind: 'referenced', payload: { source: { kind: 'changeset' } } },
    ]);
    // the same commit landing on main closes it, without a second reference
    const res = await makeApp(testEnv)(
      new Request(`https://x/${slug}.git/git-receive-pack`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-git-receive-pack-request',
          authorization: `Basic ${btoa(`git:${token}`)}`,
        },
        body: pushBody([[root, fix, 'refs/heads/main']], null),
      }),
    );
    expect(
      parseReport(new Uint8Array(await res.arrayBuffer())).refs['refs/heads/main'],
    ).toBe('ok');
    const landed = await json<IssueDetail>(
      await call(owner, 'GET', `/issues/${issue.number}`, undefined, slug),
    );
    expect(landed.issue.state).toBe('closed');
    expect(landed.events.map((e) => e.kind)).toEqual(['referenced', 'closed']);
  });

  it('records references from comments once, and skips repos the actor cannot read', async () => {
    const target = await openIssue('Target');
    const source = await openIssue('Source', { body: `Related to #${target.number}` });
    await call(owner, 'POST', `/issues/${source.number}/comments`, {
      body: `Again #${target.number} and \`#${target.number}\` in code`,
    });
    const events = (await detail(target.number)).events;
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toEqual({
      source: { kind: 'issue', repo: 'team/project', ref: source.number },
    });

    const secret = await createRepo(testEnv, {
      slug: 'team/secret',
      createdBy: owner.userId,
    });
    expect(secret.slug).toBe('team/secret');
    await json(
      await call(owner, 'POST', '/issues', { title: 'Hidden' }, 'team/secret'),
      201,
    );
    await call(reader, 'POST', `/issues/${source.number}/comments`, {
      body: 'Probing team/secret#1',
    });
    const hidden = await json<IssueDetail>(
      await call(owner, 'GET', '/issues/1', undefined, 'team/secret'),
    );
    expect(hidden.events).toEqual([]);
    // the owner can read both, so the cross-repo reference is recorded
    await call(owner, 'POST', `/issues/${source.number}/comments`, {
      body: 'Linked to team/secret#1',
    });
    expect(
      (
        await json<IssueDetail>(
          await call(owner, 'GET', '/issues/1', undefined, 'team/secret'),
        )
      ).events,
    ).toHaveLength(1);
  });
});

describe('issue list performance', () => {
  it('lists 10,000 issues with label filters in under 100 ms of D1 time', async () => {
    await run(
      testEnv,
      `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 10000)
       INSERT INTO issues (repo_id, number, title, body, state, author_id, created_at, updated_at)
       SELECT ?, x, 'Issue ' || x, '', CASE WHEN x % 4 = 0 THEN 'closed' ELSE 'open' END, ?, x, x
         FROM n`,
      [repo.id, owner.userId],
    );
    await run(
      testEnv,
      `INSERT INTO issue_labels (issue_id, label_id)
       SELECT i.id, l.id FROM issues i JOIN labels l ON l.repo_id = i.repo_id
        WHERE i.repo_id = ? AND ((l.name = 'bug' AND i.number % 7 = 0)
           OR (l.name = 'ready' AND i.number % 3 = 0))`,
      [repo.id],
    );
    await run(testEnv, 'INSERT INTO repo_counters VALUES (?, 10000)', [repo.id]);
    let d1 = 0;
    const timed = new Proxy(testEnv, {
      get(target, key) {
        if (key !== 'DB') return Reflect.get(target, key, target);
        return new Proxy(target.DB, {
          get(db, prop) {
            const value = Reflect.get(db, prop, db) as unknown;
            if (prop !== 'prepare')
              return typeof value === 'function' ? value.bind(db) : value;
            return (sql: string) => wrap(db.prepare(sql));
          },
        });
      },
    }) as TestEnv;
    function wrap(stmt: D1PreparedStatement): D1PreparedStatement {
      return new Proxy(stmt, {
        get(s, prop) {
          const value = Reflect.get(s, prop, s) as unknown;
          if (typeof value !== 'function') return value;
          if (prop === 'bind') return (...args: unknown[]) => wrap(s.bind(...args));
          if (prop === 'all' || prop === 'run')
            return async () => {
              // meta.duration is 0 in miniflare; time the round trip instead
              const started = performance.now();
              const result = await (value as () => Promise<D1Result>).call(s);
              d1 += performance.now() - started;
              return result;
            };
          return value.bind(s);
        },
      });
    }
    for (const query of ['label=bug', 'label=bug,ready', 'state=all&label=ready']) {
      d1 = 0;
      const res = await json<{ issues: Issue[]; next_cursor: number | null }>(
        await call(owner, 'GET', `/issues?${query}`, undefined, 'team/project', timed),
      );
      expect(res.issues).toHaveLength(50);
      expect(d1, query).toBeGreaterThan(0); // the probe measured the listing
      expect(d1, query).toBeLessThan(100);
    }
    const plan = await q<{ detail: string }>(
      testEnv,
      `EXPLAIN QUERY PLAN SELECT i.* FROM issues i WHERE i.repo_id = ? AND i.state = ?
         AND EXISTS (SELECT 1 FROM issue_labels il WHERE il.issue_id = i.id AND il.label_id = ?)
       ORDER BY i.number DESC LIMIT 51`,
      [repo.id, 'open', 1],
    );
    expect(plan.map((p) => p.detail).join('\n')).toMatch(/USING (COVERING )?INDEX/);
    expect(plan.map((p) => p.detail).join('\n')).not.toMatch(/TEMP B-TREE/);
  });
});
