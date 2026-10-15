/**
 * API reference generator (issue #22).
 *
 * Discovers every route from the real Hono app instead of parsing source text:
 * `src/app.ts` is bundled in memory with esbuild (no `cloudflare:` imports, so
 * it loads under plain Node), imported from a data: URL, and `app.routes` is
 * read — method + full path, `/api/v1` mount prefix included, loop-generated
 * routes included. Middleware entries (`ALL`) are skipped.
 *
 * Access columns are derived from each handler's (bundled) source: which RBAC
 * guard it calls, whether it requires a browser session, which token scope it
 * checks. The rate-limit bucket comes from calling the real `bucketFor()`.
 *
 * Only the regions between `<!-- generated:<name>:start -->` and
 * `<!-- generated:<name>:end -->` in docs/api.md are rewritten; everything else
 * is curated prose and is left byte-for-byte untouched. If docs/api.md does not
 * exist a skeleton is written. Output is sorted and prettier-formatted, so a
 * second run is a no-op.
 *
 * Usage: npm run docs:api -w worker
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';
import * as prettier from 'prettier';

interface HonoRoute {
  method: string;
  path: string;
  handler: { toString(): string };
}

interface WorkerModule {
  app: { routes: HonoRoute[] };
  bucketFor: (method: string, path: string) => string | null;
  BUCKETS: Record<string, number>;
  TOKEN_SCOPES: readonly string[];
}

interface Row {
  method: string;
  path: string;
  auth: string;
  perm: string;
  bucket: string;
  purpose: string;
}

const workerDir = dirname(import.meta.dirname);
const docPath = join(workerDir, '..', 'docs', 'api.md');

/** One-line purposes, keyed by `METHOD display-path`. New routes show up as gaps. */
const PURPOSES: Record<string, string> = {
  'GET /healthz': 'Liveness probe: `{ok: true}`',
  'GET /auth/status': 'Whether GitHub OAuth is configured',
  'GET /auth/github': 'Start GitHub OAuth login (302 to GitHub)',
  'GET /auth/github/callback': 'OAuth callback: sets `yag_session`, 302 to `/`',
  'GET /auth/github/install-callback': 'GitHub App post-install landing: echoes `state`',
  'POST /auth/logout': 'Revoke the session and clear the cookie',
  'POST /webhooks/github': 'GitHub App webhook receiver',
  'GET /api/v1': 'API root: `{ok, service, api: "v1"}`',
  'GET /api/v1/admin/metrics': 'Operational metrics (`?component=&window=`)',
  'POST /api/v1/agents/superfans': 'Start a long-lived per-component monitor',
  'GET /api/v1/agents/tasks/:id': 'Agent task row plus live agent state',
  'POST /api/v1/agents/tasks/:id/cancel': 'Cancel an agent task',
  'GET /api/v1/agents/tasks/:id/transcript': 'Transcript entries (`?since=` ms)',
  'POST /api/v1/cache-token': 'Mint a signed `cache_token` for one URL',
  'GET /api/v1/github/install-url': '302 to the GitHub App install page',
  'GET /api/v1/tokens': 'List your API tokens (metadata only)',
  'POST /api/v1/tokens': 'Create an API token (raw value returned once)',
  'DELETE /api/v1/tokens/:id': 'Revoke one of your API tokens',
  'GET /api/v1/repos': 'List repos visible to the caller (keyset paged)',
  'POST /api/v1/repos': 'Create a repo (creator becomes admin)',
  'GET /api/v1/repos/:owner/:name': 'Repo metadata plus `can_admin`',
  'POST /api/v1/repos/:owner/:name/initialize':
    'Seed `README.md` on an empty repo default branch',
  'POST /api/v1/repos/:repo/agents/mcp': 'MCP JSON-RPC 2.0 endpoint',
  'GET /api/v1/repos/:repo/agents/tasks': 'List agent tasks (`?status=&limit=`)',
  'POST /api/v1/repos/:repo/agents/tasks': 'Queue an agent task',
  'GET /api/v1/repos/:repo/ancestor-distance':
    'First-parent distance between `a` and `b`',
  'GET /api/v1/repos/:repo/blame': 'Line ranges to changesets for one file',
  'PUT /api/v1/repos/:repo/blob': 'Pre-upload a blob (hash-verified, max 64 MiB)',
  'GET /api/v1/repos/:repo/changed-paths': 'Files changed by one changeset',
  'GET /api/v1/repos/:repo/changesets': 'First-parent changeset log (cursor paged)',
  'POST /api/v1/repos/:repo/changesets': 'Commit: create a changeset (never moves refs)',
  'GET /api/v1/repos/:repo/changesets/:id': 'One changeset',
  'GET /api/v1/repos/:repo/checkout-info': 'Root tree and size estimate for a checkout',
  'GET /api/v1/repos/:repo/ci': 'CI policy, recent runs, budget and capabilities',
  'PUT /api/v1/repos/:repo/ci': 'Save the CI policy',
  'GET /api/v1/repos/:repo/ci/detect': 'Suggest CI commands from the default branch',
  'POST /api/v1/repos/:repo/ci/runs': 'Queue a CI run',
  'POST /api/v1/repos/:repo/ci/runs/:id/cancel': 'Cancel a CI run',
  'GET /api/v1/repos/:repo/ci/runs/:id/log': 'CI run log (`text/plain`)',
  'POST /api/v1/repos/:repo/connect': 'Link the repo to a GitHub repo via the App',
  'GET /api/v1/repos/:repo/diff': 'Server-side diff between two revisions',
  'POST /api/v1/repos/:repo/export/github': 'Queue a push of a revision to GitHub',
  'GET /api/v1/repos/:repo/export/fast-import': 'Stream a `git fast-import` export',
  'GET /api/v1/repos/:repo/export/tarball': 'Stream a `.tar.gz` of one revision',
  'POST /api/v1/repos/:repo/fetch-objects': 'Batched want-only object fetch',
  'GET /api/v1/repos/:repo/file': 'Read one file at a revision',
  'GET /api/v1/repos/:repo/history': 'First-parent or per-path history',
  'POST /api/v1/repos/:repo/import': 'Queue a GitHub import job',
  'GET /api/v1/repos/:repo/import/:job_id': 'Import job progress',
  'GET /api/v1/repos/:repo/is-ancestor': 'Whether `a` is a first-parent ancestor of `b`',
  'GET /api/v1/repos/:repo/members': 'List repo members',
  'PUT /api/v1/repos/:repo/members': 'Add or change a member role',
  'DELETE /api/v1/repos/:repo/members/:userId': 'Remove a member',
  'GET /api/v1/repos/:repo/merge-base': 'Merge base of `a` and `b`',
  'GET /api/v1/repos/:repo/object/blob/:hash': 'One blob (`?encoding=zstd|identity`)',
  'GET /api/v1/repos/:repo/object/tree/:hash': 'One tree object',
  'GET /api/v1/repos/:repo/path-rules': 'List directory-level permission rules',
  'POST /api/v1/repos/:repo/path-rules': 'Add a path rule',
  'DELETE /api/v1/repos/:repo/path-rules/:id': 'Delete a path rule',
  'GET /api/v1/repos/:repo/pulls': 'List pull requests (50 per page)',
  'POST /api/v1/repos/:repo/pulls': 'Open a pull request',
  'GET /api/v1/repos/:repo/pulls/:id': 'Pull request, reviews and merge gate',
  'POST /api/v1/repos/:repo/pulls/:id/merge': 'Merge a pull request',
  'POST /api/v1/repos/:repo/pulls/:id/review': 'Comment, approve or request changes',
  'POST /api/v1/repos/:repo/pulls/:id/update': 'Edit title/body/state or move the head',
  'GET /api/v1/repos/:repo/refs': 'List refs',
  'GET /api/v1/repos/:repo/refs/:name': 'One ref',
  'PUT /api/v1/repos/:repo/refs/:name': 'Compare-and-swap move a ref',
  'GET /api/v1/repos/:repo/tree': 'List a directory at a revision',
};

const METHOD_ORDER = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

/** `:repo{.+}` → `:repo` — the regex is a router detail, not part of the contract. */
function displayPath(path: string): string {
  return path.replace(/\{[^}]*\}/g, '');
}

/** A concrete path for `bucketFor()` (which only looks at path shape). */
function samplePath(path: string): string {
  return displayPath(path)
    .replace(/:repo\b/g, 'owner/name')
    .replace(/:\w+/g, 'x');
}

/**
 * Derive access requirements from the handler source. Returns `null` for the
 * permission when a repo-scoped route calls no recognised guard.
 */
function classify(path: string, src: string): { auth: string; perm: string | null } {
  if (path.startsWith('/webhooks/')) return { auth: 'HMAC', perm: '—' };
  if (!path.startsWith('/api/')) return { auth: 'none', perm: '—' };

  let auth = 'any';
  if (
    (/c\.get\("user"\)/.test(src) && /session required/.test(src)) ||
    /requireSession\d*\(/.test(src)
  ) {
    auth = 'session';
  }
  if (/principal\.kind !== "token"/.test(src)) auth = 'token';

  const parts: string[] = [];
  const whole = /loadWholeRepo\(\s*c,\s*([^,]+?),/.exec(src);
  if (whole) {
    const arg = (whole[1] as string).trim();
    const literal = /^"(read|write|admin)"$/.exec(arg);
    if (literal) parts.push(`${literal[1]} (whole repo)`);
    else if (/publish \? "admin" : "write"/.test(arg)) {
      parts.push('write (whole repo); admin if `publish`');
    } else parts.push(`? (${arg})`);
  } else if (/loadAdminRepo\d*\(/.test(src)) parts.push('admin');
  else if (/loadWritableRepo(ById)?\d*\(/.test(src)) parts.push('write');
  else if (/loadReadableRepo(ById)?\d*\(/.test(src)) parts.push('read');
  else if (/\bcan\d*\([^;]*?"write"\)/.test(src)) parts.push('write');
  else if (/\bcan\d*\([^;]*?"admin"\)/.test(src)) parts.push('admin on any repo');

  if (/guardPathRead\d*\(/.test(src)) parts.push('path:read');
  if (/guardPathHistory\d*\(/.test(src)) parts.push('path:history');
  if (/"agent:run"/.test(src)) parts.push('`agent:run`');
  if (/scope === "repo:read" \|\| scope === "repo:write"/.test(src)) {
    parts.push('token needs `repo:read` or `repo:write`');
  }

  if (parts.length === 0) {
    return { auth, perm: path.includes('/repos/:') ? null : '—' };
  }
  return { auth, perm: parts.join(' + ') };
}

async function loadWorker(): Promise<WorkerModule> {
  const result = await build({
    stdin: {
      contents: [
        "export { app } from './src/app';",
        "export { bucketFor, BUCKETS } from './src/middleware/ratelimit';",
        "export { TOKEN_SCOPES } from './src/auth/tokens';",
      ].join('\n'),
      resolveDir: workerDir,
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    logLevel: 'error',
  });
  const code = (result.outputFiles[0] as { text: string }).text;
  const url = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
  return (await import(url)) as WorkerModule;
}

function collectRows(mod: WorkerModule): { rows: Row[]; warnings: string[] } {
  const warnings: string[] = [];
  const seen = new Set<string>();
  const rows: Row[] = [];
  for (const route of mod.app.routes) {
    if (route.method === 'ALL') continue; // middleware
    const path = displayPath(route.path);
    const key = `${route.method} ${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const { auth, perm } = classify(path, route.handler.toString());
    if (perm === null) warnings.push(`no RBAC guard recognised: ${key}`);
    const purpose = PURPOSES[key];
    if (purpose === undefined) warnings.push(`no purpose text: ${key}`);
    rows.push({
      method: route.method,
      path,
      auth,
      perm: perm ?? '**unclassified**',
      bucket: mod.bucketFor(route.method, samplePath(route.path)) ?? 'exempt',
      purpose: purpose ?? '**undocumented**',
    });
  }
  for (const key of Object.keys(PURPOSES)) {
    if (!seen.has(key))
      warnings.push(`purpose for a route that no longer exists: ${key}`);
  }
  rows.sort(
    (a, b) =>
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
      METHOD_ORDER.indexOf(a.method) - METHOD_ORDER.indexOf(b.method),
  );
  return { rows, warnings };
}

function table(header: string[], rows: string[][]): string {
  const line = (cells: string[]) =>
    `| ${cells.map((cell) => cell.replace(/\|/g, '\\|')).join(' | ')} |`;
  return [line(header), line(header.map(() => '---')), ...rows.map(line)].join('\n');
}

function regions(mod: WorkerModule, rows: Row[]): Record<string, string> {
  return {
    routes: [
      `${rows.length} routes. Auth: \`any\` = session cookie or bearer token, \`session\` = browser session only, \`token\` = bearer token only. Every \`/api/*\` route rejects anonymous callers with 401 before any of these checks run.`,
      '',
      table(
        ['Method', 'Path', 'Auth', 'Permission', 'Rate bucket', 'Purpose'],
        rows.map((r) => [r.method, `\`${r.path}\``, r.auth, r.perm, r.bucket, r.purpose]),
      ),
    ].join('\n'),
    'rate-limits': table(
      ['Bucket', 'Requests per minute'],
      Object.entries(mod.BUCKETS)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([bucket, limit]) => [`\`${bucket}\``, String(limit)]),
    ),
    scopes: mod.TOKEN_SCOPES.map((scope) => `- \`${scope}\``).join('\n'),
  };
}

const SKELETON = `# API reference

<!-- Curated prose lives outside the generated:* markers; \`npm run docs:api -w worker\` rewrites only the marked regions. -->

## Authentication

<!-- generated:scopes:start -->
<!-- generated:scopes:end -->

## Rate limits

<!-- generated:rate-limits:start -->
<!-- generated:rate-limits:end -->

## Routes

<!-- generated:routes:start -->
<!-- generated:routes:end -->
`;

async function main(): Promise<void> {
  const mod = await loadWorker();
  const { rows, warnings } = collectRows(mod);
  const options = { ...(await prettier.resolveConfig(docPath)), parser: 'markdown' };

  let doc: string;
  try {
    doc = await readFile(docPath, 'utf8');
  } catch {
    doc = SKELETON;
  }

  let next = doc;
  for (const [name, body] of Object.entries(regions(mod, rows))) {
    const start = `<!-- generated:${name}:start -->`;
    const end = `<!-- generated:${name}:end -->`;
    const from = next.indexOf(start);
    const to = next.indexOf(end);
    if (from === -1 || to === -1 || to < from) {
      throw new Error(`${docPath}: missing or misordered ${start} / ${end} markers`);
    }
    const formatted = (await prettier.format(body, options)).trimEnd();
    next = `${next.slice(0, from + start.length)}\n\n${formatted}\n\n${next.slice(to)}`;
  }

  if (next !== doc) await writeFile(docPath, next, 'utf8');
  console.log(
    `docs/api.md: ${rows.length} routes${next === doc ? ' (unchanged)' : ' (updated)'}`,
  );
  for (const warning of warnings) console.warn(`warning: ${warning}`);
}

await main();
