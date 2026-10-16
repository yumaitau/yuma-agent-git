import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import {
  cleanDb,
  instrumentQueues,
  loginAs,
  makeApp,
  seedSchema,
  type TestEnv,
} from './helpers';
import { createRepo, setRef } from '../src/db/repos';
import { commitChanges } from '../src/core/commit';
import { getChangeset } from '../src/core/changesets';
import { peekDerived } from '../src/core/derived';
import { resolvePath } from '../src/core/trees';
import { createApiToken } from '../src/auth/tokens';
import { q, q1, run } from '../src/db/client';
import { lockfileOf } from '../src/security/deps/lockfiles';
import {
  advisorySeverity,
  compareVersions,
  cvss3Score,
  fixedVersion,
  isAffected,
  loadAdvisories,
  syncAdvisories,
  type OsvEntry,
} from '../src/security/deps/osv';
import {
  DEPENDENCIES,
  dependencyMessage,
  isDependencyMessage,
  sweepDependencies,
  type DependencyMessage,
} from '../src/security/deps/graph';
import type { Pull } from '../shared/collaboration';

const testEnv = env as unknown as TestEnv;
const dbEnv = testEnv as unknown as Env;
type Login = Awaited<ReturnType<typeof loginAs>>;
const author = { name: 'Ada', email: 'ada@example.com' };

function parse(file: string, text: string): [string, string][] {
  return lockfileOf(file)!
    .parse(text)
    .map((p) => [p.name, p.version]);
}

describe('lockfile parsers (#67)', () => {
  it('reads npm package-lock v1 and v3', () => {
    const v3 = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'app' },
        'node_modules/lodash': { version: '4.17.20' },
        'node_modules/a/node_modules/lodash': { version: '4.17.15' },
        'node_modules/@scope/pkg': { version: '1.0.0' },
        'packages/w': { name: 'w', version: '0.0.1' },
        'node_modules/w': { link: true, resolved: 'packages/w' },
      },
    });
    expect(parse('web/package-lock.json', v3)).toEqual([
      ['@scope/pkg', '1.0.0'],
      ['lodash', '4.17.15'],
      ['lodash', '4.17.20'],
    ]);
    const v1 = JSON.stringify({
      lockfileVersion: 1,
      dependencies: {
        lodash: { version: '4.17.20' },
        a: { version: '1.0.0', dependencies: { lodash: { version: '4.17.15' } } },
      },
    });
    expect(parse('npm-shrinkwrap.json', v1)).toEqual([
      ['a', '1.0.0'],
      ['lodash', '4.17.15'],
      ['lodash', '4.17.20'],
    ]);
  });

  it('reads pnpm (v5, v6, v9) and yarn (v1 and Berry) lockfiles', () => {
    const pnpm = [
      "lockfileVersion: '9.0'",
      'packages:',
      '  lodash@4.17.20:',
      '    resolution: {integrity: sha512-x}',
      "  '@babel/core@7.24.0':",
      '    resolution: {integrity: sha512-y}',
      "  '/react-dom@18.2.0(react@18.2.0)':",
      '    resolution: {integrity: sha512-z}',
      '  /minimist/1.2.5:',
      '    resolution: {integrity: sha512-w}',
      "  'gitdep@https://codeload.github.com/x/y/tar.gz/abc':",
      '    resolution: {tarball: x}',
    ].join('\n');
    expect(parse('pnpm-lock.yaml', pnpm)).toEqual([
      ['@babel/core', '7.24.0'],
      ['lodash', '4.17.20'],
      ['minimist', '1.2.5'],
      ['react-dom', '18.2.0'],
    ]);
    const yarn1 = [
      '# yarn lockfile v1',
      '',
      'lodash@^4.17.0, lodash@^4.17.20:',
      '  version "4.17.20"',
      '  resolved "https://registry.yarnpkg.com/lodash/-/lodash-4.17.20.tgz"',
      '',
      '"@babel/core@^7.0.0":',
      '  version "7.24.0"',
    ].join('\n');
    expect(parse('yarn.lock', yarn1)).toEqual([
      ['@babel/core', '7.24.0'],
      ['lodash', '4.17.20'],
    ]);
    const berry = [
      '__metadata:',
      '  version: 6',
      '',
      '"lodash@npm:^4.17.0":',
      '  version: 4.17.21',
      '  resolution: "lodash@npm:4.17.21"',
      '',
      '"app@workspace:.":',
      '  version: 0.0.0-use.local',
    ].join('\n');
    expect(parse('yarn.lock', berry)).toEqual([['lodash', '4.17.21']]);
  });

  it('reads Python, Go, Rust, PHP, Gradle and Swift lockfiles', () => {
    expect(
      parse(
        'requirements.txt',
        [
          'Django==4.2.0',
          'requests[security]==2.31.0 ; python_version > "3.8"',
          'flask>=2.0',
          '-e git+https://example.com/x.git#egg=x',
          'urllib3 == 1.26.5  # pinned',
        ].join('\n'),
      ),
    ).toEqual([
      ['django', '4.2.0'],
      ['requests', '2.31.0'],
      ['urllib3', '1.26.5'],
    ]);
    expect(
      parse(
        'poetry.lock',
        [
          '[[package]]',
          'name = "Django"',
          'version = "4.2.0"',
          '',
          '[package.dependencies]',
          'sqlparse = ">=0.3.1"',
          '',
          '[[package]]',
          'name = "Typing_Extensions"',
          'version = "4.7.1"',
        ].join('\n'),
      ),
    ).toEqual([
      ['django', '4.2.0'],
      ['typing-extensions', '4.7.1'],
    ]);
    expect(
      parse(
        'go.sum',
        [
          'github.com/gin-gonic/gin v1.9.0 h1:aaa=',
          'github.com/gin-gonic/gin v1.9.0/go.mod h1:bbb=',
          'github.com/gin-gonic/gin v1.8.1 h1:ccc=',
          'golang.org/x/net v0.7.0/go.mod h1:ddd=',
        ].join('\n'),
      ),
    ).toEqual([['github.com/gin-gonic/gin', 'v1.9.0']]);
    expect(
      parse(
        'Cargo.lock',
        [
          'version = 3',
          '',
          '[[package]]',
          'name = "myapp"',
          'version = "0.1.0"',
          '',
          '[[package]]',
          'name = "serde"',
          'version = "1.0.150"',
          'source = "registry+https://github.com/rust-lang/crates.io-index"',
        ].join('\n'),
      ),
    ).toEqual([['serde', '1.0.150']]);
    expect(
      parse(
        'composer.lock',
        JSON.stringify({
          packages: [
            { name: 'monolog/monolog', version: 'v2.9.1' },
            { name: 'x/y', version: 'dev-main' },
          ],
          'packages-dev': [{ name: 'phpunit/phpunit', version: '9.6.0' }],
        }),
      ),
    ).toEqual([
      ['monolog/monolog', '2.9.1'],
      ['phpunit/phpunit', '9.6.0'],
    ]);
    expect(
      parse(
        'gradle.lockfile',
        [
          '# This is a Gradle generated file for dependency locking.',
          'com.fasterxml.jackson.core:jackson-databind:2.13.0=compileClasspath,runtimeClasspath',
          'empty=annotationProcessor',
        ].join('\n'),
      ),
    ).toEqual([['com.fasterxml.jackson.core:jackson-databind', '2.13.0']]);
    expect(
      parse(
        'ios/Package.resolved',
        JSON.stringify({
          version: 2,
          pins: [
            {
              identity: 'swift-nio',
              location: 'https://github.com/apple/swift-nio.git',
              state: { revision: 'abc', version: '2.40.0' },
            },
            { identity: 'x', location: 'https://e.com/x', state: { branch: 'main' } },
          ],
        }),
      ),
    ).toEqual([['github.com/apple/swift-nio', '2.40.0']]);
    expect(lockfileOf('src/package.json')).toBeNull();
  });
});

describe('OSV matching (#67)', () => {
  it('orders versions across ecosystems', () => {
    const ordered = [
      '1.0.0-alpha',
      '1.0.0-beta.2',
      '1.0.0-rc1',
      '1.0.0',
      '1.0.0.post1',
      '1.0.1',
      '1.2.0',
      '1.10.0',
      'v2.0.0',
    ];
    for (let i = 1; i < ordered.length; i++)
      expect(compareVersions(ordered[i - 1]!, ordered[i]!), ordered[i]).toBe(-1);
    expect(compareVersions('v1.9.0', '1.9.0')).toBe(0);
    expect(compareVersions('1.0.0+build', '1.0.0')).toBe(0);
  });

  it('evaluates ranges, explicit versions and last_affected', () => {
    const affected = {
      ranges: [
        {
          type: 'SEMVER',
          events: [
            { introduced: '0' },
            { fixed: '1.5.0' },
            { introduced: '2.0.0' },
            { fixed: '2.3.1' },
          ],
        },
        { type: 'GIT', events: [{ introduced: 'abc' }] },
      ],
      versions: ['3.0.0-weird'],
    };
    expect(isAffected(affected, '1.2.0')).toBe(true);
    expect(isAffected(affected, '1.5.0')).toBe(false);
    expect(isAffected(affected, '1.9.0')).toBe(false);
    expect(isAffected(affected, '2.2.0')).toBe(true);
    expect(isAffected(affected, '2.3.1')).toBe(false);
    expect(isAffected(affected, '3.0.0-weird')).toBe(true);
    expect(fixedVersion(affected, '1.2.0')).toBe('1.5.0');
    expect(fixedVersion(affected, '2.2.0')).toBe('2.3.1');
    const last = {
      ranges: [
        { type: 'ECOSYSTEM', events: [{ introduced: '1.0' }, { last_affected: '1.4' }] },
      ],
      versions: [],
    };
    expect(isAffected(last, '1.4')).toBe(true);
    expect(isAffected(last, '1.4.1')).toBe(false);
    expect(isAffected(last, '0.9')).toBe(false);
    expect(fixedVersion(last, '1.2')).toBeNull();
  });

  it('takes the reviewed severity, else the CVSS v3 score', () => {
    expect(cvss3Score('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H')).toBe(9.8);
    expect(cvss3Score('CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N')).toBe(6.1);
    expect(cvss3Score('CVSS:2.0/AV:N')).toBeNull();
    const entry = (extra: Partial<OsvEntry>): OsvEntry => ({
      id: 'X',
      modified: '2024-01-01T00:00:00Z',
      ...extra,
    });
    expect(advisorySeverity(entry({ database_specific: { severity: 'MODERATE' } }))).toBe(
      'medium',
    );
    expect(
      advisorySeverity(
        entry({
          severity: [
            { type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' },
          ],
        }),
      ),
    ).toBe('critical');
    expect(advisorySeverity(entry({}))).toBe('unknown');
  });
});

const LODASH: OsvEntry = {
  id: 'GHSA-35jh-r3h4-6jhm',
  modified: '2021-05-01T00:00:00Z',
  summary: 'Command injection in lodash',
  aliases: ['CVE-2021-23337'],
  database_specific: { severity: 'HIGH' },
  references: [
    { type: 'ADVISORY', url: 'https://nvd.nist.gov/vuln/detail/CVE-2021-23337' },
  ],
  affected: [
    {
      package: { ecosystem: 'npm', name: 'lodash' },
      ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '4.17.21' }] }],
    },
  ],
};

function lock(version: string): string {
  return JSON.stringify({
    lockfileVersion: 3,
    packages: { '': { name: 'app' }, 'node_modules/lodash': { version } },
  });
}

describe('dependency alerts (#67)', () => {
  let owner: Login;
  let dev: Login;
  let repo: Awaited<ReturnType<typeof createRepo>>;
  let base: string;
  const app = makeApp(testEnv);

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

  /** Run the cron sweep, then deliver what it queued as the consumer would. */
  async function match(): Promise<number> {
    const probe = instrumentQueues(testEnv);
    const queued = await sweepDependencies(probe.env);
    for (const sent of probe.sends) {
      if (!isDependencyMessage(sent.body)) continue;
      let acked = false;
      await dependencyMessage(dbEnv, {
        body: sent.body,
        attempts: 1,
        ack: () => {
          acked = true;
        },
        retry: () => {},
      } as unknown as Message<DependencyMessage>);
      expect(acked).toBe(true);
    }
    return queued;
  }

  interface AlertView {
    id: number;
    advisory_id: string;
    name: string;
    version: string;
    path: string;
    severity: string;
    fixed_version: string | null;
    state: string;
    advisory: { summary?: string; aliases?: string[] };
    attribution: string;
  }
  async function alerts(query = ''): Promise<AlertView[]> {
    return (
      await json<{ alerts: AlertView[] }>(
        await call('GET', `/repos/acme/shop/dependency-alerts${query}`),
      )
    ).alerts;
  }

  const adminApp = () =>
    makeApp(
      new Proxy(testEnv, {
        get(target, key, receiver) {
          if (key === 'SECURITY_ADMIN_USER_IDS') return owner.userId;
          return Reflect.get(target, key, receiver);
        },
      }),
    );

  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
    owner = await loginAs(testEnv, 921, 'owner');
    dev = await loginAs(testEnv, 922, 'dev');
    repo = await createRepo(dbEnv, { slug: 'acme/shop', createdBy: owner.userId });
    await run(
      dbEnv,
      "INSERT INTO repo_members (repo_id, user_id, role) VALUES (?, ?, 'write')",
      [repo.id, dev.userId],
    );
    base = await commit(null, {
      'package-lock.json': lock('4.17.20'),
      'README.md': 'x\n',
    });
    await setRef(dbEnv, repo.id, 'main', base);
  });

  it('builds the graph as derived data, reusing the parent for unchanged lockfiles', async () => {
    expect(await match()).toBe(1);
    expect(await peekDerived(dbEnv, repo.id, DEPENDENCIES, base)).not.toBeNull();
    const deps = await json<{ dependencies: unknown[]; snapshot: { cs_id: string } }>(
      await call('GET', '/repos/acme/shop/dependencies'),
    );
    expect(deps.dependencies).toEqual([
      { ecosystem: 'npm', name: 'lodash', version: '4.17.20', path: 'package-lock.json' },
    ]);
    expect(deps.snapshot.cs_id).toBe(base);
    // nothing moved: nothing queued
    expect(await match()).toBe(0);
    const next = await commit(base, {
      'README.md': 'y\n',
      'api/go.sum': 'example.com/m v1.0.0 h1:a=\n',
    });
    await setRef(dbEnv, repo.id, 'main', next);
    expect(await match()).toBe(1);
    const graph = JSON.parse(
      (await peekDerived(dbEnv, repo.id, DEPENDENCIES, next))!,
    ) as { lockfiles: { path: string }[] };
    expect(graph.lockfiles.map((l) => l.path)).toEqual([
      'api/go.sum',
      'package-lock.json',
    ]);
  });

  it('loads an OSV snapshot, raises alerts, fixes and reopens them', async () => {
    await match();
    expect(await alerts()).toEqual([]);
    // only security admins load advisories
    expect(
      (await call('POST', '/admin/advisories', { advisories: [LODASH] })).status,
    ).toBe(403);
    const loaded = await json<{ loaded: number; attribution: string }>(
      await call(
        'POST',
        '/admin/advisories',
        { advisories: [LODASH] },
        owner.headers,
        adminApp(),
      ),
    );
    expect(loaded.loaded).toBe(1);
    expect(loaded.attribution).toContain('CC-BY 4.0');
    // the load resets the snapshot of repos using lodash
    expect(await match()).toBe(1);
    const [alert] = await alerts();
    expect(alert).toMatchObject({
      advisory_id: 'GHSA-35jh-r3h4-6jhm',
      name: 'lodash',
      version: '4.17.20',
      path: 'package-lock.json',
      severity: 'high',
      fixed_version: '4.17.21',
      state: 'open',
      advisory: { summary: 'Command injection in lodash', aliases: ['CVE-2021-23337'] },
    });
    expect(alert!.attribution).toContain('osv.dev');
    // reloading the same entry changes nothing
    const again = await json<{ loaded: number; unchanged: number }>(
      await call(
        'POST',
        '/admin/advisories',
        { advisories: [LODASH] },
        owner.headers,
        adminApp(),
      ),
    );
    expect(again).toMatchObject({ loaded: 0, unchanged: 1 });

    const fixed = await commit(base, { 'package-lock.json': lock('4.17.21') });
    await setRef(dbEnv, repo.id, 'main', fixed);
    await match();
    expect((await alerts('?state=fixed')).map((a) => a.id)).toEqual([alert!.id]);
    const reverted = await commit(fixed, { 'package-lock.json': lock('4.17.19') });
    await setRef(dbEnv, repo.id, 'main', reverted);
    await match();
    expect(await alerts('?state=open')).toMatchObject([
      { id: alert!.id, version: '4.17.19' },
    ]);
    expect(await q(dbEnv, 'SELECT id FROM dependency_alerts')).toHaveLength(1);
  });

  it('dismisses alerts (people only) and files update work for agents to pick up', async () => {
    await loadAdvisories(dbEnv, [LODASH]);
    await match();
    const [alert] = await alerts();
    // agents with issues:write file update work, but never dismiss
    const delegate = await createApiToken(dbEnv, owner.userId, {
      label: 'delegate',
      scopes: ['repo:read', 'repo:write', 'agent:run'],
    });
    const created = await json<{ id: string }>(
      await call('POST', '/agents', { name: 'bumper', kind: 'claude_code' }),
      201,
    );
    const form = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      subject_token: delegate.raw,
      agent_id: created.id,
      resource: 'acme/shop',
      scope: 'contents:write issues:write',
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
    const agent = { authorization: `Bearer ${token.access_token}` };
    expect(
      (
        await call(
          'PATCH',
          `/repos/acme/shop/dependency-alerts/${alert!.id}`,
          { state: 'dismissed', reason: 'not_used' },
          agent,
        )
      ).status,
    ).toBe(403);

    const filed = await json<{
      issue: { number: number; title: string; body: string };
      created: boolean;
      readiness: string;
      risk: string;
    }>(
      await call(
        'POST',
        `/repos/acme/shop/dependency-alerts/${alert!.id}/work`,
        {},
        agent,
      ),
      201,
    );
    expect(filed).toMatchObject({ created: true, risk: 'low', readiness: 'needs-prep' });
    expect(filed.issue.title).toBe(
      'Bump lodash from 4.17.20 to 4.17.21 in package-lock.json',
    );
    expect(filed.issue.body).toContain('GHSA-35jh-r3h4-6jhm');
    const work = await q1<{ readiness: string; risk: string }>(
      dbEnv,
      'SELECT w.readiness, w.risk FROM work_items w JOIN issues i ON i.id = w.issue_id WHERE i.number = ?',
      [filed.issue.number],
    );
    expect(work).toEqual({ readiness: 'needs-prep', risk: 'low' });
    // once is enough
    const twice = await json<{ created: boolean; issue: { number: number } }>(
      await call(
        'POST',
        `/repos/acme/shop/dependency-alerts/${alert!.id}/work`,
        {},
        agent,
      ),
    );
    expect(twice).toMatchObject({
      created: false,
      issue: { number: filed.issue.number },
    });
    expect(
      await q1(
        dbEnv,
        "SELECT 1 FROM audit_events WHERE action = 'dependency_alert.work'",
      ),
    ).not.toBeNull();

    const dismissed = await json<{ alert: AlertView }>(
      await call('PATCH', `/repos/acme/shop/dependency-alerts/${alert!.id}`, {
        state: 'dismissed',
        reason: 'tolerable_risk',
      }),
    );
    expect(dismissed.alert.state).toBe('dismissed');
    // a dismissed alert stays dismissed when the graph is matched again
    await run(dbEnv, 'UPDATE dependency_snapshots SET cs_id = NULL, queued_cs = NULL');
    await match();
    expect((await alerts())[0]!.state).toBe('dismissed');
    expect(
      (await call('POST', `/repos/acme/shop/dependency-alerts/${alert!.id}/work`)).status,
    ).toBe(409);
    // whole-repository write to see alerts at all
    const stranger = await loginAs(testEnv, 923, 'stranger');
    expect(
      (
        await call(
          'GET',
          '/repos/acme/shop/dependency-alerts',
          undefined,
          stranger.headers,
        )
      ).status,
    ).toBe(404);
  });

  it('an approver files ready work; agent guardrails judge it as issue.ready', async () => {
    await loadAdvisories(dbEnv, [LODASH]);
    await match();
    const [alert] = await alerts();
    // an org policy that denies agents marking work ready
    const now = Date.now();
    await run(
      dbEnv,
      "INSERT INTO orgs (id, slug, display_name, created_at) VALUES ('o1', 'acme', 'Acme', ?)",
      [now],
    );
    await run(
      dbEnv,
      "UPDATE repos SET owner_kind = 'org', owner_id = 'o1' WHERE id = ?",
      [repo.id],
    );
    await run(
      dbEnv,
      'INSERT INTO agent_policies (org_id, version, document, created_by, created_at) VALUES (?, 1, ?, ?, ?)',
      [
        'o1',
        JSON.stringify({
          version: 1,
          rules: [{ id: 'no-ready', actions: ['issue.ready'], effect: 'deny' }],
        }),
        owner.userId,
        now,
      ],
    );
    const delegate = await createApiToken(dbEnv, owner.userId, {
      label: 'delegate',
      scopes: ['repo:read', 'repo:write', 'agent:run'],
    });
    const created = await json<{ id: string }>(
      await call('POST', '/agents', {
        name: 'approver',
        kind: 'codex',
        max_scopes: ['contents:read', 'contents:write', 'issues:write', 'queue:approve'],
      }),
      201,
    );
    const token = await json<{ access_token: string }>(
      await app(
        new Request('https://forge.test/oauth/token', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
            subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
            subject_token: delegate.raw,
            agent_id: created.id,
            resource: 'acme/shop',
            scope: 'contents:write issues:write queue:approve',
          }),
        }),
      ),
    );
    const denied = await call(
      'POST',
      `/repos/acme/shop/dependency-alerts/${alert!.id}/work`,
      undefined,
      { authorization: `Bearer ${token.access_token}` },
    );
    expect(((await denied.json()) as { error: { code: string } }).error.code).toBe(
      'policy_denied',
    );
    expect(await q(dbEnv, 'SELECT id FROM issues')).toEqual([]);
    // people are not judged
    const filed = await json<{ readiness: string }>(
      await call('POST', `/repos/acme/shop/dependency-alerts/${alert!.id}/work`),
      201,
    );
    expect(filed.readiness).toBe('ready');
  });

  it('syncs advisories from OSV for packages in use (fetch mocked)', async () => {
    await match();
    const urls: string[] = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith('/v1/querybatch')) {
        const body = JSON.parse(String(init?.body)) as {
          queries: { package: { name: string } }[];
        };
        expect(body.queries).toEqual([{ package: { ecosystem: 'npm', name: 'lodash' } }]);
        return Response.json({
          results: [{ vulns: [{ id: LODASH.id, modified: LODASH.modified }] }],
        });
      }
      if (url.endsWith(`/v1/vulns/${LODASH.id}`)) return Response.json(LODASH);
      return new Response('unexpected', { status: 500 });
    }) as typeof fetch;
    expect(await syncAdvisories(dbEnv, fetcher)).toEqual({
      packages: 1,
      fetched: 1,
      loaded: 1,
    });
    expect(urls).toEqual([
      'https://api.osv.dev/v1/querybatch',
      `https://api.osv.dev/v1/vulns/${LODASH.id}`,
    ]);
    // checked within the day: not asked again
    expect(await syncAdvisories(dbEnv, fetcher)).toEqual({
      packages: 0,
      fetched: 0,
      loaded: 0,
    });
    await match();
    expect((await alerts()).map((a) => a.advisory_id)).toEqual([LODASH.id]);
    // operators can turn the sync off
    const off = new Proxy(dbEnv, {
      get: (t, k, r) => (k === 'OSV_SYNC' ? 'off' : Reflect.get(t, k, r)),
    });
    await run(dbEnv, 'DELETE FROM osv_packages');
    expect(await syncAdvisories(off, fetcher)).toEqual({
      packages: 0,
      fetched: 0,
      loaded: 0,
    });
  });

  it('blocks a merge that adds a vulnerable dependency under a security_alerts rule', async () => {
    await loadAdvisories(dbEnv, [
      LODASH,
      {
        ...LODASH,
        id: 'GHSA-low',
        database_specific: { severity: 'LOW' },
        affected: [
          {
            package: { ecosystem: 'npm', name: 'minimist' },
            ranges: [
              { type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '1.2.6' }] },
            ],
          },
        ],
      },
    ]);
    const safe = await commit(base, { 'package-lock.json': lock('4.17.21') });
    await setRef(dbEnv, repo.id, 'main', safe);
    await json(
      await call('POST', '/repos/acme/shop/rulesets', {
        name: 'Security',
        target: 'branch',
        conditions: { ref_name: { include: ['~DEFAULT_BRANCH'] } },
        rules: [{ type: 'security_alerts', severity: 'high' }],
      }),
      201,
    );
    const head = await commit(safe, {
      'package-lock.json': JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': {},
          'node_modules/lodash': { version: '4.17.20' },
          'node_modules/minimist': { version: '1.2.5' },
        },
      }),
    });
    const pull = (
      await json<{ pull: Pull }>(
        await call(
          'POST',
          '/repos/acme/shop/pulls',
          { title: 'Bump', head_cs: head },
          dev.headers,
        ),
        201,
      )
    ).pull;
    const found = await json<{
      dependencies: { advisory_id: string; severity: string }[];
    }>(await call('GET', `/repos/acme/shop/pulls/${pull.id}/security`));
    expect(found.dependencies.map((d) => [d.advisory_id, d.severity]).sort()).toEqual([
      ['GHSA-35jh-r3h4-6jhm', 'high'],
      ['GHSA-low', 'low'],
    ]);
    const gate = await json<{ gate: { reasons: string[] } }>(
      await call('GET', `/repos/acme/shop/pulls/${pull.id}`),
    );
    expect(gate.gate.reasons).toContain(
      '1 new security alert at high severity or above: GHSA-35jh-r3h4-6jhm in lodash@4.17.20.',
    );
  });
});
