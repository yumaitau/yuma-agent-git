import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { cleanDb, loginAs, makeApp, seedSchema, type TestEnv } from './helpers';
import { createRepo, setRef } from '../src/db/repos';
import { commitChanges } from '../src/core/commit';
import { getChangeset } from '../src/core/changesets';
import { resolvePath } from '../src/core/trees';
import { createApiToken } from '../src/auth/tokens';
import { q, q1, run } from '../src/db/client';
import { createRequestToken } from '../src/ci/oidc';
import { prepareJob } from '../src/ci/inject';
import { parsePolicy, type CiRun } from '../src/ci/config';
import { commitShas } from '../src/git/upload-pack';
import { analysesOf, decodeSarif } from '../src/security/code-scanning';
import type { Pull } from '../shared/collaboration';

const testEnv = env as unknown as TestEnv;
const dbEnv = testEnv as unknown as Env;
const app = makeApp(testEnv);
type Login = Awaited<ReturnType<typeof loginAs>>;
const author = { name: 'Ada', email: 'ada@example.com' };

interface Finding {
  rule: string;
  path: string;
  line: number;
  level?: 'error' | 'warning' | 'note';
  fingerprint?: string;
  message?: string;
}

/** A SARIF 2.1.0 log with one run; rule `sev-*` carries a CVSS `security-severity`. */
function sarifLog(findings: Finding[], tool = 'Semgrep', automationId?: string): unknown {
  const rules = [...new Set(findings.map((f) => f.rule))].map((id) => ({
    id,
    shortDescription: { text: `Rule ${id}` },
    ...(id.startsWith('sev-')
      ? { properties: { 'security-severity': id.slice(4) } }
      : {}),
  }));
  return {
    version: '2.1.0',
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    runs: [
      {
        tool: { driver: { name: tool, rules } },
        ...(automationId ? { automationDetails: { id: automationId } } : {}),
        results: findings.map((f) => ({
          ruleId: f.rule,
          ...(f.level ? { level: f.level } : {}),
          message: { text: f.message ?? `${f.rule} found` },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: f.path },
                region: { startLine: f.line, startColumn: 3, endColumn: 9 },
              },
            },
          ],
          ...(f.fingerprint
            ? { partialFingerprints: { primaryLocationLineHash: f.fingerprint } }
            : {}),
        })),
      },
    ],
  };
}

function b64(bytes: Uint8Array): string {
  let text = '';
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text);
}

/** gzip then base64, as GitHub's upload API and `gzip -c | base64` produce. */
async function encode(log: unknown): Promise<string> {
  const stream = new Blob([JSON.stringify(log)])
    .stream()
    .pipeThrough(new CompressionStream('gzip'));
  return b64(new Uint8Array(await new Response(stream).arrayBuffer()));
}

describe('SARIF parsing (#67)', () => {
  it('reads base64 JSON or gzip, and refuses what is not SARIF 2.1.0', async () => {
    const log = sarifLog([{ rule: 'r1', path: 'a.ts', line: 1 }]);
    expect((await decodeSarif(await encode(log))).runs).toHaveLength(1);
    expect(
      (await decodeSarif(b64(new TextEncoder().encode(JSON.stringify(log))))).runs,
    ).toHaveLength(1);
    await expect(decodeSarif('%%%')).rejects.toMatchObject({ code: 'invalid_sarif' });
    await expect(
      decodeSarif(btoa(JSON.stringify({ version: '2.0.0', runs: [] }))),
    ).rejects.toMatchObject({ code: 'invalid_sarif', status: 400 });
  });

  it('maps severity, location, category and fingerprints', async () => {
    const log = sarifLog(
      [
        { rule: 'sev-9.8', path: 'file:///src/a.ts', line: 4 },
        { rule: 'sev-5.0', path: './src/b.ts', line: 2 },
        { rule: 'plain', path: 'src/c.ts', line: 1, level: 'error' },
        { rule: 'plain', path: 'src/c.ts', line: 9, level: 'note' },
        { rule: 'plain', path: 'src/d.ts', line: 1, fingerprint: 'abc' },
        // same rule, path, line and message: one finding
        { rule: 'plain', path: 'src/d.ts', line: 1, fingerprint: 'abc' },
      ],
      'CodeQL',
      'js-analysis/run-42',
    );
    const [analysis] = await analysesOf(await decodeSarif(await encode(log)));
    expect(analysis).toMatchObject({ tool: 'CodeQL', category: 'js-analysis' });
    expect(
      analysis!.findings.map((f) => [f.rule_id, f.severity, f.path, f.start_line]),
    ).toEqual([
      ['sev-9.8', 'critical', 'src/a.ts', 4],
      ['sev-5.0', 'medium', 'src/b.ts', 2],
      ['plain', 'high', 'src/c.ts', 1],
      ['plain', 'low', 'src/c.ts', 9],
      ['plain', 'medium', 'src/d.ts', 1],
    ]);
    expect(analysis!.findings[0]).toMatchObject({
      rule_name: 'Rule sev-9.8',
      start_column: 3,
      end_column: 9,
      end_line: 4,
    });
    const [overridden] = await analysesOf(await decodeSarif(await encode(log)), {
      category: 'nightly',
      tool_name: 'codeql-custom',
    });
    expect(overridden).toMatchObject({ tool: 'codeql-custom', category: 'nightly' });
  });
});

describe('code scanning API (#67)', () => {
  let owner: Login;
  let dev: Login;
  let repo: Awaited<ReturnType<typeof createRepo>>;
  let base: string;

  async function call(
    method: string,
    tail: string,
    body?: unknown,
    headers: Record<string, string> = owner.headers,
    via = app,
  ): Promise<Response> {
    return via(
      new Request(`https://forge.test/api/v1${tail}`, {
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

  async function commit(parent: string | null, files: Record<string, string>) {
    const root = parent ? (await getChangeset(dbEnv, repo.id, parent))?.root_tree : null;
    const changes = [];
    for (const [path, content] of Object.entries(files)) {
      const exists = root && (await resolvePath(dbEnv, repo.id, root, path.split('/')));
      changes.push({
        path,
        op: exists ? ('mod' as const) : ('add' as const),
        content_b64: btoa(content),
      });
    }
    return (
      await commitChanges(dbEnv, repo.id, {
        first_parent: parent,
        message: 'change',
        author,
        changes,
      })
    ).changeset.id;
  }

  async function upload(
    findings: Finding[],
    at: { commit_sha: string; ref: string },
    headers = owner.headers,
    status = 202,
  ): Promise<{
    analyses: { id: number; opened: number; reopened: number; fixed: number }[];
  }> {
    return json(
      await call(
        'POST',
        '/repos/acme/shop/code-scanning/sarif',
        { ...at, sarif: await encode(sarifLog(findings)) },
        headers,
      ),
      status,
    );
  }

  interface AlertView {
    id: number;
    rule_id: string;
    state: string;
    severity: string;
    path: string;
    start_line: number | null;
    dismissed_reason: string | null;
  }
  async function alerts(query = ''): Promise<AlertView[]> {
    return (
      await json<{ alerts: AlertView[] }>(
        await call('GET', `/repos/acme/shop/code-scanning/alerts${query}`),
      )
    ).alerts;
  }

  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
    owner = await loginAs(testEnv, 911, 'owner');
    dev = await loginAs(testEnv, 912, 'dev');
    repo = await createRepo(dbEnv, { slug: 'acme/shop', createdBy: owner.userId });
    await run(
      dbEnv,
      "INSERT INTO repo_members (repo_id, user_id, role) VALUES (?, ?, 'write')",
      [repo.id, dev.userId],
    );
    base = await commit(null, { 'src/a.ts': 'a\n', 'src/b.ts': 'b\n' });
    await setRef(dbEnv, repo.id, 'main', base);
  });

  it('stores alerts with locations and dedupes by fingerprint; fixed and reopened keep the id', async () => {
    const a = { rule: 'sev-8.1', path: 'src/a.ts', line: 3, fingerprint: 'fa' };
    const b = { rule: 'sev-4.0', path: 'src/b.ts', line: 7 };
    const first = await upload([a, b], { commit_sha: base, ref: 'refs/heads/main' });
    expect(first.analyses[0]).toMatchObject({ opened: 2, fixed: 0 });
    const listed = await alerts();
    expect(
      listed.map((x) => [x.rule_id, x.severity, x.path, x.start_line, x.state]),
    ).toEqual([
      ['sev-4.0', 'medium', 'src/b.ts', 7, 'open'],
      ['sev-8.1', 'high', 'src/a.ts', 3, 'open'],
    ]);
    // the same finding again (a moved line keeps CodeQL's fingerprint): no new alert
    const again = await upload([{ ...a, line: 5 }, b], { commit_sha: base, ref: 'main' });
    expect(again.analyses[0]).toMatchObject({ opened: 0, reopened: 0, fixed: 0 });
    expect(await alerts()).toHaveLength(2);
    expect((await alerts()).find((x) => x.rule_id === 'sev-8.1')?.start_line).toBe(5);

    // b gone: fixed
    const next = await commit(base, { 'src/b.ts': 'fixed\n' });
    await setRef(dbEnv, repo.id, 'main', next);
    const gone = await upload([a], { commit_sha: next, ref: 'main' });
    expect(gone.analyses[0]).toMatchObject({ fixed: 1 });
    const bId = listed.find((x) => x.rule_id === 'sev-4.0')!.id;
    expect((await alerts('?state=fixed')).map((x) => x.id)).toEqual([bId]);

    // b back: reopened under the same id
    const back = await upload([a, b], { commit_sha: next, ref: 'main' });
    expect(back.analyses[0]).toMatchObject({ reopened: 1, opened: 0 });
    expect((await alerts('?state=open')).map((x) => x.id)).toContain(bId);
    expect(await q(dbEnv, 'SELECT id FROM code_scanning_alerts')).toHaveLength(2);

    const audit = await q1<{ actor_id: string; target: string }>(
      dbEnv,
      "SELECT actor_id, target FROM audit_events WHERE action = 'code_scanning.upload' ORDER BY id DESC LIMIT 1",
    );
    expect(JSON.parse(audit!.target)).toMatchObject({ ref: 'main', changeset: next });
  });

  it('accepts a Git commit SHA-1, keeps dismissed alerts dismissed, and refuses bad input', async () => {
    const sha1 = (await commitShas(dbEnv, repo.id, [base])).get(base)!;
    const a = { rule: 'sev-9.1', path: 'src/a.ts', line: 1 };
    await upload([a], { commit_sha: sha1, ref: 'main' });
    const [alert] = await alerts();
    expect(alert!.severity).toBe('critical');
    const dismissed = await json<{ alert: AlertView }>(
      await call('PATCH', `/repos/acme/shop/code-scanning/alerts/${alert!.id}`, {
        state: 'dismissed',
        reason: 'false_positive',
      }),
    );
    expect(dismissed.alert).toMatchObject({
      state: 'dismissed',
      dismissed_reason: 'false_positive',
    });
    await upload([a], { commit_sha: base, ref: 'main' });
    expect((await alerts())[0]!.state).toBe('dismissed');
    expect(
      await q1(
        dbEnv,
        "SELECT 1 FROM audit_events WHERE action = 'code_scanning.alert.update'",
      ),
    ).not.toBeNull();

    const bad = async (body: Record<string, unknown>, status: number, code: string) => {
      const res = await call('POST', '/repos/acme/shop/code-scanning/sarif', {
        commit_sha: base,
        ref: 'main',
        sarif: await encode(sarifLog([a])),
        ...body,
      });
      expect(res.status).toBe(status);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(code);
    };
    await bad({ sarif: btoa('{"version":"2.1.0"}') }, 400, 'invalid_sarif');
    await bad({ commit_sha: 'f'.repeat(40) }, 422, 'unknown_commit');
    await bad({ ref: 'no-such-branch' }, 422, 'unknown_ref');
    await bad({ commit_sha: undefined }, 400, 'invalid_request');
  });

  it('guards uploads and alert changes', async () => {
    const stranger = await loginAs(testEnv, 913, 'stranger');
    const reader = await loginAs(testEnv, 914, 'reader');
    await run(
      dbEnv,
      "INSERT INTO repo_members (repo_id, user_id, role) VALUES (?, ?, 'read')",
      [repo.id, reader.userId],
    );
    const at = { commit_sha: base, ref: 'main' };
    const sarif = await encode(sarifLog([{ rule: 'x', path: 'a', line: 1 }]));
    const post = (headers: Record<string, string>) =>
      call('POST', '/repos/acme/shop/code-scanning/sarif', { ...at, sarif }, headers);
    expect((await post({})).status).toBe(401);
    expect((await post(stranger.headers)).status).toBe(404);
    expect((await post(reader.headers)).status).toBe(403);
    expect((await post(dev.headers)).status).toBe(202);
    // API tokens need repo:write
    const readOnly = await createApiToken(dbEnv, dev.userId, {
      label: 'ro',
      scopes: ['repo:read'],
    });
    expect((await post({ authorization: `Bearer ${readOnly.raw}` })).status).toBe(403);
  });

  it('agents upload with security_events:write and cannot dismiss', async () => {
    const delegate = await createApiToken(dbEnv, owner.userId, {
      label: 'delegate',
      scopes: ['repo:read', 'repo:write', 'agent:run'],
    });
    const created = await json<{ id: string }>(
      await call('POST', '/agents', {
        name: 'scanner',
        kind: 'claude_code',
        max_scopes: ['contents:read', 'contents:write', 'security_events:write'],
      }),
      201,
    );
    const agentToken = async (scope: string) => {
      const form = new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        subject_token: delegate.raw,
        agent_id: created.id,
        resource: 'acme/shop',
        scope,
      });
      const token = await json<{ access_token: string }>(
        await app(
          new Request('https://forge.test/oauth/token', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: form,
          }),
        ),
      );
      return { authorization: `Bearer ${token.access_token}` };
    };
    const at = { commit_sha: base, ref: 'main' };
    const finding = { rule: 'x', path: 'src/a.ts', line: 1 };
    const without = await agentToken('contents:write');
    const refused = await call(
      'POST',
      '/repos/acme/shop/code-scanning/sarif',
      { ...at, sarif: await encode(sarifLog([finding])) },
      without,
    );
    expect(refused.status).toBe(403);
    const scanner = await agentToken('contents:write security_events:write');
    await upload([finding], at, scanner);
    const [alert] = await alerts();
    const dismiss = await call(
      'PATCH',
      `/repos/acme/shop/code-scanning/alerts/${alert!.id}`,
      { state: 'dismissed', reason: 'wont_fix' },
      scanner,
    );
    expect(dismiss.status).toBe(403);
  });

  it('a CI job uploads for its own changeset with permissions.security_events: write', async () => {
    const ci = new Proxy(testEnv, {
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
    const via = makeApp(ci);
    const configure = async (security_events: string) =>
      json(
        await call(
          'PUT',
          '/repos/acme/shop/ci',
          {
            commands: ['npm test'],
            timeout_seconds: 60,
            permissions: { security_events },
          },
          owner.headers,
          via,
        ),
      );
    const runningJob = async (): Promise<CiRun> => {
      const { run: job } = await json<{ run: CiRun }>(
        await call('POST', '/repos/acme/shop/ci/runs', {}, owner.headers, via),
        202,
      );
      await run(
        dbEnv,
        "UPDATE ci_runs SET state = 'running', deadline = ? WHERE id = ?",
        [Date.now() + 60_000, job.id],
      );
      return (await q1<CiRun>(dbEnv, 'SELECT * FROM ci_runs WHERE id = ?', [job.id]))!;
    };
    await configure('write');
    const job = await runningJob();
    // the runner hands the job an upload URL and its request token
    const access = await prepareJob(
      ci,
      job,
      parsePolicy(JSON.parse(job.config)),
      Date.now() + 60_000,
    );
    expect(access.env.YAG_CODE_SCANNING_URL).toBe(
      'https://forge.test/ci/code-scanning/sarif',
    );
    const token = access.env.YAG_CODE_SCANNING_TOKEN!;
    expect(access.mask).toContain(token);
    const sarif = await encode(
      sarifLog([{ rule: 'sev-7.5', path: 'src/a.ts', line: 2 }]),
    );
    const ciUpload = (raw: string, body: Record<string, unknown>) =>
      app(
        new Request('https://forge.test/ci/code-scanning/sarif', {
          method: 'POST',
          headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
    // the job's own repository, changeset and ref, whatever the body says
    const res = await ciUpload(token, {
      sarif,
      commit_sha: 'f'.repeat(40),
      ref: 'other',
    });
    expect(await json<{ ref: string; commit: string }>(res, 202)).toMatchObject({
      ref: 'main',
      commit: job.head_cs,
    });
    expect((await alerts())[0]!.severity).toBe('high');
    const audit = await q1<{ actor_id: string; on_behalf_of: string }>(
      dbEnv,
      "SELECT actor_id, on_behalf_of FROM audit_events WHERE action = 'code_scanning.upload'",
    );
    expect(audit).toEqual({ actor_id: `ci-run:${job.id}`, on_behalf_of: owner.userId });
    expect((await ciUpload('yagjob_nope', { sarif })).status).toBe(401);
    // without the permission the request token cannot upload
    await run(
      dbEnv,
      "UPDATE ci_runs SET state = 'passed', finished_at = ? WHERE id = ?",
      [Date.now(), job.id],
    );
    await configure('none');
    const plain = await runningJob();
    const other = await createRequestToken(dbEnv, plain.id, Date.now() + 60_000);
    expect((await ciUpload(other, { sarif })).status).toBe(403);
  });

  it('shows new findings on a pull request and blocks the merge on new high alerts', async () => {
    await upload([{ rule: 'sev-8.0', path: 'src/a.ts', line: 1, fingerprint: 'old' }], {
      commit_sha: base,
      ref: 'main',
    });
    const head = await commit(base, { 'src/c.ts': 'c\n' });
    const pull = (
      await json<{ pull: Pull }>(
        await call(
          'POST',
          '/repos/acme/shop/pulls',
          { title: 'Change', head_cs: head },
          dev.headers,
        ),
        201,
      )
    ).pull;
    const gate = async () =>
      (
        await json<{ gate: { reasons: string[] } }>(
          await call('GET', `/repos/acme/shop/pulls/${pull.id}`),
        )
      ).gate.reasons;
    await json(
      await call('POST', '/repos/acme/shop/rulesets', {
        name: 'Security',
        target: 'branch',
        conditions: { ref_name: { include: ['~DEFAULT_BRANCH'] } },
        rules: [{ type: 'security_alerts' }],
      }),
      201,
    );
    expect((await gate()).some((r) => r.includes('security alert'))).toBe(false);
    await upload(
      [
        { rule: 'sev-8.0', path: 'src/a.ts', line: 1, fingerprint: 'old' },
        { rule: 'sev-9.5', path: 'src/c.ts', line: 1, fingerprint: 'new-critical' },
        { rule: 'sev-5.0', path: 'src/c.ts', line: 2, fingerprint: 'new-medium' },
      ],
      { commit_sha: head, ref: `refs/pull/${pull.number}/head` },
    );
    const found = await json<{
      code_scanning: { rule_id: string; new: boolean }[];
    }>(await call('GET', `/repos/acme/shop/pulls/${pull.id}/security`));
    expect(found.code_scanning.map((a) => [a.rule_id, a.new])).toEqual([
      ['sev-8.0', false],
      ['sev-9.5', true],
      ['sev-5.0', true],
    ]);
    expect(await gate()).toContain(
      '1 new security alert at high severity or above: sev-9.5 in src/c.ts.',
    );
    // the alerts for the PR ref live apart from main's
    expect(await alerts('?ref=main')).toHaveLength(1);
    expect(await alerts(`?ref=refs/pull/${pull.number}/head`)).toHaveLength(3);
    // dismissing it on the pull request ref clears the rule
    const critical = (await alerts(`?ref=refs/pull/${pull.number}/head`)).find(
      (a) => a.rule_id === 'sev-9.5',
    )!;
    await json(
      await call('PATCH', `/repos/acme/shop/code-scanning/alerts/${critical.id}`, {
        state: 'dismissed',
        reason: 'used_in_tests',
      }),
    );
    expect((await gate()).some((r) => r.includes('security alert'))).toBe(false);
  });
});
