import { z } from 'zod';
import { commitRequestSchema } from '../core/commit';
import { policySchema } from '../ci/config';
import { pathRuleInputSchema } from '../auth/rbac';
import { createTokenSchema } from '../auth/tokens';
import { createScimTokenSchema, createUserSchema, patchSchema } from '../auth/scim';
import { assertionSchema, registrationSchema } from '../auth/webauthn';
import { codeSchema } from '../auth/totp';
import { connectSchema } from '../bridge/github';
import { exportRequestSchema } from '../bridge/exportPush';
import { importRequestSchema } from '../bridge/import';
import { mintSchema } from '../middleware/cachetier';
import { rpcSchema } from '../agents/mcp';
import { memberSchema } from './admin';
import { createTaskSchema, superfanSchema } from './agents';
import { querySchema as auditQuerySchema } from './audit';
import { createPull, createRunSchema } from './collaboration';
import { fetchObjectsSchema } from './objects';
import {
  createOrgSchema,
  createTeamSchema,
  grantSchema,
  patchOrgSchema,
  putMemberSchema,
  userRefSchema,
} from './orgs';
import { createTagSchema, moveRefSchema } from './refs';
import { createRepoSchema, updateRepoSchema } from './repos';

/**
 * The public API contract (issue #28): one entry per HTTP route, keyed like
 * docs/api.md (`METHOD display-path`). `scripts/gen-api-docs.ts` walks the
 * real router and turns these into docs/openapi.json; the MCP server (#56) can
 * reuse the same `id`s and zod schemas as tool names and input schemas.
 *
 * Request bodies are the zod schemas the handlers actually parse with. Query
 * parameters are read ad hoc by handlers, so they are declared here; the
 * generator warns when a handler reads a query key this file does not declare.
 */
export interface RouteContract {
  /** Stable OpenAPI `operationId` and SDK operation name. Never rename within v1. */
  id: string;
  query?: z.ZodObject;
  body?: z.ZodType;
  /** Non-JSON request body media type (streams, git packs, raw bytes). */
  rawBody?: string;
}

/** The `{ error: { code, message } }` envelope every `/api` error uses. */
export const apiErrorSchema = z.object({
  error: z.looseObject({
    code: z.string(),
    message: z.string(),
  }),
});

const flag = z.literal('1');
const rev = z.string().describe('Revision: changeset id, `ref:<name>` or a ref name');
const page = { cursor: z.string().optional(), limit: z.int().min(1).optional() };

// Pull request actions are validated by hand in reviews/pulls.ts (inside the
// ref-lock Durable Object); these describe what that code accepts.
const updatePullSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  body: z.string().max(20000).optional(),
  state: z.enum(['draft', 'open', 'closed']).optional(),
  head_cs: z.string().optional(),
});
const reviewPullSchema = z.object({
  head_cs: z.string(),
  revision: z.int(),
  decision: z.enum(['comment', 'approve', 'request_changes']),
  body: z.string().max(20000),
});
const mergePullSchema = z.object({ head_cs: z.string(), revision: z.int() });

const ancestryQuery = z.object({ a: rev, b: rev });

export const API_CONTRACT: Record<string, RouteContract> = {
  'GET /healthz': { id: 'getHealth' },
  'GET /auth/status': { id: 'getAuthStatus' },
  'GET /auth/github': { id: 'startGithubLogin' },
  'GET /auth/github/callback': {
    id: 'finishGithubLogin',
    query: z.object({ code: z.string(), state: z.string() }),
  },
  'GET /auth/github/install-callback': {
    id: 'finishGithubInstall',
    query: z.object({ state: z.string().optional() }),
  },
  'POST /auth/logout': { id: 'logout' },
  'GET /auth/oidc/:provider': {
    id: 'startOidcLogin',
    query: z.object({ link: flag.optional() }),
  },
  'GET /auth/oidc/:provider/callback': {
    id: 'finishOidcLogin',
    query: z.object({
      code: z.string().optional(),
      state: z.string().optional(),
      error: z.string().optional(),
    }),
  },
  'POST /auth/passkey/options': { id: 'passkeyLoginOptions' },
  'POST /auth/passkey': { id: 'passkeyLogin', body: assertionSchema },
  'POST /auth/mfa/passkey/options': { id: 'passkeyStepUpOptions' },
  'POST /auth/mfa/passkey': { id: 'passkeyStepUp', body: assertionSchema },
  'POST /auth/mfa/totp': { id: 'totpStepUp', body: codeSchema },
  'POST /webhooks/github': { id: 'receiveGithubWebhook', rawBody: 'application/json' },
  'GET /scim/v2/Users': {
    id: 'scimListUsers',
    query: z.object({
      filter: z.string().optional().describe('Only `userName eq "<login>"`'),
      startIndex: z.int().min(1).optional(),
      count: z.int().min(0).max(200).optional(),
    }),
  },
  'POST /scim/v2/Users': { id: 'scimCreateUser', body: createUserSchema },
  'GET /scim/v2/Users/:id': { id: 'scimGetUser' },
  'PATCH /scim/v2/Users/:id': { id: 'scimPatchUser', body: patchSchema },
  'DELETE /scim/v2/Users/:id': { id: 'scimDeleteUser' },
  'GET /:owner/:repo.git/info/refs': {
    id: 'gitInfoRefs',
    query: z.object({ service: z.enum(['git-upload-pack', 'git-receive-pack']) }),
  },
  'POST /:owner/:repo.git/git-upload-pack': {
    id: 'gitUploadPack',
    rawBody: 'application/x-git-upload-pack-request',
  },
  'POST /:owner/:repo.git/git-receive-pack': {
    id: 'gitReceivePack',
    rawBody: 'application/x-git-receive-pack-request',
  },

  'GET /api/v1': { id: 'getApiRoot' },
  'GET /api/v1/openapi.json': { id: 'getOpenApi' },
  'GET /api/v1/admin/metrics': {
    id: 'getMetrics',
    query: z.object({
      component: z.string().optional(),
      window: z.int().min(1).optional().describe('Window in ms (default 1 hour)'),
    }),
  },
  'GET /api/v1/audit/stream': { id: 'getAuditStream' },
  'POST /api/v1/cache-token': { id: 'createCacheToken', body: mintSchema },
  'GET /api/v1/github/install-url': { id: 'getGithubInstallUrl' },
  'GET /api/v1/me/security': { id: 'getMySecurity' },
  'POST /api/v1/me/passkeys/options': { id: 'passkeyRegisterOptions' },
  'POST /api/v1/me/passkeys': { id: 'registerPasskey', body: registrationSchema },
  'DELETE /api/v1/me/passkeys/:id': { id: 'deletePasskey' },
  'POST /api/v1/me/totp': { id: 'startTotpEnrolment' },
  'POST /api/v1/me/totp/confirm': { id: 'confirmTotp', body: codeSchema },
  'DELETE /api/v1/me/totp': { id: 'deleteTotp' },
  'GET /api/v1/scim/tokens': { id: 'listScimTokens' },
  'POST /api/v1/scim/tokens': { id: 'createScimToken', body: createScimTokenSchema },
  'DELETE /api/v1/scim/tokens/:id': { id: 'deleteScimToken' },
  'GET /api/v1/tokens': { id: 'listTokens' },
  'POST /api/v1/tokens': { id: 'createToken', body: createTokenSchema },
  'DELETE /api/v1/tokens/:id': { id: 'deleteToken' },

  'GET /api/v1/agents/tasks/:id': { id: 'getAgentTask' },
  'POST /api/v1/agents/tasks/:id/cancel': { id: 'cancelAgentTask' },
  'GET /api/v1/agents/tasks/:id/transcript': {
    id: 'getAgentTranscript',
    query: z.object({ since: z.int().min(0).optional().describe('Epoch ms') }),
  },

  'GET /api/v1/orgs': { id: 'listOrgs' },
  'POST /api/v1/orgs': { id: 'createOrg', body: createOrgSchema },
  'GET /api/v1/orgs/:org': { id: 'getOrg' },
  'PATCH /api/v1/orgs/:org': { id: 'updateOrg', body: patchOrgSchema },
  'GET /api/v1/orgs/:org/audit': { id: 'searchOrgAudit', query: auditQuerySchema },
  'GET /api/v1/orgs/:org/members': { id: 'listOrgMembers' },
  'PUT /api/v1/orgs/:org/members': { id: 'putOrgMember', body: putMemberSchema },
  'DELETE /api/v1/orgs/:org/members/:userId': { id: 'deleteOrgMember' },
  'GET /api/v1/orgs/:org/repos': { id: 'listOrgRepos' },
  'GET /api/v1/orgs/:org/teams': { id: 'listTeams' },
  'POST /api/v1/orgs/:org/teams': { id: 'createTeam', body: createTeamSchema },
  'GET /api/v1/orgs/:org/teams/:team': { id: 'getTeam' },
  'PUT /api/v1/orgs/:org/teams/:team/members': {
    id: 'putTeamMember',
    body: userRefSchema,
  },
  'DELETE /api/v1/orgs/:org/teams/:team/members/:userId': { id: 'deleteTeamMember' },
  'PUT /api/v1/orgs/:org/teams/:team/repos': { id: 'putTeamRepo', body: grantSchema },
  'DELETE /api/v1/orgs/:org/teams/:team/repos/:repo': { id: 'deleteTeamRepo' },

  'GET /api/v1/repos': { id: 'listRepos', query: z.object(page) },
  'POST /api/v1/repos': { id: 'createRepo', body: createRepoSchema },
  'GET /api/v1/repos/:owner/:name': { id: 'getRepo' },
  'PUT /api/v1/repos/:owner/:name': { id: 'updateRepo', body: updateRepoSchema },
  'POST /api/v1/repos/:owner/:name/initialize': { id: 'initializeRepo' },

  'GET /api/v1/repos/:repo/agents/superfans': {
    id: 'listSuperfans',
    query: z.object({ limit: z.int().min(1).optional() }),
  },
  'POST /api/v1/repos/:repo/agents/superfans': {
    id: 'startSuperfan',
    body: superfanSchema,
  },
  'DELETE /api/v1/repos/:repo/agents/superfans/:component': { id: 'stopSuperfan' },
  'POST /api/v1/repos/:repo/agents/mcp': { id: 'callMcp', body: rpcSchema },
  'GET /api/v1/repos/:repo/agents/tasks': {
    id: 'listAgentTasks',
    query: z.object({
      status: z.string().optional(),
      limit: z.int().min(1).optional(),
    }),
  },
  'POST /api/v1/repos/:repo/agents/tasks': {
    id: 'createAgentTask',
    body: createTaskSchema,
  },
  'GET /api/v1/repos/:repo/ancestor-distance': {
    id: 'getAncestorDistance',
    query: ancestryQuery,
  },
  'GET /api/v1/repos/:repo/is-ancestor': { id: 'isAncestor', query: ancestryQuery },
  'GET /api/v1/repos/:repo/merge-base': { id: 'getMergeBase', query: ancestryQuery },
  'GET /api/v1/repos/:repo/blame': {
    id: 'getBlame',
    query: z.object({
      cs: rev.optional(),
      path: z.string(),
      background: flag.optional(),
      annotate: flag.optional(),
    }),
  },
  'PUT /api/v1/repos/:repo/blob': {
    id: 'uploadBlob',
    rawBody: 'application/octet-stream',
    query: z.object({
      sha256: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .optional()
        .describe('Or the `x-yag-sha256` header'),
      encoding: z.enum(['identity', 'zstd']).optional(),
    }),
  },
  'GET /api/v1/repos/:repo/changed-paths': {
    id: 'getChangedPaths',
    query: z.object({ cs: rev }),
  },
  'GET /api/v1/repos/:repo/changesets': {
    id: 'listChangesets',
    query: z.object({ head: rev.optional(), ...page }),
  },
  'POST /api/v1/repos/:repo/changesets': {
    id: 'createChangeset',
    body: commitRequestSchema,
  },
  'GET /api/v1/repos/:repo/changesets/:id': { id: 'getChangeset' },
  'GET /api/v1/repos/:repo/checkout-info': {
    id: 'getCheckoutInfo',
    query: z.object({ cs: rev }),
  },
  'GET /api/v1/repos/:repo/ci': { id: 'getCi' },
  'PUT /api/v1/repos/:repo/ci': { id: 'putCiPolicy', body: policySchema },
  'GET /api/v1/repos/:repo/ci/detect': { id: 'detectCi' },
  'POST /api/v1/repos/:repo/ci/runs': { id: 'createCiRun', body: createRunSchema },
  'POST /api/v1/repos/:repo/ci/runs/:id/cancel': { id: 'cancelCiRun' },
  'GET /api/v1/repos/:repo/ci/runs/:id/log': { id: 'getCiRunLog' },
  'POST /api/v1/repos/:repo/connect': { id: 'connectGithub', body: connectSchema },
  'GET /api/v1/repos/:repo/diff': {
    id: 'getDiff',
    query: z.object({
      from: rev,
      to: rev,
      mode: z.enum(['merge-base', 'direct']).optional(),
      text: flag.optional(),
      max_files: z.int().min(1).optional(),
    }),
  },
  'GET /api/v1/repos/:repo/export/fast-import': {
    id: 'exportFastImport',
    query: z.object({
      head: rev,
      mode: z.enum(['snapshot', 'full', 'ranged']).optional(),
      from: rev.optional(),
    }),
  },
  'POST /api/v1/repos/:repo/export/github': {
    id: 'exportToGithub',
    body: exportRequestSchema,
  },
  'GET /api/v1/repos/:repo/export/tarball': {
    id: 'exportTarball',
    query: z.object({ cs: rev.optional() }),
  },
  'POST /api/v1/repos/:repo/fetch-objects': {
    id: 'fetchObjects',
    body: fetchObjectsSchema,
  },
  'GET /api/v1/repos/:repo/file': {
    id: 'getFile',
    query: z.object({
      cs: rev.optional(),
      path: z.string(),
      format: z.enum(['json', 'raw']).optional(),
    }),
  },
  'GET /api/v1/repos/:repo/history': {
    id: 'getHistory',
    query: z.object({
      cs: rev.optional(),
      path: z.string().optional(),
      limit: z.int().min(1).optional(),
      background: flag.optional(),
    }),
  },
  'POST /api/v1/repos/:repo/import': { id: 'startImport', body: importRequestSchema },
  'GET /api/v1/repos/:repo/import/:job_id': { id: 'getImport' },
  'GET /api/v1/repos/:repo/members': { id: 'listRepoMembers' },
  'PUT /api/v1/repos/:repo/members': { id: 'putRepoMember', body: memberSchema },
  'DELETE /api/v1/repos/:repo/members/:userId': { id: 'deleteRepoMember' },
  'GET /api/v1/repos/:repo/object/blob/:hash': {
    id: 'getBlobObject',
    query: z.object({ encoding: z.enum(['zstd', 'identity']).optional() }),
  },
  'GET /api/v1/repos/:repo/object/tree/:hash': { id: 'getTreeObject' },
  'GET /api/v1/repos/:repo/path-rules': { id: 'listPathRules' },
  'POST /api/v1/repos/:repo/path-rules': {
    id: 'createPathRule',
    body: pathRuleInputSchema,
  },
  'DELETE /api/v1/repos/:repo/path-rules/:id': { id: 'deletePathRule' },
  'GET /api/v1/repos/:repo/pulls': {
    id: 'listPulls',
    query: z.object({ before: z.int().min(1).optional() }),
  },
  'POST /api/v1/repos/:repo/pulls': { id: 'createPull', body: createPull },
  'GET /api/v1/repos/:repo/pulls/:id': { id: 'getPull' },
  'POST /api/v1/repos/:repo/pulls/:id/merge': { id: 'mergePull', body: mergePullSchema },
  'POST /api/v1/repos/:repo/pulls/:id/review': {
    id: 'reviewPull',
    body: reviewPullSchema,
  },
  'POST /api/v1/repos/:repo/pulls/:id/update': {
    id: 'updatePull',
    body: updatePullSchema,
  },
  'GET /api/v1/repos/:repo/refs': {
    id: 'listRefs',
    query: z.object({ prefix: z.string().optional(), ...page }),
  },
  'GET /api/v1/repos/:repo/refs/:name': { id: 'getRef' },
  'PUT /api/v1/repos/:repo/refs/:name': { id: 'moveRef', body: moveRefSchema },
  'GET /api/v1/repos/:repo/tags': { id: 'listTags', query: z.object(page) },
  'POST /api/v1/repos/:repo/tags': { id: 'createTag', body: createTagSchema },
  'GET /api/v1/repos/:repo/tree': {
    id: 'getTree',
    query: z.object({
      cs: rev.optional(),
      path: z.string().optional(),
      recursive: flag.optional(),
    }),
  },
};

/** `:repo{.+}` → `:repo`: the regex is a router detail, not part of the contract. */
export function displayPath(path: string): string {
  return path.replace(/:repo\{[^}]*\.git\}/, ':repo.git').replace(/\{[^}]*\}/g, '');
}

/**
 * Hono path → OpenAPI path template. A repo is always `{owner}/{repo}` (two
 * segments), so `:repo{.+}` and `/repos/:owner/:name` both expand to that.
 */
export function openApiPath(path: string): string {
  return path
    .replace(/:repo\{[^}]*\.git\}/, '{repo}.git')
    .replace(/\/repos\/:owner\/:name\b/, '/repos/{owner}/{repo}')
    .replace(/:repo\{[^}]*\}/, '{owner}/{repo}')
    .replace(/:(\w+)(\{[^}]*\})?/g, '{$1}');
}

/** JSON Schema (2020-12, the OpenAPI 3.1 dialect) for what a client may send. */
export function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _, ...rest } = z.toJSONSchema(schema, {
    io: 'input',
    unrepresentable: 'any',
  });
  return rest;
}
