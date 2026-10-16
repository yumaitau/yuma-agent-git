/**
 * API reference generator (issues #22, #28).
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
 * The same route walk writes docs/openapi.json (OpenAPI 3.1): operation ids,
 * query parameters and request bodies come from `src/api/contract.ts` (the zod
 * schemas the handlers parse with), auth and permission from `classify()`.
 * Any warning (a route without a contract entry, an undeclared query key or
 * body) makes the run exit non-zero so CI catches it.
 *
 * Usage: npm run docs:api -w worker (or `npm run docs:openapi` at the root)
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';
import * as prettier from 'prettier';

interface ZodLike {
  safeParse(value: unknown): { success: boolean };
}

interface RouteContract {
  id: string;
  query?: ZodLike & { shape: Record<string, ZodLike> };
  body?: ZodLike;
  rawBody?: string;
  deprecated?: boolean;
}

type JsonObject = Record<string, unknown>;

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
  API_CONTRACT: Record<string, RouteContract>;
  apiErrorSchema: ZodLike;
  displayPath: (path: string) => string;
  openApiPath: (path: string) => string;
  jsonSchema: (schema: ZodLike) => JsonObject;
}

interface Row {
  method: string;
  path: string;
  auth: string;
  perm: string;
  bucket: string;
  purpose: string;
  /** Hono path as registered (regex params included). */
  rawPath: string;
  /** Handler returns JSON / redirects / the error envelope (from its source). */
  json: boolean;
  redirect: boolean;
  envelope: boolean;
}

const workerDir = dirname(import.meta.dirname);
const docPath = join(workerDir, '..', 'docs', 'api.md');
const openapiPath = join(workerDir, '..', 'docs', 'openapi.json');

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
  'GET /api/v1/openapi.json': 'This API as an OpenAPI 3.1 document',
  'GET /api/v1/admin/metrics': 'Operational metrics (`?component=&window=`)',
  'GET /api/v1/agents/tasks/:id': 'Agent task row plus live agent state',
  'POST /api/v1/agents/tasks/:id/cancel': 'Cancel an agent task',
  'GET /api/v1/agents/tasks/:id/transcript': 'Transcript entries (`?since=` ms)',
  'POST /api/v1/cache-token': 'Mint a signed `cache_token` for one URL',
  'GET /api/v1/github/install-url': '302 to the GitHub App install page',
  'GET /api/v1/tokens': 'List your API tokens (metadata only)',
  'POST /api/v1/tokens': 'Create an API token (raw value returned once)',
  'DELETE /api/v1/tokens/:id': 'Revoke one of your API tokens',
  'POST /oauth/token':
    'Token endpoint: RFC 8693 exchange (`agent:run` API token to agent), app installation tokens (JWT bearer), OAuth app and MCP authorization codes (PKCE) and MCP refresh grants',
  'GET /api/v1/user': 'The person a session or user token belongs to (OAuth sign-in)',
  'GET /api/v1/oauth-apps': 'OAuth apps you manage',
  'POST /api/v1/oauth-apps': 'Register an OAuth app (client secret returned once)',
  'DELETE /api/v1/oauth-apps/:id': 'Delete an OAuth app and revoke its tokens',
  'GET /api/v1/oauth/authorize': 'Check an authorization request for the consent page',
  'POST /api/v1/oauth/authorize':
    'Approve or deny an authorization request (returns the redirect)',
  'GET /api/v1/apps': 'Apps you manage',
  'POST /api/v1/apps':
    'Create an app (private key returned once), optionally with its webhook',
  'GET /api/v1/apps/:id': 'An app you manage, its installations and webhook',
  'DELETE /api/v1/apps/:id': 'Delete an app, its installations, tokens and webhook',
  'POST /api/v1/apps/:id/installations': 'Install an app on repositories you administer',
  'GET /api/v1/installations': 'App installations you made',
  'DELETE /api/v1/installations/:id': 'Remove an installation (its tokens stop at once)',
  'GET /api/v1/repos/:repo/hooks': 'List repository webhooks',
  'GET /api/v1/repos/:repo/packages': 'Packages linked to the repo (registry, #53)',
  'PATCH /api/v1/repos/:repo/packages/:id':
    'Set a package retention rule (`keep_untagged`)',
  'GET /v2/': 'OCI registry ping; 401 with the Bearer token challenge when signed out',
  'GET /v2/token':
    'Exchange a forge credential (HTTP Basic) for a short-lived registry token',
  'POST /v2/token': 'OAuth2 password grant for a registry token (oras-go, helm)',
  'GET /v2/:name/blobs/:digest': 'Fetch (or HEAD) a blob linked to the image',
  'POST /v2/:name/blobs/uploads/':
    'Start a blob upload; monolithic with `digest`, cross-repo with `mount`',
  'GET /v2/:name/blobs/uploads/:uuid': 'Upload progress (Range)',
  'PATCH /v2/:name/blobs/uploads/:uuid': 'Append a chunk, streamed to R2',
  'PUT /v2/:name/blobs/uploads/:uuid':
    'Finish an upload; the digest is checked as R2 stores it',
  'DELETE /v2/:name/blobs/uploads/:uuid': 'Cancel an upload',
  'GET /v2/:name/manifests/:reference': 'Fetch (or HEAD) a manifest by tag or digest',
  'PUT /v2/:name/manifests/:reference': 'Push a manifest or index, tagged or by digest',
  'DELETE /v2/:name/manifests/:reference': 'Delete a tag, or a manifest by digest',
  'GET /v2/:name/tags/list': 'List tags (`n`, `last` pagination)',
  'GET /v2/:name/referrers/:digest':
    'Referrers API: manifests whose subject is the digest',
  'GET /npm/-/whoami': 'npm whoami: the login of the token',
  'GET /npm/-/package/:pkg/dist-tags': 'npm dist-tags of a package',
  'PUT /npm/-/package/:pkg/dist-tags/:tag': 'Point a dist-tag at a version',
  'DELETE /npm/-/package/:pkg/dist-tags/:tag': 'Remove a dist-tag (not `latest`)',
  'GET /npm/:scope/:name/-/:file': 'npm tarball',
  'GET /npm/:scope/:name': 'npm package document',
  'GET /npm/:pkg': 'npm package document (`@scope%2fname`, as npm asks)',
  'PUT /npm/:pkg': 'npm publish: one version and its tarball',
  'POST /api/v1/repos/:repo/hooks': 'Create a repository webhook',
  'GET /api/v1/repos/:repo/mirrors': 'List pull and push mirrors with their last sync',
  'POST /api/v1/repos/:repo/mirrors':
    'Create a pull or push mirror (token write-only; `github_app` reaches the connected GitHub repo only)',
  'PATCH /api/v1/repos/:repo/mirrors/:id':
    'Change a mirror remote, token, interval or state (a new remote URL needs the token again)',
  'DELETE /api/v1/repos/:repo/mirrors/:id': 'Delete a mirror',
  'POST /api/v1/repos/:repo/mirrors/:id/sync': 'Sync a mirror now and return the outcome',
  'GET /api/v1/repos/:repo/migration': 'Cutover state and the checks for each next move',
  'POST /api/v1/repos/:repo/migration': 'Move the cutover state (checked; audited)',
  'GET /api/v1/orgs/:org/hooks': 'List org webhooks',
  'POST /api/v1/orgs/:org/hooks': 'Create an org webhook (all org repositories)',
  'GET /api/v1/hooks/:id': 'A webhook (never its secret)',
  'PATCH /api/v1/hooks/:id': 'Change a webhook URL, secret, events, format or state',
  'DELETE /api/v1/hooks/:id': 'Delete a webhook and its delivery log',
  'GET /api/v1/hooks/:id/deliveries':
    'Recent deliveries: status, attempts, response code',
  'POST /api/v1/hooks/:id/deliveries/:delivery/redeliver': 'Send a delivery again',
  'POST /oauth/register': 'RFC 7591 dynamic registration of a public MCP client',
  'GET /oauth/authorize':
    'Consent page: MCP clients pick agent, repos and scopes; OAuth apps get the dashboard',
  'POST /oauth/authorize': 'Approve or deny MCP consent; 302 back to the client',
  'GET /.well-known/oauth-authorization-server': 'RFC 8414 authorization server metadata',
  'GET /.well-known/oauth-protected-resource':
    'RFC 9728 metadata for the `/mcp` resource',
  'GET /.well-known/oauth-protected-resource/mcp':
    'RFC 9728 metadata for `/mcp` (path-inserted form)',
  'POST /mcp': 'MCP Streamable HTTP: one JSON-RPC message (docs/mcp.md)',
  'GET /mcp': 'MCP: resume an SSE stream after `Last-Event-ID`',
  'DELETE /mcp': 'MCP: end the session',
  'GET /api/v1/agents': 'Agent identities you manage, with live token counts',
  'POST /api/v1/agents': 'Create an agent identity (you or an org own it)',
  'PATCH /api/v1/agents/:id': 'Disable (kill switch, revokes tokens) or enable an agent',
  'DELETE /api/v1/agents/:id/tokens': 'Revoke every live token of an agent',
  'GET /api/v1/repos': 'List repos visible to the caller (keyset paged)',
  'GET /api/v1/search/code':
    'Search file contents across readable repos (text or regex; repo, path, lang, rev filters)',
  'GET /api/v1/search/paths':
    'Find files by path across readable repos (fuzzy file finder)',
  'POST /api/v1/repos': 'Create a repo (creator becomes admin)',
  'GET /api/v1/repos/:owner/:name': 'Repo metadata plus `can_admin`',
  'POST /api/v1/repos/:owner/:name/initialize':
    'Seed `README.md` on an empty repo default branch',
  'POST /api/v1/repos/:repo/agents/mcp':
    'Deprecated per-repo MCP JSON-RPC subset; use `/mcp`',
  'GET /api/v1/repos/:repo/agents/superfans':
    "List the repo's superfans and their findings",
  'POST /api/v1/repos/:repo/agents/superfans':
    'Start a per-component monitor on this repo',
  'DELETE /api/v1/repos/:repo/agents/superfans/:component': 'Stop a superfan',
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
  'POST /api/v1/repos/:repo/ci/runs/:id/retry':
    'Run a CI run again with its original trigger',
  'GET /api/v1/repos/:repo/ci/runs/:id/log': 'CI run log (`text/plain`)',
  'GET /api/v1/repos/:repo/codeowners':
    'CODEOWNERS at a revision: rules, resolved owners, errors and the owners of a path',
  'GET /api/v1/repos/:repo/ci/pipelines':
    'Pipeline runs with their jobs and spec errors (`?head=`)',
  'POST /api/v1/repos/:repo/ci/pipelines/runs': 'Start a pipeline with a manual trigger',
  'POST /api/v1/repos/:repo/ci/pipelines/runs/:id/cancel': 'Cancel a pipeline run',
  'GET /ci/oidc/.well-known/openid-configuration': 'CI OIDC discovery document (public)',
  'GET /ci/oidc/jwks': 'CI OIDC signing keys, current and previous (public)',
  'GET /ci/oidc/token': 'ID token for a running job (`?audience=`), GitHub-style GET',
  'POST /ci/oidc/token': 'ID token for a running job (`?audience=&lifetime=`)',
  'POST /runner/v1/register':
    'Register a self-hosted runner with a one-time token (credential returned once)',
  'POST /runner/v1/jobs/claim':
    'Long-poll for a job matching the runner labels (`?wait=`)',
  'POST /runner/v1/jobs/:id/heartbeat':
    'Extend the job lease; says whether it was cancelled',
  'POST /runner/v1/jobs/:id/logs': 'Append a masked log chunk to a step (`?step=`)',
  'POST /runner/v1/jobs/:id/steps/:step': 'Report a step state and exit code',
  'PUT /runner/v1/jobs/:id/artifacts/:name': 'Upload a job artifact (100 MiB at most)',
  'POST /runner/v1/jobs/:id/complete': 'Report the job result and release the runner',
  'POST /api/v1/orgs/:org/runners/registration-token':
    'One-time org runner registration token (1 hour, recent MFA)',
  'GET /api/v1/orgs/:org/runners': 'Org self-hosted runners',
  'PATCH /api/v1/orgs/:org/runners/:id':
    'Disable, enable or mark an org runner trusted-only',
  'DELETE /api/v1/orgs/:org/runners/:id': 'Revoke an org runner and fail its running job',
  'POST /api/v1/repos/:repo/runners/registration-token':
    'One-time repo runner registration token (1 hour, recent MFA)',
  'GET /api/v1/repos/:repo/runners': 'Repo self-hosted runners',
  'PATCH /api/v1/repos/:repo/runners/:id':
    'Disable, enable or mark a repo runner trusted-only',
  'DELETE /api/v1/repos/:repo/runners/:id':
    'Revoke a repo runner and fail its running job',
  'GET /api/v1/repos/:repo/secrets':
    'Secret names (`?environment=`); values are write-only',
  'PUT /api/v1/repos/:repo/secrets/:name': 'Set a secret `{value}` (`?environment=`)',
  'DELETE /api/v1/repos/:repo/secrets/:name': 'Delete a secret (`?environment=`)',
  'GET /api/v1/repos/:repo/variables': 'Variables with values (`?environment=`)',
  'PUT /api/v1/repos/:repo/variables/:name': 'Set a variable `{value}` (`?environment=`)',
  'DELETE /api/v1/repos/:repo/variables/:name': 'Delete a variable (`?environment=`)',
  'GET /api/v1/repos/:repo/environments': 'Deployment environments and protection rules',
  'PUT /api/v1/repos/:repo/environments/:env': 'Create or update an environment',
  'DELETE /api/v1/repos/:repo/environments/:env':
    'Delete an environment and its secrets and variables',
  'GET /api/v1/repos/:repo/environment-approvals':
    'Runs waiting on environments (`?state=`)',
  'POST /api/v1/repos/:repo/environment-approvals/:id':
    'Approve or reject a waiting run (listed reviewers, not the requester)',
  'GET /api/v1/orgs/:org/secrets': 'Org secret names; values are write-only',
  'PUT /api/v1/orgs/:org/secrets/:name': 'Set an org secret `{value}`',
  'DELETE /api/v1/orgs/:org/secrets/:name': 'Delete an org secret',
  'GET /api/v1/orgs/:org/variables': 'Org variables with values',
  'PUT /api/v1/orgs/:org/variables/:name': 'Set an org variable `{value}`',
  'DELETE /api/v1/orgs/:org/variables/:name': 'Delete an org variable',
  'POST /api/v1/admin/secrets/rewrap':
    'Re-wrap secret data keys under the current KEK (`SECRETS_ADMIN_USER_IDS`)',
  'GET /api/v1/admin/agents/pause': 'Whether every agent on the instance is paused',
  'POST /api/v1/admin/agents/pause':
    'Pause every agent: revoke agent tokens, cancel runs (`AGENTS_ADMIN_USER_IDS`)',
  'DELETE /api/v1/admin/agents/pause': 'Resume agents on the instance',
  'POST /api/v1/policy/test':
    'Run an agent policy (or the default pack) against test cases',
  'GET /api/v1/orgs/:org/policy': 'Agent policy in force (the default pack when unset)',
  'PUT /api/v1/orgs/:org/policy': 'Save a new agent policy version',
  'GET /api/v1/orgs/:org/policy/versions': 'Agent policy version history',
  'GET /api/v1/orgs/:org/agents/pause': 'Org and instance agent pause, and who paused',
  'POST /api/v1/orgs/:org/agents/pause':
    'Pause org agents: revoke their tokens, cancel runs, refuse writes',
  'DELETE /api/v1/orgs/:org/agents/pause': 'Resume org agents',
  'GET /api/v1/repos/:repo/approvals':
    'Agent actions held for a human (`?state=pending|approved|rejected|all`)',
  'POST /api/v1/repos/:repo/approvals/:id': 'Approve or reject a held agent action',
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
  'GET /api/v1/repos/:repo/issues':
    'List issues (`?state=&label=a,b&assignee=&milestone=&before=`) plus pinned issues',
  'POST /api/v1/repos/:repo/issues':
    'Open an issue; labels, assignees, milestone and parent apply with `triage`',
  'GET /api/v1/repos/:repo/issues/:number':
    'Issue with comments, timeline, sub-issues and milestone',
  'PATCH /api/v1/repos/:repo/issues/:number':
    'Edit, close (with reason) or reopen (author or `triage`); milestone needs `triage`',
  'DELETE /api/v1/repos/:repo/issues/:number':
    'Delete an issue (its number is not reused)',
  'POST /api/v1/repos/:repo/issues/:number/comments':
    'Comment on an issue (`triage` when locked)',
  'PUT /api/v1/repos/:repo/issues/:number/labels': "Replace an issue's labels",
  'PUT /api/v1/repos/:repo/issues/:number/assignees':
    'Replace assignees (logins, `user:`, `team:` or `agent:` principals)',
  'PUT /api/v1/repos/:repo/issues/:number/lock': 'Lock or unlock comments (`{on}`)',
  'PUT /api/v1/repos/:repo/issues/:number/pin': 'Pin or unpin (at most 3 per repo)',
  'POST /api/v1/repos/:repo/issues/:number/sub-issues': 'Add a sub-issue (`{number}`)',
  'PUT /api/v1/repos/:repo/issues/:number/sub-issues': 'Reorder sub-issues (`{order}`)',
  'DELETE /api/v1/repos/:repo/issues/:number/sub-issues/:child': 'Remove a sub-issue',
  'GET /api/v1/repos/:repo/issue-templates':
    'Issue templates and forms from `.yuma/` and `.github/ISSUE_TEMPLATE`',
  'GET /api/v1/repos/:repo/labels': 'List labels',
  'POST /api/v1/repos/:repo/labels': 'Create a label',
  'DELETE /api/v1/repos/:repo/labels/:name': 'Delete a label and remove it from issues',
  'GET /api/v1/repos/:repo/milestones': 'List milestones with open and closed counts',
  'POST /api/v1/repos/:repo/milestones': 'Create a milestone',
  'PATCH /api/v1/repos/:repo/milestones/:id': 'Edit, close or reopen a milestone',
  'GET /api/v1/repos/:repo/pulls': 'List pull requests (50 per page)',
  'POST /api/v1/repos/:repo/pulls': 'Open a pull request',
  'GET /api/v1/repos/:repo/pulls/:id': 'Pull request, reviews and merge gate',
  'GET /api/v1/repos/:repo/pulls/:id/conflicts':
    'Would it merge into the current target? Conflicting paths and hunks',
  'POST /api/v1/repos/:repo/pulls/:id/merge':
    'Merge a pull request (merge commit, squash or rebase)',
  'POST /api/v1/repos/:repo/pulls/:id/queue':
    'Add a pull request to its target branch merge queue (agents cannot)',
  'DELETE /api/v1/repos/:repo/pulls/:id/queue':
    'Take a pull request out of the merge queue',
  'GET /api/v1/repos/:repo/merge-queue':
    'Merge queue of a branch: entries in order and groups',
  'POST /api/v1/repos/:repo/pulls/:id/update-branch':
    'Bring the target into the pull request (merge or rebase)',
  'POST /api/v1/repos/:repo/pulls/:id/review':
    'Comment, approve or request changes, with inline comments',
  'GET /api/v1/repos/:repo/pulls/:id/threads': 'Line review threads with their comments',
  'POST /api/v1/repos/:repo/pulls/:id/threads':
    'Comment on lines of the current revision',
  'POST /api/v1/repos/:repo/pulls/:id/threads/:thread/replies':
    'Reply to a review thread',
  'PUT /api/v1/repos/:repo/pulls/:id/threads/:thread/resolution':
    'Resolve or unresolve a review thread',
  'POST /api/v1/repos/:repo/pulls/:id/suggestions/apply':
    'Commit suggested changes onto the head',
  'GET /api/v1/repos/:repo/pulls/:id/codeowners':
    'Code owners of each changed file and whether one approved',
  'GET /api/v1/repos/:repo/pulls/:id/reviewers': 'Requested reviewers and their state',
  'PUT /api/v1/repos/:repo/pulls/:id/reviewers':
    'Request reviews from people, teams, agents',
  'POST /api/v1/repos/:repo/pulls/:id/update': 'Edit title/body/state or move the head',
  'GET /api/v1/repos/:repo/refs': 'List refs',
  'GET /api/v1/repos/:repo/refs/:name': 'One ref',
  'PUT /api/v1/repos/:repo/refs/:name': 'Compare-and-swap move a ref',
  'GET /api/v1/repos/:repo/tree': 'List a directory at a revision',
  'GET /api/v1/repos/:repo/rulesets': 'Repo rulesets plus the org rulesets that reach it',
  'POST /api/v1/repos/:repo/rulesets': 'Create a branch, tag or push ruleset',
  'PUT /api/v1/repos/:repo/rulesets/:id': 'Replace a repo ruleset',
  'DELETE /api/v1/repos/:repo/rulesets/:id': 'Delete a repo ruleset',
  'GET /api/v1/repos/:repo/rulesets/evaluations': 'Evaluate-mode log for this repo',
  'PUT /api/v1/repos/:owner/:name': 'Change the default branch or ref naming mode',
  'GET /api/v1/repos/:repo/tags': 'List tags with annotations (keyset paged)',
  'POST /api/v1/repos/:repo/tags': 'Create a lightweight or annotated tag',
  'GET /api/v1/repos/:repo/releases':
    'List releases, newest first (drafts only for writers; cursor paged)',
  'POST /api/v1/repos/:repo/releases':
    'Create a release from an existing tag (draft, prerelease, generated notes)',
  'GET /api/v1/repos/:repo/releases/latest':
    'The newest published release that is not a prerelease',
  'GET /api/v1/repos/:repo/releases/tags/:tag': 'The release for a tag',
  'POST /api/v1/repos/:repo/releases/generate-notes':
    'Markdown notes from merged pull requests and commits since the previous release',
  'GET /api/v1/repos/:repo/releases/:id': 'One release with its assets and attestations',
  'PATCH /api/v1/repos/:repo/releases/:id':
    'Edit notes or flags; clearing `draft` publishes it',
  'DELETE /api/v1/repos/:repo/releases/:id':
    'Delete a release and its assets (the tag stays)',
  'POST /api/v1/repos/:repo/releases/:id/assets':
    'Upload an asset (`?name=`, Content-Length, SHA-256 computed; org size cap)',
  'GET /api/v1/repos/:repo/releases/:id/assets/:asset':
    'Download an asset, checked against its stored SHA-256 while streaming',
  'DELETE /api/v1/repos/:repo/releases/:id/assets/:asset': 'Delete a release asset',
  'GET /api/v1/repos/:repo/releases/:id/attestations':
    'Build provenance attestations (DSSE envelopes) for a release',
  'POST /api/v1/repos/:repo/releases/:id/attestations':
    'Sign SLSA provenance for assets from a CI ID token (`audience=yag:attest`)',
  'POST /api/v1/repos/:repo/attestations/verify':
    'Verify a DSSE envelope against the published CI keys (optional `sha256` subject)',
  'GET /api/v1/orgs/:org/release-settings': 'Release asset size cap for the org',
  'PUT /api/v1/orgs/:org/release-settings': 'Set the org release asset size cap',
  'GET /api/v1/repos/:repo/work':
    'Work queue items and dependencies (`?readiness=&risk=&claimed_by=`)',
  'POST /api/v1/repos/:repo/work/claim':
    'Atomically claim the best ready item with a lease (agents need `queue:claim`)',
  'POST /api/v1/repos/:repo/work/import-labels':
    'Turn Factory `<prefix>:*` labels into work fields (approvers)',
  'GET /api/v1/repos/:repo/work/:number': 'One work item and its readiness history',
  'PUT /api/v1/repos/:repo/work/:number':
    'Set work fields; `ready` and risk need triage or `queue:approve`',
  'POST /api/v1/repos/:repo/work/:number/heartbeat': 'Renew the lease you hold',
  'POST /api/v1/repos/:repo/work/:number/release':
    'End your claim: `ready` (counts an attempt), `in-review`, `blocked` or `done`',
  'GET /auth/oidc/:provider': 'Start OIDC sign-in (302 to the identity provider)',
  'GET /auth/oidc/:provider/callback': 'OIDC callback: sign in or link, then 302',
  'POST /auth/passkey/options': 'Passkey sign-in challenge',
  'POST /auth/passkey': 'Sign in with a passkey (sets `yag_session`)',
  'POST /auth/mfa/passkey/options': 'Passkey step-up challenge',
  'POST /auth/mfa/passkey': 'Step up this session with a passkey',
  'POST /auth/mfa/totp': 'Step up this session with an authenticator code',
  'GET /api/v1/me/security': 'Sign-in method, MFA freshness and enrolled factors',
  'POST /api/v1/me/passkeys/options': 'Passkey registration challenge',
  'POST /api/v1/me/passkeys': 'Register a passkey',
  'DELETE /api/v1/me/passkeys/:id': 'Remove a passkey',
  'POST /api/v1/me/totp': 'Start authenticator app enrolment',
  'POST /api/v1/me/totp/confirm': 'Confirm authenticator enrolment with a code',
  'DELETE /api/v1/me/totp': 'Remove the authenticator app (recent MFA)',
  'GET /scim/v2/Users': 'SCIM: list users (`userName eq` filter)',
  'POST /scim/v2/Users': 'SCIM: provision a user',
  'GET /scim/v2/Users/:id': 'SCIM: one user',
  'PATCH /scim/v2/Users/:id': 'SCIM: activate or deactivate a user',
  'DELETE /scim/v2/Users/:id': 'SCIM: deprovision a user',
  'GET /scim/v2/Groups': 'SCIM: list groups (`displayName eq` filter)',
  'POST /scim/v2/Groups': "SCIM: create a group as a team in the token's org",
  'GET /scim/v2/Groups/:id': 'SCIM: one group and its members',
  'PATCH /scim/v2/Groups/:id': 'SCIM: change group members or name',
  'DELETE /scim/v2/Groups/:id': 'SCIM: delete a group and its team',
  'GET /api/v1/scim/tokens': 'List SCIM tokens (SCIM admins)',
  'POST /api/v1/scim/tokens': 'Create a SCIM token (raw value returned once)',
  'DELETE /api/v1/scim/tokens/:id': 'Revoke a SCIM token',
  'GET /api/v1/orgs/:org/audit': 'Search or export the org audit chain',
  'GET /api/v1/audit/stream': 'SIEM stream delivery status',
  'POST /api/v1/orgs': 'Create an org (caller becomes owner)',
  'GET /api/v1/orgs': 'Orgs the caller belongs to',
  'GET /api/v1/orgs/:org': 'One org and the caller role',
  'GET /api/v1/orgs/:org/imports': 'Recent GitHub bulk imports',
  'POST /api/v1/orgs/:org/imports':
    'Import a GitHub org (history, issues, pulls, releases, LFS); the caller must administer it on GitHub',
  'GET /api/v1/orgs/:org/imports/:id': 'Bulk import progress and per-repo report',
  'POST /api/v1/orgs/:org/imports/:id/resume':
    'Retry failed repos from their checkpoints',
  'PATCH /api/v1/orgs/:org': 'Org settings (owners)',
  'GET /api/v1/orgs/:org/sso': 'Org SSO settings and whether the caller meets them',
  'PUT /api/v1/orgs/:org/sso': 'Set org SSO (owners, recent MFA)',
  'DELETE /api/v1/orgs/:org/sso': 'Remove org SSO (owners, recent MFA)',
  'GET /api/v1/orgs/:org/members': 'List org members',
  'PUT /api/v1/orgs/:org/members': 'Add or change an org member',
  'DELETE /api/v1/orgs/:org/members/:userId': 'Remove an org member (and from its teams)',
  'GET /api/v1/orgs/:org/teams': 'List teams',
  'POST /api/v1/orgs/:org/teams': 'Create a team (optional parent)',
  'GET /api/v1/orgs/:org/teams/:team': 'Team, members and repo grants',
  'PUT /api/v1/orgs/:org/teams/:team/members': 'Add a team member',
  'DELETE /api/v1/orgs/:org/teams/:team/members/:userId': 'Remove a team member',
  'PUT /api/v1/orgs/:org/teams/:team/repos': 'Grant the team a repo role',
  'DELETE /api/v1/orgs/:org/teams/:team/repos/:repo': 'Remove a team repo grant',
  'GET /api/v1/orgs/:org/repos': 'Org repos the caller can read',
  'GET /api/v1/repos/:repo/secret-scanning/alerts':
    'Secret scanning alerts (location and detector; never the secret) and the last history scan',
  'PATCH /api/v1/repos/:repo/secret-scanning/alerts/:id':
    "Resolve (revoked, false positive, test data, won't fix) or reopen an alert",
  'POST /api/v1/repos/:repo/secret-scanning/scans':
    'Queue a history scan for secrets (also started after an import)',
  'GET /api/v1/orgs/:org/rulesets': 'List org rulesets',
  'POST /api/v1/orgs/:org/rulesets': 'Create an org ruleset',
  'PUT /api/v1/orgs/:org/rulesets/:id': 'Replace an org ruleset',
  'DELETE /api/v1/orgs/:org/rulesets/:id': 'Delete an org ruleset',
  'GET /api/v1/orgs/:org/rulesets/evaluations': 'Evaluate-mode log for org rulesets',
  'GET /:owner/:repo.git/info/refs':
    'Git smart HTTP advertisement: v2 capabilities, or refs for `git-receive-pack`',
  'POST /:owner/:repo.git/git-upload-pack':
    'Git protocol v2 `ls-refs` and `fetch` (clone, fetch)',
  'POST /:owner/:repo.git/git-receive-pack':
    'Git push: pack, pre-receive checks, ref CAS',
  'GET /api/github/v3': 'GitHub REST compatible root (docs/compat/github.md)',
  'GET /api/github/v3/user': 'GitHub compatible: the signed-in user',
  'GET /api/github/v3/user/repos': 'GitHub compatible: repositories the caller can read',
  'GET /api/github/v3/repos/:owner/:repo': 'GitHub compatible: get a repository',
  'GET /api/github/v3/repos/:owner/:repo/contents':
    'GitHub compatible: list the root directory',
  'GET /api/github/v3/repos/:owner/:repo/contents/:path':
    'GitHub compatible: a file (base64) or a directory listing',
  'GET /api/github/v3/repos/:owner/:repo/git/ref/:ref':
    'GitHub compatible: get a branch or tag ref',
  'POST /api/github/v3/repos/:owner/:repo/git/refs':
    'GitHub compatible: create a branch or tag',
  'GET /api/github/v3/repos/:owner/:repo/commits/:ref': 'GitHub compatible: get a commit',
  'GET /api/github/v3/repos/:owner/:repo/commits/:ref/check-runs':
    'GitHub compatible: CI jobs for a commit as check runs',
  'GET /api/github/v3/repos/:owner/:repo/commits/:ref/statuses':
    'GitHub compatible: CI jobs for a commit as statuses',
  'GET /api/github/v3/repos/:owner/:repo/commits/:ref/status':
    'GitHub compatible: combined status for a commit',
  'GET /api/github/v3/repos/:owner/:repo/issues': 'GitHub compatible: list issues',
  'POST /api/github/v3/repos/:owner/:repo/issues': 'GitHub compatible: open an issue',
  'GET /api/github/v3/repos/:owner/:repo/issues/:number':
    'GitHub compatible: get an issue',
  'PATCH /api/github/v3/repos/:owner/:repo/issues/:number':
    'GitHub compatible: edit, close or reopen an issue',
  'GET /api/github/v3/repos/:owner/:repo/issues/:number/comments':
    'GitHub compatible: list issue comments',
  'POST /api/github/v3/repos/:owner/:repo/issues/:number/comments':
    'GitHub compatible: comment on an issue',
  'POST /api/github/v3/repos/:owner/:repo/issues/:number/labels':
    'GitHub compatible: add labels to an issue',
  'PUT /api/github/v3/repos/:owner/:repo/issues/:number/labels':
    'GitHub compatible: replace the labels on an issue',
  'GET /api/github/v3/repos/:owner/:repo/labels': 'GitHub compatible: list labels',
  'POST /api/github/v3/repos/:owner/:repo/labels': 'GitHub compatible: create a label',
  'GET /api/github/v3/repos/:owner/:repo/pulls': 'GitHub compatible: list pull requests',
  'POST /api/github/v3/repos/:owner/:repo/pulls':
    'GitHub compatible: open a pull request from a branch',
  'GET /api/github/v3/repos/:owner/:repo/pulls/:number':
    'GitHub compatible: get a pull request',
  'PATCH /api/github/v3/repos/:owner/:repo/pulls/:number':
    'GitHub compatible: edit or close a pull request',
  'GET /api/github/v3/repos/:owner/:repo/pulls/:number/merge':
    'GitHub compatible: 204 when merged, else 404',
  'PUT /api/github/v3/repos/:owner/:repo/pulls/:number/merge':
    'GitHub compatible: merge a pull request',
  'GET /api/github/v3/repos/:owner/:repo/pulls/:number/reviews':
    'GitHub compatible: list reviews',
  'POST /api/github/v3/repos/:owner/:repo/pulls/:number/reviews':
    'GitHub compatible: submit a review',
  'GET /api/github/v3/repos/:owner/:repo/releases': 'GitHub compatible: list releases',
  'POST /api/github/v3/repos/:owner/:repo/releases':
    'GitHub compatible: create a release (and its tag)',
  'GET /api/github/v3/repos/:owner/:repo/releases/latest':
    'GitHub compatible: the latest release',
  'GET /api/github/v3/repos/:owner/:repo/releases/tags/:tag':
    'GitHub compatible: a release by tag',
  'GET /api/github/v3/repos/:owner/:repo/releases/:id':
    'GitHub compatible: get a release',
  'PATCH /api/github/v3/repos/:owner/:repo/releases/:id':
    'GitHub compatible: edit or publish a release',
  'DELETE /api/github/v3/repos/:owner/:repo/releases/:id':
    'GitHub compatible: delete a release',
  'GET /api/github/v3/search/issues':
    'GitHub compatible: search issues or pull requests in one repo',
};

const METHOD_ORDER = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

/** A concrete display path for `bucketFor()` (which only looks at path shape). */
function samplePath(path: string): string {
  return path.replace(/:repo\b/g, 'owner/name').replace(/:\w+/g, 'x');
}

/**
 * Derive access requirements from the handler source. Returns `null` for the
 * permission when a repo-scoped route calls no recognised guard.
 */
function classify(path: string, src: string): { auth: string; perm: string | null } {
  if (path.startsWith('/webhooks/')) return { auth: 'HMAC', perm: '—' };
  if (path.startsWith('/scim/')) return { auth: 'SCIM token', perm: '—' };
  if (path === '/ci/oidc/token') return { auth: 'CI request token', perm: 'running job' };
  if (path === '/runner/v1/register') return { auth: 'registration token', perm: '—' };
  if (path.startsWith('/runner/')) return { auth: 'runner credential', perm: 'own jobs' };
  if (path === '/mcp') {
    return { auth: 'token', perm: 'per tool: the API route it calls' };
  }
  if (path === '/oauth/authorize') return { auth: 'session', perm: '—' };
  // GitHub REST compatibility (#74): calls native /api/v1 routes as the caller
  if (path.startsWith('/api/github/v3')) {
    return { auth: 'any', perm: 'as the native route it calls' };
  }
  // registry (#53): a forge token, or on /v2/ the registry token /v2/token issues
  if (path.startsWith('/v2/') || path.startsWith('/npm/')) {
    const auth = 'token (Basic or Bearer)';
    if (path === '/v2/token') return { auth, perm: '—' };
    if (path === '/v2/' || path === '/npm/-/whoami') return { auth, perm: '—' };
    if (/"delete"\)/.test(src))
      return { auth, perm: 'admin on the linked repo (whole repo)' };
    if (/"push"|loadUpload|changeTag/.test(src))
      return { auth, perm: 'write on the linked repo (whole repo); CI job: own repo' };
    return { auth, perm: 'read on the linked repo (whole repo)' };
  }
  if (path.includes('.git/')) {
    return {
      auth: 'token (Basic or Bearer)',
      perm: path.endsWith('/git-receive-pack')
        ? 'write; read (whole repo)'
        : path.endsWith('/info/refs')
          ? 'read (whole repo); write for `git-receive-pack`'
          : 'read (whole repo)',
    };
  }
  if (!path.startsWith('/api/')) return { auth: 'none', perm: '—' };

  let auth = 'any';
  if (
    (/c\.get\("user"\)/.test(src) && /session required/.test(src)) ||
    /requireSession\d*\(/.test(src) ||
    /(sessionUserId|sessionUser|loadOrg|loadOwnedOrg|loadHook|loadManagedApp)\d*\(/.test(
      src,
    )
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
  else if (/loadTriageRepo\d*\(/.test(src)) parts.push('triage');
  else if (/loadWritableRepo(ById)?\d*\(/.test(src)) parts.push('write');
  else if (/loadReadableRepo(ById)?\d*\(/.test(src)) parts.push('read');
  else if (/\bcan\d*\([^;]*?"write"\)/.test(src)) parts.push('write');
  else if (/\bcan\d*\([^;]*?toolPerm\d*\(/.test(src)) {
    parts.push('read; write for `commit`/`land`/`create_task`');
  } else if (/\bcan\d*\([^;]*?"admin"\)/.test(src)) parts.push('admin on any repo');

  const org = /loadOrg\d*\(\s*c,\s*"(member|manage|owner)"\)/.exec(src);
  if (org) {
    parts.push(
      { member: 'org member', manage: 'org owner or admin', owner: 'org owner' }[
        org[1] as 'member' | 'manage' | 'owner'
      ],
    );
  }
  if (/loadOwnedOrg\d*\(/.test(src)) parts.push('org owner');
  if (/loadImportOrg\d*\(/.test(src)) {
    parts.push('org owner or admin; token needs `repo:write`, no agents');
  }
  if (/loadHook\d*\(/.test(src)) parts.push("manages the hook's repo, org or app");
  if (/loadManagedApp\d*\(/.test(src)) parts.push('app owner');
  if (/guardPathRead\d*\(/.test(src)) parts.push('path:read');
  if (/guardPathHistory\d*\(/.test(src)) parts.push('path:history');
  if (/"agent:run"/.test(src)) parts.push('`agent:run`');
  if (/agentIdOf\d*\(/.test(src)) parts.push('agent identity for `refs/agents/<id>/`');
  if (
    /!hasScope\d*\(principal, "repo:read"\) && !hasScope\d*\(principal, "repo:write"\)/.test(
      src,
    )
  ) {
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
        "export { API_CONTRACT, apiErrorSchema, displayPath, openApiPath, jsonSchema } from './src/api/contract';",
      ].join('\n'),
      resolveDir: workerDir,
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    // Bundled CommonJS packages (e.g. `yaml`'s Node build) require Node built-ins.
    banner: {
      js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(import.meta.url)});`,
    },
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
    const path = mod.displayPath(route.path);
    const key = `${route.method} ${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const src = route.handler.toString();
    const { auth, perm } = classify(path, src);
    if (perm === null) warnings.push(`no RBAC guard recognised: ${key}`);
    const purpose = PURPOSES[key];
    if (purpose === undefined) warnings.push(`no purpose text: ${key}`);
    const contract = mod.API_CONTRACT[key];
    if (contract === undefined) warnings.push(`no contract entry: ${key}`);
    else {
      for (const [, name] of src.matchAll(/\.req\.query\("([^"]+)"\)/g)) {
        if (!contract.query?.shape[name as string]) {
          warnings.push(`query parameter not in contract: ${key} ?${name}`);
        }
      }
      const readsBody =
        /readJsonBody\(|\.req\.(json|arrayBuffer|text)\(|\.req\.raw\.body/;
      if (readsBody.test(src) && !contract.body && !contract.rawBody) {
        warnings.push(`request body not in contract: ${key}`);
      }
    }
    rows.push({
      method: route.method,
      path,
      auth,
      perm: perm ?? '**unclassified**',
      bucket: mod.bucketFor(route.method, samplePath(path)) ?? 'exempt',
      purpose: purpose ?? '**undocumented**',
      rawPath: route.path,
      json: /\bc\.json\(/.test(src),
      redirect: /\bc\.redirect\(/.test(src),
      envelope: path.startsWith('/api/') || /\b(apiError|errorResponse)\(/.test(src),
    });
  }
  for (const key of Object.keys(PURPOSES)) {
    if (!seen.has(key))
      warnings.push(`purpose for a route that no longer exists: ${key}`);
  }
  const ids = new Set<string>();
  for (const [key, { id }] of Object.entries(mod.API_CONTRACT)) {
    if (!seen.has(key))
      warnings.push(`contract for a route that no longer exists: ${key}`);
    if (ids.has(id)) warnings.push(`duplicate operation id: ${id}`);
    ids.add(id);
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

/** `classify()` auth label → OpenAPI security requirement. */
const SECURITY: Record<string, Record<string, string[]>[]> = {
  any: [{ session: [] }, { bearer: [] }],
  session: [{ session: [] }],
  token: [{ bearer: [] }],
  none: [],
  HMAC: [{ githubSignature: [] }],
  'SCIM token': [{ scimBearer: [] }],
  'CI request token': [{ ciJobBearer: [] }],
  'registration token': [],
  'runner credential': [{ runnerBearer: [] }],
  'token (Basic or Bearer)': [{ gitBasic: [] }, { bearer: [] }],
};

function operation(mod: WorkerModule, row: Row, path: string): JsonObject {
  const contract = mod.API_CONTRACT[`${row.method} ${row.path}`];
  const parameters: JsonObject[] = [...path.matchAll(/\{(\w+)\}/g)].map(([, name]) => ({
    name,
    in: 'path',
    required: true,
    schema: { type: 'string' },
  }));
  for (const [name, field] of Object.entries(contract?.query?.shape ?? {})) {
    parameters.push({
      name,
      in: 'query',
      required: !field.safeParse(undefined).success,
      schema: mod.jsonSchema(field),
    });
  }

  const responses: JsonObject = {};
  if (row.json || !row.redirect) {
    responses['2XX'] = row.json
      ? { description: 'Success', content: { 'application/json': { schema: {} } } }
      : { description: 'Success' };
  }
  if (row.redirect) responses['302'] = { description: 'Redirect' };
  if (row.envelope) {
    responses['4XX'] = { $ref: '#/components/responses/Error' };
    responses['5XX'] = { $ref: '#/components/responses/Error' };
  }

  const security = SECURITY[row.auth];
  if (security === undefined) throw new Error(`no security scheme for auth ${row.auth}`);
  let requestBody: JsonObject | undefined;
  if (contract?.body) {
    requestBody = {
      required: true,
      content: { 'application/json': { schema: mod.jsonSchema(contract.body) } },
    };
  } else if (contract?.rawBody) {
    requestBody = { required: true, content: { [contract.rawBody]: { schema: {} } } };
  }
  return {
    operationId: contract?.id ?? `${row.method} ${row.path}`,
    summary: row.purpose,
    security,
    'x-yag-permission': row.perm,
    'x-yag-rate-bucket': row.bucket,
    ...(contract?.deprecated ? { deprecated: true } : {}),
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(requestBody ? { requestBody } : {}),
    responses,
  };
}

function openapi(mod: WorkerModule, rows: Row[]): JsonObject {
  const paths: Record<string, JsonObject> = {};
  for (const row of rows) {
    const path = mod.openApiPath(row.rawPath);
    paths[path] = {
      ...paths[path],
      [row.method.toLowerCase()]: operation(mod, row, path),
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'yuma-agent-git API',
      version: '1',
      description:
        'Generated by `npm run docs:openapi` from the Hono router and `worker/src/api/contract.ts`. Do not edit by hand. Versioning and deprecation: docs/api-versioning.md. Access rules and rate limits: docs/api.md.',
    },
    servers: [{ url: '/', description: 'The deployment serving this document' }],
    paths,
    components: {
      securitySchemes: {
        session: {
          type: 'apiKey',
          in: 'cookie',
          name: 'yag_session',
          description: 'Browser session from sign-in',
        },
        bearer: {
          type: 'http',
          scheme: 'bearer',
          description: 'API token (`yag_…`) created in the dashboard Settings',
        },
        gitBasic: {
          type: 'http',
          scheme: 'basic',
          description: 'Git clients: any username, an API token as the password',
        },
        scimBearer: {
          type: 'http',
          scheme: 'bearer',
          description: 'SCIM token from `POST /api/v1/scim/tokens`',
        },
        ciJobBearer: {
          type: 'http',
          scheme: 'bearer',
          description:
            'Per-run CI request token (`yagjob_…`) from `YAG_ID_TOKEN_REQUEST_TOKEN` in the job',
        },
        runnerBearer: {
          type: 'http',
          scheme: 'bearer',
          description:
            'Self-hosted runner credential (`yagrun_…`) from `POST /runner/v1/register`',
        },
        githubSignature: {
          type: 'apiKey',
          in: 'header',
          name: 'X-Hub-Signature-256',
          description: 'HMAC SHA-256 of the body with the GitHub App webhook secret',
        },
      },
      schemas: { Error: mod.jsonSchema(mod.apiErrorSchema) },
      responses: {
        Error: {
          description: 'Error envelope with a stable `code`',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/Error' } },
          },
        },
      },
    },
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

  const spec = await prettier.format(JSON.stringify(openapi(mod, rows)), {
    ...(await prettier.resolveConfig(openapiPath)),
    parser: 'json',
  });
  let previous = '';
  try {
    previous = await readFile(openapiPath, 'utf8');
  } catch {
    // first run
  }
  if (spec !== previous) await writeFile(openapiPath, spec, 'utf8');
  console.log(`docs/openapi.json: ${spec === previous ? 'unchanged' : 'updated'}`);

  for (const warning of warnings) console.warn(`warning: ${warning}`);
  if (warnings.length > 0) process.exitCode = 1;
}

await main();
