import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { Octokit } from '@octokit/rest';
import { createApiToken } from '../src/auth/tokens';
import { createRepo, setRef } from '../src/db/repos';
import { commitChanges } from '../src/core/commit';
import { run } from '../src/db/client';
import { C, T } from '../src/db/schema';
import { parsePathRuleInput } from '../src/auth/rbac';
import type { Env } from '../src/env';
import { cleanDb, loginAs, makeApp, seedSchema, type TestEnv } from './helpers';

const testEnv = env as unknown as TestEnv;
type Actor = Awaited<ReturnType<typeof loginAs>>;
/** CI enabled with the queue and runner stubbed, so opening a pull request queues a check. */
const ciEnv: Env = new Proxy(testEnv, {
  get(target, key, receiver) {
    if (key === 'CI_ENABLED') return 'true';
    if (key === 'CI_QUEUE') return { send: async () => {} };
    if (key === 'CI_RUNNER')
      return {
        idFromName: (id: string) => id,
        get: () => ({ fetch: async () => Response.json({ ok: true }) }),
      };
    return Reflect.get(target, key, receiver);
  },
});
const app = makeApp(ciEnv);
const author = { name: 'Ada', email: 'ada@example.com' };
let owner: Actor;
let reader: Actor;
let ownerToken: string;
let readerToken: string;
let repo: Awaited<ReturnType<typeof createRepo>>;
let base: string;
let head: string;

async function commit(
  parent: string | null,
  path: string,
  text: string,
): Promise<string> {
  return (
    await commitChanges(testEnv, repo.id, {
      first_parent: parent,
      message: `add ${path}`,
      author,
      changes: [{ path, op: 'add', content_b64: btoa(text) }],
    })
  ).changeset.id;
}

/** Octokit as a tool would use it: base URL change and a token, nothing else. */
function octokit(token: string | null, baseUrl = 'https://forge.test/api/github/v3') {
  return new Octokit({
    baseUrl,
    ...(token ? { auth: token } : {}),
    request: {
      fetch: (url: string, init: RequestInit) => app(new Request(url, init)),
    },
  });
}

async function call(
  method: string,
  path: string,
  token: string | null,
  body?: unknown,
): Promise<Response> {
  return app(
    new Request(`https://forge.test${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `token ${token}` } : {}),
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

beforeEach(async () => {
  await seedSchema(testEnv);
  await cleanDb(testEnv);
  owner = await loginAs(testEnv, 7401, 'owner');
  reader = await loginAs(testEnv, 7402, 'reader');
  ownerToken = (await createApiToken(testEnv, owner.userId, { label: 'gh' })).raw;
  readerToken = (await createApiToken(testEnv, reader.userId, { label: 'gh' })).raw;
  repo = await createRepo(testEnv, { slug: 'team/project', createdBy: owner.userId });
  await run(testEnv, 'INSERT INTO repo_members (repo_id, user_id, role) VALUES (?,?,?)', [
    repo.id,
    reader.userId,
    'read',
  ]);
  base = await commit(null, 'README.md', '# Project\n');
  await setRef(testEnv, repo.id, 'main', base);
  head = await commit(base, 'src/app.ts', 'export {};\n');
  await setRef(testEnv, repo.id, 'feature', head);
});

describe('GitHub REST compatibility (Octokit)', () => {
  it('creates and lists issues, comments and labels', async () => {
    const gh = octokit(ownerToken);
    await gh.rest.issues.createLabel({
      owner: 'team',
      repo: 'project',
      name: 'bug',
      color: 'd73a4a',
    });
    const created = await gh.rest.issues.create({
      owner: 'team',
      repo: 'project',
      title: 'Crash on save',
      body: 'Steps',
      labels: ['bug'],
    });
    expect(created.status).toBe(201);
    expect(created.data).toMatchObject({
      number: 1,
      state: 'open',
      title: 'Crash on save',
      user: { login: 'owner', type: 'User' },
      labels: [{ name: 'bug', color: 'd73a4a' }],
      html_url: 'https://forge.test/r/team/project/issues/1',
    });
    expect(typeof created.data.id).toBe('number');
    expect(created.data.node_id).toBeTruthy();

    await gh.rest.issues.createComment({
      owner: 'team',
      repo: 'project',
      issue_number: 1,
      body: 'Me too',
    });
    const comments = await gh.rest.issues.listComments({
      owner: 'team',
      repo: 'project',
      issue_number: 1,
    });
    expect(comments.data.map((x) => x.body)).toEqual(['Me too']);

    const listed = await gh.rest.issues.listForRepo({ owner: 'team', repo: 'project' });
    expect(listed.data.map((i) => i.number)).toEqual([1]);

    const closed = await gh.rest.issues.update({
      owner: 'team',
      repo: 'project',
      issue_number: 1,
      state: 'closed',
      state_reason: 'not_planned',
    });
    expect(closed.data).toMatchObject({ state: 'closed', state_reason: 'not_planned' });
    expect(
      (await gh.rest.issues.listForRepo({ owner: 'team', repo: 'project' })).data,
    ).toEqual([]);
    const all = await gh.rest.issues.listForRepo({
      owner: 'team',
      repo: 'project',
      state: 'all',
    });
    expect(all.data).toHaveLength(1);

    const search = await gh.rest.search.issuesAndPullRequests({
      q: 'repo:team/project is:issue is:closed crash',
    });
    expect(search.data.items.map((i) => i.number)).toEqual([1]);
  });

  it('creates a pull request, posts a review, reads check runs and merges', async () => {
    const gh = octokit(ownerToken);
    // a CI policy so opening the pull request queues a check for its head
    const policy = await call('PUT', '/api/v1/repos/team/project/ci', ownerToken, {
      commands: ['npm test'],
      timeout_seconds: 60,
      required_approvals: 0,
    });
    expect(policy.status, await policy.text()).toBe(200);

    const pull = await gh.rest.pulls.create({
      owner: 'team',
      repo: 'project',
      title: 'Add app',
      head: 'feature',
      base: 'main',
      body: 'Adds the app',
    });
    expect(pull.status).toBe(201);
    expect(pull.data).toMatchObject({
      number: 1,
      state: 'open',
      title: 'Add app',
      head: { ref: expect.any(String) },
      base: { ref: 'main', repo: { full_name: 'team/project' } },
    });
    const sha = pull.data.head.sha;
    expect(sha).toMatch(/^[0-9a-f]{40}$/);

    const listed = await gh.rest.pulls.list({ owner: 'team', repo: 'project' });
    expect(listed.data.map((p) => p.number)).toEqual([1]);
    const got = await gh.rest.pulls.get({
      owner: 'team',
      repo: 'project',
      pull_number: 1,
    });
    expect(got.data.head.sha).toBe(sha);

    const review = await gh.rest.pulls.createReview({
      owner: 'team',
      repo: 'project',
      pull_number: 1,
      event: 'COMMENT',
      body: 'Looks fine',
      commit_id: sha,
    });
    expect(review.data).toMatchObject({
      state: 'COMMENTED',
      body: 'Looks fine',
      commit_id: sha,
      user: { login: 'owner' },
    });
    const reviews = await gh.rest.pulls.listReviews({
      owner: 'team',
      repo: 'project',
      pull_number: 1,
    });
    expect(reviews.data).toHaveLength(1);

    const checks = await gh.rest.checks.listForRef({
      owner: 'team',
      repo: 'project',
      ref: sha,
    });
    expect(checks.data.total_count).toBe(1);
    expect(checks.data.check_runs[0]).toMatchObject({
      name: 'ci',
      head_sha: sha,
      status: 'queued',
      conclusion: null,
    });
    const status = await gh.rest.repos.getCombinedStatusForRef({
      owner: 'team',
      repo: 'project',
      ref: 'feature',
    });
    expect(status.data).toMatchObject({ state: 'pending', sha, total_count: 1 });

    // a stale head is refused before the native merge runs
    await expect(
      gh.rest.pulls.merge({
        owner: 'team',
        repo: 'project',
        pull_number: 1,
        sha: '0'.repeat(40),
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('reads pipeline jobs as check runs (#47) and code scanning alerts (#67)', async () => {
    const gh = octokit(ownerToken);
    // a pipeline on the pull request's head plans its jobs as check runs
    const withPipeline = (
      await commitChanges(testEnv, repo.id, {
        first_parent: head,
        message: 'add pipeline',
        author,
        changes: [
          {
            path: '.yuma/pipelines/ci.yml',
            op: 'add',
            content_b64: btoa(
              'on: [pull_request]\njobs:\n  lint:\n    steps: [{ run: npm run lint }]\n  test:\n    needs: lint\n    steps: [{ run: npm test }]\n',
            ),
          },
        ],
      })
    ).changeset.id;
    await setRef(testEnv, repo.id, 'feature', withPipeline);
    const pull = await gh.rest.pulls.create({
      owner: 'team',
      repo: 'project',
      title: 'Pipeline',
      head: 'feature',
      base: 'main',
    });
    const checks = await gh.rest.checks.listForRef({
      owner: 'team',
      repo: 'project',
      ref: pull.data.head.sha,
    });
    expect(
      checks.data.check_runs.map((r) => [r.name, r.status, r.conclusion]).sort(),
    ).toEqual([
      ['lint', 'queued', null],
      ['test', 'queued', null],
    ]);

    const alert = (ref: string, rule: string, state: string) =>
      run(
        testEnv,
        `INSERT INTO code_scanning_alerts (repo_id, ref, tool, category, fingerprint, rule_id,
           rule_name, severity, message, path, start_line, end_line, state, dismissed_reason,
           dismissed_by, last_analysis_id, created_at, updated_at)
         VALUES (?, ?, 'semgrep', 'sast', ?, ?, 'SQL injection', 'high', 'Tainted query',
           'src/db.ts', 4, 6, ?, ?, ?, 1, 1000, 2000)`,
        [
          repo.id,
          ref,
          `${ref}:${rule}`,
          rule,
          state,
          state === 'dismissed' ? 'false_positive' : null,
          state === 'dismissed' ? owner.userId : null,
        ],
      );
    await alert('main', 'sqli', 'open');
    await alert('main', 'xss', 'dismissed');
    await alert('feature', 'ssrf', 'open');
    const alerts = await gh.rest.codeScanning.listAlertsForRepo({
      owner: 'team',
      repo: 'project',
    });
    expect(alerts.data.map((a) => a.rule.id)).toEqual(['xss', 'sqli']);
    expect(alerts.data[1]).toMatchObject({
      state: 'open',
      dismissed_by: null,
      rule: { id: 'sqli', severity: 'error', security_severity_level: 'high' },
      tool: { name: 'semgrep' },
      most_recent_instance: {
        ref: 'refs/heads/main',
        message: { text: 'Tainted query' },
        location: { path: 'src/db.ts', start_line: 4, end_line: 6 },
      },
      html_url: 'https://forge.test/r/team/project/security-alerts',
    });
    expect(alerts.data[0]).toMatchObject({
      state: 'dismissed',
      dismissed_reason: 'false positive',
      dismissed_by: { login: 'owner' },
    });
    const open = await gh.rest.codeScanning.listAlertsForRepo({
      owner: 'team',
      repo: 'project',
      ref: 'refs/heads/feature',
      state: 'open',
    });
    expect(open.data.map((a) => a.rule.id)).toEqual(['ssrf']);
    // the native route's write requirement applies: readers are refused
    await expect(
      octokit(readerToken).rest.codeScanning.listAlertsForRepo({
        owner: 'team',
        repo: 'project',
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('serves repos, contents, refs, commits and releases', async () => {
    const gh = octokit(ownerToken);
    const repoData = await gh.rest.repos.get({ owner: 'team', repo: 'project' });
    expect(repoData.data).toMatchObject({
      full_name: 'team/project',
      private: true,
      default_branch: 'main',
      clone_url: 'https://forge.test/team/project.git',
      permissions: { admin: true },
    });

    const readme = await gh.rest.repos.getContent({
      owner: 'team',
      repo: 'project',
      path: 'README.md',
    });
    expect(readme.data).toMatchObject({
      type: 'file',
      encoding: 'base64',
      path: 'README.md',
    });
    if (Array.isArray(readme.data) || !('content' in readme.data))
      throw new Error('file');
    expect(atob(readme.data.content)).toBe('# Project\n');
    const dir = await gh.rest.repos.getContent({
      owner: 'team',
      repo: 'project',
      path: '',
      ref: 'feature',
    });
    expect(Array.isArray(dir.data) && dir.data.map((e) => [e.name, e.type])).toEqual([
      ['README.md', 'file'],
      ['src', 'dir'],
    ]);

    const ref = await gh.rest.git.getRef({
      owner: 'team',
      repo: 'project',
      ref: 'heads/main',
    });
    expect(ref.data).toMatchObject({
      ref: 'refs/heads/main',
      object: { type: 'commit' },
    });
    const created = await gh.rest.git.createRef({
      owner: 'team',
      repo: 'project',
      ref: 'refs/heads/topic',
      sha: ref.data.object.sha,
    });
    expect(created.data.object.sha).toBe(ref.data.object.sha);

    const commitData = await gh.rest.repos.getCommit({
      owner: 'team',
      repo: 'project',
      ref: 'feature',
    });
    expect(commitData.data.commit.message).toBe('add src/app.ts');
    expect(commitData.data.parents.map((p) => p.sha)).toEqual([ref.data.object.sha]);

    const release = await gh.rest.repos.createRelease({
      owner: 'team',
      repo: 'project',
      tag_name: 'v1.0.0',
      name: 'First',
    });
    expect(release.status).toBe(201);
    expect(release.data).toMatchObject({
      tag_name: 'v1.0.0',
      name: 'First',
      target_commitish: ref.data.object.sha,
    });
    const releases = await gh.rest.repos.listReleases({ owner: 'team', repo: 'project' });
    expect(releases.data.map((r) => r.tag_name)).toEqual(['v1.0.0']);
    const byTag = await gh.rest.repos.getReleaseByTag({
      owner: 'team',
      repo: 'project',
      tag: 'v1.0.0',
    });
    expect(byTag.data.name).toBe('First');
  });

  it('answers /user and paginates with Link headers', async () => {
    const gh = octokit(ownerToken);
    expect((await gh.rest.users.getAuthenticated()).data.login).toBe('owner');
    for (let i = 0; i < 3; i++)
      await gh.rest.issues.create({
        owner: 'team',
        repo: 'project',
        title: `Issue ${i}`,
      });
    const first = await gh.rest.issues.listForRepo({
      owner: 'team',
      repo: 'project',
      per_page: 2,
    });
    expect(first.data).toHaveLength(2);
    expect(first.headers.link).toContain('rel="next"');
    const every = await gh.paginate(gh.rest.issues.listForRepo, {
      owner: 'team',
      repo: 'project',
      per_page: 2,
    });
    expect(every.map((i) => i.number).sort()).toEqual([1, 2, 3]);
  });
});

describe('GitHub REST compatibility (access and aliases)', () => {
  it('refuses anonymous callers with 401 and hides unreadable repos with 404', async () => {
    expect(
      (await call('GET', '/api/github/v3/repos/team/project/issues', null)).status,
    ).toBe(401);
    const stranger = await loginAs(testEnv, 7403, 'stranger');
    const strangerToken = (
      await createApiToken(testEnv, stranger.userId, { label: 'gh' })
    ).raw;
    const res = await call(
      'GET',
      '/api/github/v3/repos/team/project/issues',
      strangerToken,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { message: string; error: { code: string } };
    expect(body.message).toBeTruthy();
    expect(body.error.code).toBe('repo_not_found');
    for (const path of [
      '/api/v3/repos/team/project/pulls',
      '/api/github/v3/search/issues?q=repo:team/project',
    ]) {
      expect((await call('GET', path, null)).status, path).toBe(401);
      expect((await call('GET', path, strangerToken)).status, path).toBe(404);
      expect((await call('GET', path, readerToken)).status, path).toBe(200);
    }
  });

  it('keeps the native 403 for writes a reader may not make', async () => {
    const res = await call(
      'POST',
      '/api/github/v3/repos/team/project/pulls',
      readerToken,
      {
        title: 'Nope',
        head: 'feature',
        base: 'main',
      },
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { message: string; error: { code: string } };
    expect(body.message).toBeTruthy();
    expect(body.error.code).toBe('forbidden');
  });

  it('applies path rules and reports denied_by', async () => {
    const writer = await loginAs(testEnv, 7404, 'writer');
    const writerToken = (await createApiToken(testEnv, writer.userId, { label: 'gh' }))
      .raw;
    await run(
      testEnv,
      'INSERT INTO repo_members (repo_id, user_id, role) VALUES (?,?,?)',
      [repo.id, writer.userId, 'write'],
    );
    const rule = parsePathRuleInput({
      path_prefix: 'src/',
      effect: 'deny',
      principal: 'role:write',
      perms: ['write'],
    });
    await run(
      testEnv,
      `INSERT INTO ${T.pathRules} (${C.pathRules.repoId}, ${C.pathRules.pathPrefix}, ${C.pathRules.effect}, ${C.pathRules.principal}, ${C.pathRules.perms}) VALUES (?, ?, ?, ?, ?)`,
      [
        repo.id,
        rule.path_prefix,
        rule.effect,
        rule.principal,
        JSON.stringify(rule.perms),
      ],
    );
    // pull requests need whole-repository write; the native denial passes through
    const res = await call(
      'POST',
      '/api/github/v3/repos/team/project/pulls',
      writerToken,
      {
        title: 'Nope',
        head: 'feature',
        base: 'main',
      },
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; denied_by?: unknown } };
    expect(body.error.denied_by).toBeTruthy();
  });

  it('answers 422 for bad input and for pull requests off the default branch', async () => {
    const gh = octokit(ownerToken);
    await expect(
      gh.rest.pulls.create({
        owner: 'team',
        repo: 'project',
        title: 'x',
        head: 'feature',
        base: 'topic',
      }),
    ).rejects.toMatchObject({ status: 422 });
    const res = await call(
      'POST',
      '/api/github/v3/repos/team/project/issues',
      ownerToken,
      {
        body: 'no title',
      },
    );
    expect(res.status).toBe(422);
  });

  it('serves the GitHub Enterprise /api/v3 path gh uses with GH_HOST', async () => {
    const root = await call('GET', '/api/v3/', ownerToken);
    expect(root.status).toBe(200);
    expect(await root.json()).toMatchObject({
      current_user_url: 'https://forge.test/api/github/v3/user',
    });
    expect((await call('GET', '/api/v3/', null)).status).toBe(401);
    const gh = octokit(ownerToken, 'https://forge.test/api/v3');
    const issue = await gh.rest.issues.create({
      owner: 'team',
      repo: 'project',
      title: 'Via gh',
    });
    expect(issue.data.url).toBe(
      'https://forge.test/api/github/v3/repos/team/project/issues/1',
    );
    expect(
      (await gh.rest.issues.get({ owner: 'team', repo: 'project', issue_number: 1 }))
        .data,
    ).toMatchObject({ title: 'Via gh', comments: 0 });
  });

  it('accepts a Bearer token as well as the GitHub token scheme', async () => {
    const res = await app(
      new Request('https://forge.test/api/github/v3/user', {
        headers: { authorization: `Bearer ${readerToken}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { login: string }).login).toBe('reader');
  });
});
