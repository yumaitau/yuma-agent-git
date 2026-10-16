import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../../src/env';
import { cleanDb, loginAs, makeApp, seedSchema } from '../helpers';
import type { TestEnv } from '../helpers';
import { app as honoApp } from '../../src/app';
import { createRepo } from '../../src/db/repos';
// The explicit per-principal sweep lives in test/rbac.test.ts as a literal
// table inside the test body; it is read as text so this matrix can check
// it against the live route table without duplicating it.
import rbacSource from '../rbac.test.ts?raw';

/**
 * Route-table authz matrix (issue #22). The route list is discovered from the
 * Hono app itself, so a new route cannot slip in without a decision here:
 *
 *  1. every /api/* route answers 401 to anonymous callers;
 *  2. every non-API route is on the explicit public allow-list;
 *  3. every repo-scoped route is either in the 3-principal sweep in
 *     test/rbac.test.ts or listed in EXEMPT with the suite that owns it;
 *  4. every repo-scoped route hides a private repo from a signed-in
 *     non-member (404, same answer as a missing repo) — the floor that holds
 *     for exempt routes too.
 */

const testEnv = env as unknown as TestEnv;
const dbEnv = testEnv as unknown as Env;
const SWEEP_SLUG = 'acme/sweep'; // slug used by the rbac.test.ts sweep

interface Endpoint {
  method: string;
  path: string;
}

const key = (e: Endpoint): string => `${e.method} ${e.path}`;

/** Concrete endpoints only — `ALL` entries are middleware (`app.use`). */
function discover(): Endpoint[] {
  const seen = new Set<string>();
  const out: Endpoint[] = [];
  for (const route of honoApp.routes) {
    if (route.method === 'ALL') continue;
    // `:repo{[^/]+/[^/]+}` (refs routes) is the same repo segment as `:repo{.+}`
    const path = route.path.replace(':repo{[^/]+/[^/]+}', ':repo{.+}');
    const endpoint = { method: route.method, path };
    if (seen.has(key(endpoint))) continue;
    seen.add(key(endpoint));
    out.push(endpoint);
  }
  return out;
}

const isRepoScoped = (e: Endpoint): boolean =>
  e.path.startsWith('/api/v1/repos/:repo{.+}/') ||
  e.path.startsWith('/api/v1/repos/:owner/:name');

/** Fill route params with plausible values for `slug`. */
function concrete(pattern: string, slug: string): string {
  return pattern
    .replace(':repo{.+}', slug)
    .replace(':owner/:name', slug)
    .replace(/:hash\b/, '0'.repeat(64))
    .replace(/:name\{\.\+\}/, 'main')
    .replace(/:[A-Za-z_]+(\{[^}]*\})?/g, '1');
}

/** Route pattern → anchored regex over a concrete sweep path. */
function patternRegex(pattern: string, slug: string): RegExp {
  const parts = pattern
    .replace(':repo{.+}', '\u0000')
    .replace(':owner/:name', '\u0000')
    .split(/(:[A-Za-z_]+(?:\{[^}]*\})?)/);
  const source = parts
    .map((part) => {
      if (part.startsWith(':')) return part.includes('{.+}') ? '.+' : '[^/]+';
      return part
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace('\u0000', slug.replace('/', '\\/'));
    })
    .join('');
  return new RegExp(`^${source}$`);
}

/** Entries of the literal `const sweep = [...]` table in test/rbac.test.ts. */
function rbacSweep(): Endpoint[] {
  const start = rbacSource.indexOf('const sweep');
  const end = rbacSource.indexOf('\n    ];', start);
  expect(start, 'rbac.test.ts sweep table not found').toBeGreaterThan(0);
  const block = rbacSource.slice(start, end);
  const entries = [...block.matchAll(/method: '(\w+)',\s*path: (['`])(.*?)\2/g)].map(
    (m) => ({
      method: m[1] as string,
      // drop the query string; template holes become an opaque segment
      path: (m[3] as string).split('?')[0]!.replace(/\$\{[^}]*\}/g, 'X'),
    }),
  );
  // every entry must have parsed — a format drift must fail loudly
  expect(entries.length).toBe((block.match(/method: '/g) ?? []).length);
  return entries;
}

/** Routes reachable without a session. Adding one is a security decision. */
const PUBLIC = new Set([
  'GET /healthz',
  'GET /auth/status',
  'GET /auth/github',
  'GET /auth/github/callback',
  'POST /auth/logout',
  'GET /auth/github/install-callback',
  'POST /webhooks/github', // HMAC-verified
  // agent token exchange (#57): the subject token in the body authenticates
  'POST /oauth/token',
  // sign-in (#27): OIDC redirect/callback and passkey assertions
  'GET /auth/oidc/:provider',
  'GET /auth/oidc/:provider/callback',
  'POST /auth/passkey/options',
  'POST /auth/passkey',
  // MFA step-up: each handler refuses without a session cookie
  'POST /auth/mfa/totp',
  'POST /auth/mfa/passkey/options',
  'POST /auth/mfa/passkey',
  // SCIM 2.0 (#27): its own middleware demands a SCIM bearer token
  'GET /scim/v2/Users',
  'POST /scim/v2/Users',
  'GET /scim/v2/Users/:id',
  'PATCH /scim/v2/Users/:id',
  'DELETE /scim/v2/Users/:id',
  'GET /scim/v2/Groups',
  'POST /scim/v2/Groups',
  'GET /scim/v2/Groups/:id',
  'PATCH /scim/v2/Groups/:id',
  'DELETE /scim/v2/Groups/:id',
  // Git smart HTTP (#31, #32): its own token auth, 401 + WWW-Authenticate
  // for anonymous callers, 404 for unreadable repos (test/git-*.test.ts)
  'GET /:owner/:repo{[^/]+\\.git}/info/refs',
  'POST /:owner/:repo{[^/]+\\.git}/git-upload-pack',
  'POST /:owner/:repo{[^/]+\\.git}/git-receive-pack',
  // CI workload identity (#50): cloud IAM fetches discovery and keys
  // anonymously; the token endpoint demands a per-run request token
  'GET /ci/oidc/.well-known/openid-configuration',
  'GET /ci/oidc/jwks',
  'GET /ci/oidc/token',
  'POST /ci/oidc/token',
]);

/**
 * Repo-scoped routes outside the 3-principal sweep in test/rbac.test.ts, with
 * the suite that owns their role semantics. They still get the stranger→404
 * check below.
 */
const EXEMPT: Record<string, string> = {
  'GET /api/v1/repos/:owner/:name': 'dashboard-api.test.ts',
  'POST /api/v1/repos/:owner/:name/initialize': 'dashboard-api.test.ts',
  'POST /api/v1/repos/:repo{.+}/connect': 'e2e/lifecycle.test.ts',
  'PUT /api/v1/repos/:repo{.+}/members': 'rbac.test.ts admin CRUD',
  'DELETE /api/v1/repos/:repo{.+}/members/:userId': 'rbac.test.ts admin CRUD',
  'POST /api/v1/repos/:repo{.+}/path-rules': 'rbac.test.ts admin CRUD',
  'DELETE /api/v1/repos/:repo{.+}/path-rules/:id': 'rbac.test.ts admin CRUD',
  'GET /api/v1/repos/:repo{.+}/pulls': 'collaboration.test.ts',
  'POST /api/v1/repos/:repo{.+}/pulls': 'collaboration.test.ts',
  'GET /api/v1/repos/:repo{.+}/pulls/:id': 'collaboration.test.ts',
  'POST /api/v1/repos/:repo{.+}/pulls/:id/update': 'collaboration.test.ts',
  'POST /api/v1/repos/:repo{.+}/pulls/:id/review': 'collaboration.test.ts',
  'POST /api/v1/repos/:repo{.+}/pulls/:id/merge': 'collaboration.test.ts',
  'GET /api/v1/repos/:repo{.+}/ci': 'collaboration.test.ts',
  'GET /api/v1/repos/:repo{.+}/ci/detect': 'collaboration.test.ts',
  'PUT /api/v1/repos/:repo{.+}/ci': 'collaboration.test.ts',
  'POST /api/v1/repos/:repo{.+}/ci/runs': 'collaboration.test.ts',
  'GET /api/v1/repos/:repo{.+}/ci/runs/:id/log': 'collaboration.test.ts',
  'POST /api/v1/repos/:repo{.+}/ci/runs/:id/cancel': 'collaboration.test.ts',
  'POST /api/v1/repos/:repo{.+}/ci/runs/:id/retry': 'ci-pipeline-deploy.test.ts',
  'GET /api/v1/repos/:repo{.+}/ci/pipelines': 'ci-planner.test.ts',
  'POST /api/v1/repos/:repo{.+}/ci/pipelines/runs': 'ci-planner.test.ts',
  'POST /api/v1/repos/:repo{.+}/ci/pipelines/runs/:id/cancel': 'ci-planner.test.ts',
  'POST /api/v1/repos/:repo{.+}/agents/tasks': 'agent-runtime.test.ts',
  'GET /api/v1/repos/:repo{.+}/agents/tasks': 'agent-runtime.test.ts',
  'POST /api/v1/repos/:repo{.+}/agents/mcp': 'agent-tools.test.ts, hardening.test.ts',
  'POST /api/v1/repos/:repo{.+}/agents/superfans': 'agent-loop.test.ts',
  'GET /api/v1/repos/:repo{.+}/agents/superfans': 'agent-loop.test.ts',
  'DELETE /api/v1/repos/:repo{.+}/agents/superfans/:component': 'agent-loop.test.ts',
  'GET /api/v1/repos/:repo{.+}/ancestor-distance': 'ancestry.test.ts',
  'GET /api/v1/repos/:repo{.+}/refs/:name{.+}': 'refs.test.ts',
  'GET /api/v1/repos/:repo{.+}/object/blob/:hash': 'objects-api.test.ts',
  'GET /api/v1/repos/:repo{.+}/export/tarball': 'export.test.ts',
  'GET /api/v1/repos/:repo{.+}/export/fast-import': 'export.test.ts',
  'POST /api/v1/repos/:repo{.+}/export/github': 'export.test.ts',
  'POST /api/v1/repos/:repo{.+}/import': 'import.test.ts',
  'GET /api/v1/repos/:repo{.+}/import/:job_id': 'import.test.ts',
  'GET /api/v1/repos/:repo{.+}/issues': 'issues.test.ts',
  'POST /api/v1/repos/:repo{.+}/issues': 'issues.test.ts',
  'GET /api/v1/repos/:repo{.+}/issues/:number': 'issues.test.ts',
  'PATCH /api/v1/repos/:repo{.+}/issues/:number': 'issues.test.ts',
  'DELETE /api/v1/repos/:repo{.+}/issues/:number': 'issues.test.ts',
  'POST /api/v1/repos/:repo{.+}/issues/:number/comments': 'issues.test.ts',
  'PUT /api/v1/repos/:repo{.+}/issues/:number/labels': 'issues.test.ts',
  'PUT /api/v1/repos/:repo{.+}/issues/:number/assignees': 'issues.test.ts',
  'PUT /api/v1/repos/:repo{.+}/issues/:number/lock': 'issues.test.ts',
  'PUT /api/v1/repos/:repo{.+}/issues/:number/pin': 'issues.test.ts',
  'POST /api/v1/repos/:repo{.+}/issues/:number/sub-issues': 'issues.test.ts',
  'PUT /api/v1/repos/:repo{.+}/issues/:number/sub-issues': 'issues.test.ts',
  'DELETE /api/v1/repos/:repo{.+}/issues/:number/sub-issues/:child': 'issues.test.ts',
  'GET /api/v1/repos/:repo{.+}/issue-templates': 'issues.test.ts',
  'GET /api/v1/repos/:repo{.+}/labels': 'issues.test.ts',
  'POST /api/v1/repos/:repo{.+}/labels': 'issues.test.ts',
  'DELETE /api/v1/repos/:repo{.+}/labels/:name': 'issues.test.ts',
  'GET /api/v1/repos/:repo{.+}/milestones': 'issues.test.ts',
  'POST /api/v1/repos/:repo{.+}/milestones': 'issues.test.ts',
  'PATCH /api/v1/repos/:repo{.+}/milestones/:id': 'issues.test.ts',
  'GET /api/v1/repos/:repo{.+}/secrets': 'secrets.test.ts',
  'PUT /api/v1/repos/:repo{.+}/secrets/:name': 'secrets.test.ts',
  'DELETE /api/v1/repos/:repo{.+}/secrets/:name': 'secrets.test.ts',
  'GET /api/v1/repos/:repo{.+}/variables': 'secrets.test.ts',
  'PUT /api/v1/repos/:repo{.+}/variables/:name': 'secrets.test.ts',
  'DELETE /api/v1/repos/:repo{.+}/variables/:name': 'secrets.test.ts',
  'GET /api/v1/repos/:repo{.+}/environments': 'secrets.test.ts',
  'PUT /api/v1/repos/:repo{.+}/environments/:env': 'secrets.test.ts',
  'DELETE /api/v1/repos/:repo{.+}/environments/:env': 'secrets.test.ts',
  'GET /api/v1/repos/:repo{.+}/environment-approvals': 'secrets.test.ts',
  'POST /api/v1/repos/:repo{.+}/environment-approvals/:id': 'secrets.test.ts',
  'GET /api/v1/repos/:repo{.+}/approvals': 'policy.test.ts',
  'POST /api/v1/repos/:repo{.+}/approvals/:id': 'policy.test.ts',
};

/**
 * Routes whose non-member answer is not 404, with why that still reveals
 * nothing (the same status comes back for a repo that does not exist).
 */
const STRANGER_STATUS: Record<string, number> = {
  // token-only: refuses session principals before any repo lookup
  'POST /api/v1/repos/:repo{.+}/agents/mcp': 403,
};

async function send(
  endpoint: Endpoint,
  slug: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  const hasBody = endpoint.method !== 'GET' && endpoint.method !== 'DELETE';
  return makeApp(testEnv)(
    new Request(`https://x${concrete(endpoint.path, slug)}`, {
      method: endpoint.method,
      headers: { 'content-type': 'application/json', ...headers },
      body: hasBody ? '{}' : undefined,
    }),
  );
}

describe('route-table authz matrix', () => {
  beforeEach(async () => {
    await seedSchema(testEnv);
    await cleanDb(testEnv);
  });

  it('discovers a non-trivial route table', () => {
    const endpoints = discover();
    expect(endpoints.length).toBeGreaterThan(50);
    expect(endpoints.filter(isRepoScoped).length).toBeGreaterThan(40);
  });

  it('every /api/* route refuses anonymous callers with 401', async () => {
    await createRepo(dbEnv, { slug: SWEEP_SLUG, visibility: 'public' });
    for (const endpoint of discover().filter((e) => e.path.startsWith('/api/'))) {
      // public repo on purpose: visibility must not open the API to anonymous
      const res = await send(endpoint, SWEEP_SLUG);
      expect(res.status, `${key(endpoint)} as anon`).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('unauthorized');
    }
  });

  it('every non-API route is on the public allow-list (and vice versa)', () => {
    const open = discover()
      .filter((e) => !e.path.startsWith('/api/'))
      .map(key);
    expect(open.sort()).toEqual([...PUBLIC].sort());
  });

  it('every repo-scoped route is in the rbac.test.ts sweep or explicitly exempt', () => {
    const sweep = rbacSweep();
    const repoRoutes = discover().filter(isRepoScoped);
    const covered = (e: Endpoint): boolean => {
      const re = patternRegex(e.path, SWEEP_SLUG);
      return sweep.some((s) => s.method === e.method && re.test(s.path));
    };

    const missing = repoRoutes.filter((e) => !covered(e) && !(key(e) in EXEMPT));
    expect(missing.map(key), 'add these to the rbac.test.ts sweep or EXEMPT').toEqual([]);

    // exemptions must stay honest: no stale entries, no double bookkeeping
    const live = new Set(repoRoutes.map(key));
    const stale = Object.keys(EXEMPT).filter((k) => !live.has(k));
    expect(stale, 'EXEMPT names routes that no longer exist').toEqual([]);
    const redundant = repoRoutes.filter((e) => covered(e) && key(e) in EXEMPT);
    expect(redundant.map(key), 'already in the rbac.test.ts sweep').toEqual([]);

    // every sweep entry still matches a live route (catches path typos)
    for (const entry of sweep) {
      const live = repoRoutes.some(
        (e) =>
          e.method === entry.method && patternRegex(e.path, SWEEP_SLUG).test(entry.path),
      );
      expect(live, `rbac.test.ts sweep entry ${key(entry)} matches no route`).toBe(true);
    }
  });

  it('every repo-scoped route hides a private repo from signed-in non-members', async () => {
    const owner = await loginAs(testEnv, 1, 'ada');
    const stranger = await loginAs(testEnv, 2, 'mallory');
    await createRepo(dbEnv, {
      slug: SWEEP_SLUG,
      visibility: 'private',
      createdBy: owner.userId,
    });
    for (const endpoint of discover().filter(isRepoScoped)) {
      const res = await send(endpoint, SWEEP_SLUG, stranger.headers);
      const expected = STRANGER_STATUS[key(endpoint)] ?? 404;
      expect(res.status, `${key(endpoint)} as non-member`).toBe(expected);
      // indistinguishable from a repo that does not exist
      const missing = await send(endpoint, 'acme/missing', stranger.headers);
      expect(missing.status, `${key(endpoint)} on a missing repo`).toBe(res.status);
    }
  });
});
