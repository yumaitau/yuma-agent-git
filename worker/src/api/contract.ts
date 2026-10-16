import { z } from 'zod';
import { commitRequestSchema } from '../core/commit';
import { policySchema } from '../ci/config';
import { pathRuleInputSchema } from '../auth/rbac';
import { createTokenSchema } from '../auth/tokens';
import {
  createGroupSchema,
  createScimTokenSchema,
  createUserSchema,
  patchSchema,
} from '../auth/scim';
import { createAgentSchema, exchangeSchema, patchAgentSchema } from '../auth/agents';
import { appTokenGrantSchema, createAppSchema, installAppSchema } from '../auth/apps';
import {
  approveSchema,
  authorizeSchema,
  codeGrantSchema,
  createOAuthAppSchema,
} from '../auth/oauth-apps';
import { rulesetInputSchema } from '../policy/rulesets';
import { policySchema as agentPolicySchema } from '../policy/engine';
import { mergePullSchema, updateBranchSchema } from '../reviews/pulls';
import { reviewCommentsInput } from '../reviews/threads';
import { assertionSchema, registrationSchema } from '../auth/webauthn';
import { codeSchema } from '../auth/totp';
import { connectSchema } from '../bridge/github';
import { exportRequestSchema } from '../bridge/exportPush';
import { importRequestSchema } from '../bridge/import';
import { mintSchema } from '../middleware/cachetier';
import { rpcSchema } from '../agents/mcp';
import {
  authorizeQuery,
  codeGrantSchema as mcpCodeGrantSchema,
  refreshGrantSchema,
  registerClientSchema,
} from '../mcp/oauth';
import { mcpMessageSchema } from '../mcp/protocol';
import { memberSchema } from './admin';
import { createTaskSchema, superfanSchema } from './agents';
import { querySchema as auditQuerySchema } from './audit';
import { createPull, createRunSchema } from './collaboration';
import {
  assigneesInput,
  commentInput,
  createIssue,
  createLabel,
  flagInput,
  labelsInput,
  listQuery as issueListQuery,
  milestoneInput,
  subIssueInput,
  subIssueOrderInput,
  updateIssue,
  updateMilestone,
} from './issues';
import { fetchObjectsSchema } from './objects';
import {
  approvalsQuery,
  decisionSchema,
  pauseSchema,
  policyTestSchema,
} from './guardrails';
import { hookInputSchema, hookPatchSchema } from './hooks';
import { putSsoSchema } from './org-sso';
import {
  createOrgSchema,
  createTeamSchema,
  grantSchema,
  patchOrgSchema,
  putMemberSchema,
  userRefSchema,
} from './orgs';
import { manual as manualPipelineRun } from './pipelines';
import { decisionBody, environmentBody, secretBody, variableBody } from './secrets';
import { lifetimeSchema } from '../ci/oidc';
import { createTagSchema, moveRefSchema } from './refs';
import {
  applySuggestionsInput,
  createThreadInput,
  replyInput,
  resolutionInput,
  reviewersInput,
} from './reviews';
import {
  claimWork,
  heartbeatWork,
  importLabels,
  releaseWork,
  updateWork,
  workListQuery,
} from './work';
import { createRepoSchema, updateRepoSchema } from './repos';
import { patchRunnerBody, registrationTokenBody } from './runners';
import { completeSchema, registerSchema, stepSchema } from '../ci/runners';

/**
 * The public API contract (issue #28): one entry per HTTP route, keyed like
 * docs/api.md (`METHOD display-path`). `scripts/gen-api-docs.ts` walks the
 * real router and turns these into docs/openapi.json; the MCP server (#56)
 * builds its tools' input schemas from the same zod schemas (mcp/tools).
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
  /** Marked `deprecated` in OpenAPI (docs/api-versioning.md). */
  deprecated?: boolean;
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
  /** Inline comments submitted with the review; each starts a thread (#39). */
  comments: reviewCommentsInput.optional(),
});

const ancestryQuery = z.object({ a: rev, b: rev });
const scimListQuery = {
  filter: z.string().optional(),
  startIndex: z.int().min(1).optional(),
  count: z.int().min(0).max(200).optional(),
};
const environmentQuery = z.object({
  environment: z
    .string()
    .optional()
    .describe('Environment name; omit for the repo scope'),
});
const idTokenQuery = z.object({
  audience: z.string().optional().describe('Default `sts.amazonaws.com`'),
  lifetime: lifetimeSchema.optional().describe('Seconds, 60 to 3600'),
  run_id: z.string().optional(),
});
const evaluationsQuery = z.object({
  before: z.int().min(1).optional().describe('Evaluation id cursor (`next_cursor`)'),
});

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
  'GET /ci/oidc/.well-known/openid-configuration': { id: 'getCiOidcConfiguration' },
  'GET /ci/oidc/jwks': { id: 'getCiOidcJwks' },
  'GET /ci/oidc/token': { id: 'getCiIdToken', query: idTokenQuery },
  'POST /ci/oidc/token': { id: 'createCiIdToken', query: idTokenQuery },
  'POST /runner/v1/register': { id: 'registerRunner', body: registerSchema },
  'POST /runner/v1/jobs/claim': {
    id: 'claimRunnerJob',
    query: z.object({
      wait: z.int().min(0).max(30).optional().describe('Long-poll seconds (default 30)'),
    }),
  },
  'POST /runner/v1/jobs/:id/heartbeat': { id: 'runnerHeartbeat' },
  'POST /runner/v1/jobs/:id/logs': {
    id: 'appendRunnerLog',
    query: z.object({ step: z.int().min(0).max(63) }),
    rawBody: 'text/plain',
  },
  'POST /runner/v1/jobs/:id/steps/:step': { id: 'reportRunnerStep', body: stepSchema },
  'PUT /runner/v1/jobs/:id/artifacts/:name': {
    id: 'uploadRunnerArtifact',
    rawBody: 'application/octet-stream',
  },
  'POST /runner/v1/jobs/:id/complete': { id: 'completeRunnerJob', body: completeSchema },
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
  'GET /scim/v2/Groups': {
    id: 'scimListGroups',
    query: z.object({
      ...scimListQuery,
      excludedAttributes: z.string().optional().describe('`members` omits members'),
    }),
  },
  'POST /scim/v2/Groups': { id: 'scimCreateGroup', body: createGroupSchema },
  'GET /scim/v2/Groups/:id': { id: 'scimGetGroup' },
  'PATCH /scim/v2/Groups/:id': { id: 'scimPatchGroup', body: patchSchema },
  'DELETE /scim/v2/Groups/:id': { id: 'scimDeleteGroup' },
  'POST /oauth/token': {
    id: 'exchangeAgentToken',
    body: z.union([
      exchangeSchema,
      appTokenGrantSchema,
      codeGrantSchema,
      mcpCodeGrantSchema,
      refreshGrantSchema,
    ]),
  },
  'POST /oauth/register': { id: 'registerOAuthClient', body: registerClientSchema },
  'GET /oauth/authorize': { id: 'startOAuthAuthorization', query: authorizeQuery },
  'POST /oauth/authorize': {
    id: 'decideOAuthAuthorization',
    rawBody: 'application/x-www-form-urlencoded',
  },
  'GET /.well-known/oauth-authorization-server': { id: 'getOAuthServerMetadata' },
  'GET /.well-known/oauth-protected-resource': { id: 'getProtectedResourceMetadata' },
  'GET /.well-known/oauth-protected-resource/mcp': {
    id: 'getMcpProtectedResourceMetadata',
  },
  'POST /mcp': { id: 'postMcpMessage', body: mcpMessageSchema },
  'GET /mcp': { id: 'resumeMcpStream' },
  'DELETE /mcp': { id: 'deleteMcpSession' },
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
  'POST /api/v1/admin/secrets/rewrap': { id: 'rewrapSecretKeys' },
  'GET /api/v1/admin/agents/pause': { id: 'getInstanceAgentPause' },
  'POST /api/v1/admin/agents/pause': { id: 'pauseInstanceAgents', body: pauseSchema },
  'DELETE /api/v1/admin/agents/pause': { id: 'resumeInstanceAgents' },
  'POST /api/v1/policy/test': { id: 'testPolicy', body: policyTestSchema },
  'GET /api/v1/orgs/:org/policy': { id: 'getOrgPolicy' },
  'PUT /api/v1/orgs/:org/policy': { id: 'putOrgPolicy', body: agentPolicySchema },
  'GET /api/v1/orgs/:org/policy/versions': { id: 'listOrgPolicyVersions' },
  'GET /api/v1/orgs/:org/agents/pause': { id: 'getOrgAgentPause' },
  'POST /api/v1/orgs/:org/agents/pause': { id: 'pauseOrgAgents', body: pauseSchema },
  'DELETE /api/v1/orgs/:org/agents/pause': { id: 'resumeOrgAgents' },
  'GET /api/v1/repos/:repo/approvals': { id: 'listApprovals', query: approvalsQuery },
  'POST /api/v1/repos/:repo/approvals/:id': {
    id: 'decideApproval',
    body: decisionSchema,
  },
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
  'GET /api/v1/user': { id: 'getUser' },
  'GET /api/v1/oauth-apps': { id: 'listOAuthApps' },
  'POST /api/v1/oauth-apps': { id: 'createOAuthApp', body: createOAuthAppSchema },
  'DELETE /api/v1/oauth-apps/:id': { id: 'deleteOAuthApp' },
  'GET /api/v1/oauth/authorize': { id: 'getOAuthAuthorization', query: authorizeSchema },
  'POST /api/v1/oauth/authorize': {
    id: 'approveOAuthAuthorization',
    body: approveSchema,
  },
  'GET /api/v1/apps': { id: 'listApps' },
  'POST /api/v1/apps': { id: 'createApp', body: createAppSchema },
  'GET /api/v1/apps/:id': { id: 'getApp' },
  'DELETE /api/v1/apps/:id': { id: 'deleteApp' },
  'POST /api/v1/apps/:id/installations': { id: 'installApp', body: installAppSchema },
  'GET /api/v1/installations': { id: 'listInstallations' },
  'DELETE /api/v1/installations/:id': { id: 'deleteInstallation' },
  'GET /api/v1/hooks/:id': { id: 'getHook' },
  'PATCH /api/v1/hooks/:id': { id: 'updateHook', body: hookPatchSchema },
  'DELETE /api/v1/hooks/:id': { id: 'deleteHook' },
  'GET /api/v1/hooks/:id/deliveries': { id: 'listHookDeliveries' },
  'POST /api/v1/hooks/:id/deliveries/:delivery/redeliver': {
    id: 'redeliverHookDelivery',
  },

  'GET /api/v1/agents': { id: 'listAgents' },
  'POST /api/v1/agents': { id: 'createAgent', body: createAgentSchema },
  'PATCH /api/v1/agents/:id': { id: 'updateAgent', body: patchAgentSchema },
  'DELETE /api/v1/agents/:id/tokens': { id: 'revokeAgentTokens' },
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
  'GET /api/v1/orgs/:org/hooks': { id: 'listOrgHooks' },
  'POST /api/v1/orgs/:org/hooks': { id: 'createOrgHook', body: hookInputSchema },
  'GET /api/v1/orgs/:org/members': { id: 'listOrgMembers' },
  'PUT /api/v1/orgs/:org/members': { id: 'putOrgMember', body: putMemberSchema },
  'DELETE /api/v1/orgs/:org/members/:userId': { id: 'deleteOrgMember' },
  'GET /api/v1/orgs/:org/repos': { id: 'listOrgRepos' },
  'GET /api/v1/orgs/:org/rulesets': { id: 'listOrgRulesets' },
  'GET /api/v1/orgs/:org/secrets': { id: 'listOrgSecrets' },
  'PUT /api/v1/orgs/:org/secrets/:name': { id: 'putOrgSecret', body: secretBody },
  'DELETE /api/v1/orgs/:org/secrets/:name': { id: 'deleteOrgSecret' },
  'POST /api/v1/orgs/:org/runners/registration-token': {
    id: 'createOrgRunnerToken',
    body: registrationTokenBody,
  },
  'GET /api/v1/orgs/:org/runners': { id: 'listOrgRunners' },
  'PATCH /api/v1/orgs/:org/runners/:id': { id: 'updateOrgRunner', body: patchRunnerBody },
  'DELETE /api/v1/orgs/:org/runners/:id': { id: 'deleteOrgRunner' },
  'GET /api/v1/orgs/:org/variables': { id: 'listOrgVariables' },
  'PUT /api/v1/orgs/:org/variables/:name': { id: 'putOrgVariable', body: variableBody },
  'DELETE /api/v1/orgs/:org/variables/:name': { id: 'deleteOrgVariable' },
  'POST /api/v1/orgs/:org/rulesets': { id: 'createOrgRuleset', body: rulesetInputSchema },
  'PUT /api/v1/orgs/:org/rulesets/:id': {
    id: 'replaceOrgRuleset',
    body: rulesetInputSchema,
  },
  'DELETE /api/v1/orgs/:org/rulesets/:id': { id: 'deleteOrgRuleset' },
  'GET /api/v1/orgs/:org/rulesets/evaluations': {
    id: 'listOrgRulesetEvaluations',
    query: evaluationsQuery,
  },
  'GET /api/v1/orgs/:org/sso': { id: 'getOrgSso' },
  'PUT /api/v1/orgs/:org/sso': { id: 'putOrgSso', body: putSsoSchema },
  'DELETE /api/v1/orgs/:org/sso': { id: 'deleteOrgSso' },
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
  'POST /api/v1/repos/:repo/agents/mcp': {
    id: 'callMcp',
    body: rpcSchema,
    deprecated: true,
  },
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
      cs: rev,
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
  'GET /api/v1/repos/:repo/ci/pipelines': {
    id: 'listPipelines',
    query: z.object({ head: rev.optional() }),
  },
  'POST /api/v1/repos/:repo/ci/pipelines/runs': {
    id: 'runPipeline',
    body: manualPipelineRun,
  },
  'POST /api/v1/repos/:repo/ci/pipelines/runs/:id/cancel': { id: 'cancelPipelineRun' },
  'POST /api/v1/repos/:repo/ci/runs': { id: 'createCiRun', body: createRunSchema },
  'POST /api/v1/repos/:repo/ci/runs/:id/cancel': { id: 'cancelCiRun' },
  'POST /api/v1/repos/:repo/ci/runs/:id/retry': { id: 'retryCiRun' },
  'GET /api/v1/repos/:repo/ci/runs/:id/log': { id: 'getCiRunLog' },
  'GET /api/v1/repos/:repo/codeowners': {
    id: 'getCodeowners',
    query: z.object({
      rev: rev.optional().describe('Default: the default branch'),
      path: z.string().optional().describe('Also return the owners of this path'),
    }),
  },
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
      cs: rev,
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
  'GET /api/v1/repos/:repo/issue-templates': { id: 'listIssueTemplates' },
  'GET /api/v1/repos/:repo/hooks': { id: 'listRepoHooks' },
  'POST /api/v1/repos/:repo/hooks': { id: 'createRepoHook', body: hookInputSchema },
  'GET /api/v1/repos/:repo/issues': { id: 'listIssues', query: issueListQuery },
  'POST /api/v1/repos/:repo/issues': { id: 'createIssue', body: createIssue },
  'GET /api/v1/repos/:repo/issues/:number': { id: 'getIssue' },
  'PATCH /api/v1/repos/:repo/issues/:number': { id: 'updateIssue', body: updateIssue },
  'DELETE /api/v1/repos/:repo/issues/:number': { id: 'deleteIssue' },
  'PUT /api/v1/repos/:repo/issues/:number/assignees': {
    id: 'setIssueAssignees',
    body: assigneesInput,
  },
  'POST /api/v1/repos/:repo/issues/:number/comments': {
    id: 'commentOnIssue',
    body: commentInput,
  },
  'PUT /api/v1/repos/:repo/issues/:number/labels': {
    id: 'setIssueLabels',
    body: labelsInput,
  },
  'PUT /api/v1/repos/:repo/issues/:number/lock': { id: 'lockIssue', body: flagInput },
  'PUT /api/v1/repos/:repo/issues/:number/pin': { id: 'pinIssue', body: flagInput },
  'POST /api/v1/repos/:repo/issues/:number/sub-issues': {
    id: 'addSubIssue',
    body: subIssueInput,
  },
  'PUT /api/v1/repos/:repo/issues/:number/sub-issues': {
    id: 'reorderSubIssues',
    body: subIssueOrderInput,
  },
  'DELETE /api/v1/repos/:repo/issues/:number/sub-issues/:child': {
    id: 'removeSubIssue',
  },
  'GET /api/v1/repos/:repo/labels': { id: 'listLabels' },
  'POST /api/v1/repos/:repo/labels': { id: 'createLabel', body: createLabel },
  'DELETE /api/v1/repos/:repo/labels/:name': { id: 'deleteLabel' },
  'GET /api/v1/repos/:repo/import/:job_id': { id: 'getImport' },
  'GET /api/v1/repos/:repo/members': { id: 'listRepoMembers' },
  'PUT /api/v1/repos/:repo/members': { id: 'putRepoMember', body: memberSchema },
  'DELETE /api/v1/repos/:repo/members/:userId': { id: 'deleteRepoMember' },
  'GET /api/v1/repos/:repo/milestones': { id: 'listMilestones' },
  'POST /api/v1/repos/:repo/milestones': { id: 'createMilestone', body: milestoneInput },
  'PATCH /api/v1/repos/:repo/milestones/:id': {
    id: 'updateMilestone',
    body: updateMilestone,
  },
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
  'GET /api/v1/repos/:repo/pulls/:id/conflicts': { id: 'getPullConflicts' },
  'POST /api/v1/repos/:repo/pulls/:id/merge': { id: 'mergePull', body: mergePullSchema },
  'POST /api/v1/repos/:repo/pulls/:id/update-branch': {
    id: 'updatePullBranch',
    body: updateBranchSchema,
  },
  'POST /api/v1/repos/:repo/pulls/:id/review': {
    id: 'reviewPull',
    body: reviewPullSchema,
  },
  'POST /api/v1/repos/:repo/pulls/:id/update': {
    id: 'updatePull',
    body: updatePullSchema,
  },
  'GET /api/v1/repos/:repo/pulls/:id/codeowners': { id: 'getPullCodeowners' },
  'GET /api/v1/repos/:repo/pulls/:id/reviewers': { id: 'listReviewRequests' },
  'PUT /api/v1/repos/:repo/pulls/:id/reviewers': {
    id: 'setReviewRequests',
    body: reviewersInput,
  },
  'POST /api/v1/repos/:repo/pulls/:id/suggestions/apply': {
    id: 'applySuggestions',
    body: applySuggestionsInput,
  },
  'GET /api/v1/repos/:repo/pulls/:id/threads': { id: 'listReviewThreads' },
  'POST /api/v1/repos/:repo/pulls/:id/threads': {
    id: 'createReviewThread',
    body: createThreadInput,
  },
  'POST /api/v1/repos/:repo/pulls/:id/threads/:thread/replies': {
    id: 'replyToReviewThread',
    body: replyInput,
  },
  'PUT /api/v1/repos/:repo/pulls/:id/threads/:thread/resolution': {
    id: 'resolveReviewThread',
    body: resolutionInput,
  },
  'GET /api/v1/repos/:repo/refs': {
    id: 'listRefs',
    query: z.object({ prefix: z.string().optional(), ...page }),
  },
  'GET /api/v1/repos/:repo/refs/:name': { id: 'getRef' },
  'PUT /api/v1/repos/:repo/refs/:name': { id: 'moveRef', body: moveRefSchema },
  'GET /api/v1/repos/:repo/rulesets': { id: 'listRulesets' },
  'POST /api/v1/repos/:repo/runners/registration-token': {
    id: 'createRepoRunnerToken',
    body: registrationTokenBody,
  },
  'GET /api/v1/repos/:repo/runners': { id: 'listRepoRunners' },
  'PATCH /api/v1/repos/:repo/runners/:id': {
    id: 'updateRepoRunner',
    body: patchRunnerBody,
  },
  'DELETE /api/v1/repos/:repo/runners/:id': { id: 'deleteRepoRunner' },
  'GET /api/v1/repos/:repo/secrets': { id: 'listRepoSecrets', query: environmentQuery },
  'PUT /api/v1/repos/:repo/secrets/:name': {
    id: 'putRepoSecret',
    query: environmentQuery,
    body: secretBody,
  },
  'DELETE /api/v1/repos/:repo/secrets/:name': {
    id: 'deleteRepoSecret',
    query: environmentQuery,
  },
  'GET /api/v1/repos/:repo/variables': {
    id: 'listRepoVariables',
    query: environmentQuery,
  },
  'PUT /api/v1/repos/:repo/variables/:name': {
    id: 'putRepoVariable',
    query: environmentQuery,
    body: variableBody,
  },
  'DELETE /api/v1/repos/:repo/variables/:name': {
    id: 'deleteRepoVariable',
    query: environmentQuery,
  },
  'GET /api/v1/repos/:repo/environments': { id: 'listEnvironments' },
  'PUT /api/v1/repos/:repo/environments/:env': {
    id: 'putEnvironment',
    body: environmentBody,
  },
  'DELETE /api/v1/repos/:repo/environments/:env': { id: 'deleteEnvironment' },
  'GET /api/v1/repos/:repo/environment-approvals': {
    id: 'listEnvironmentApprovals',
    query: z.object({
      state: z
        .enum(['pending', 'approved', 'rejected', 'dispatched', 'expired', 'failed'])
        .optional(),
    }),
  },
  'POST /api/v1/repos/:repo/environment-approvals/:id': {
    id: 'decideEnvironmentApproval',
    body: decisionBody,
  },
  'POST /api/v1/repos/:repo/rulesets': { id: 'createRuleset', body: rulesetInputSchema },
  'PUT /api/v1/repos/:repo/rulesets/:id': {
    id: 'replaceRuleset',
    body: rulesetInputSchema,
  },
  'DELETE /api/v1/repos/:repo/rulesets/:id': { id: 'deleteRuleset' },
  'GET /api/v1/repos/:repo/rulesets/evaluations': {
    id: 'listRulesetEvaluations',
    query: evaluationsQuery,
  },
  'GET /api/v1/repos/:repo/tags': { id: 'listTags', query: z.object(page) },
  'GET /api/v1/repos/:repo/work': { id: 'listWork', query: workListQuery },
  'POST /api/v1/repos/:repo/work/claim': { id: 'claimWork', body: claimWork },
  'POST /api/v1/repos/:repo/work/import-labels': {
    id: 'importWorkLabels',
    body: importLabels,
  },
  'GET /api/v1/repos/:repo/work/:number': { id: 'getWork' },
  'PUT /api/v1/repos/:repo/work/:number': { id: 'updateWork', body: updateWork },
  'POST /api/v1/repos/:repo/work/:number/heartbeat': {
    id: 'heartbeatWork',
    body: heartbeatWork,
  },
  'POST /api/v1/repos/:repo/work/:number/release': {
    id: 'releaseWork',
    body: releaseWork,
  },
  'POST /api/v1/repos/:repo/tags': { id: 'createTag', body: createTagSchema },
  'GET /api/v1/repos/:repo/tree': {
    id: 'getTree',
    query: z.object({
      cs: rev,
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
