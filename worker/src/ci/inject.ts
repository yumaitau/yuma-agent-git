import type { Env } from '../env';
import type { RepoRecord } from '../db/client';
import { getRepo } from '../db/repos';
import { ApiError } from '../core/errors';
import type { Principal } from '../auth/principal';
import { guardAgentAction, type Guard } from '../policy/guardrails';
import { pauseFor, pauseMessage } from '../policy/pause';
import { resolveForJob } from '../secrets/store';
import type { CiPolicy, CiRun } from './config';
import { parseContext, type RunContext } from './context';
import { jobTrust } from './environments';
import { githubEnv } from './gha/env';
import { createRequestToken, issuerFor, MAX_LIFETIME_SECONDS, mintIdToken } from './oidc';

export const AWS_TOKEN_FILE = '/run/yag/aws-web-identity-token';

export interface JobAccess {
  /** Extra environment for repository commands only. */
  env: Record<string, string>;
  /** Values the log masker must hide. */
  mask: string[];
  /** Files to write (mode 0600) before the first command. */
  files: { path: string; content: string }[];
  /** One log line describing what was injected (names only) or withheld. */
  summary: string;
}

/** The agent a job acts for, as guardrails (#62) judge it. */
export function jobAgent(job: CiRun, agentId: string): Principal {
  return {
    kind: 'agent',
    userId: job.requested_by,
    agentId,
    jti: `ci-run:${job.id}`,
    taskId: null,
    scopes: [],
    repoIds: [job.repo_id],
  };
}

/**
 * Agent guardrails (#62) for a job an agent started, in either pool: the kill
 * switch, and the `deploy` policy for a job that names an environment. The
 * approval binds the job and revision, not the run, so a built-in run that
 * was held passes when started again once a human approves.
 */
export async function guardAgentJob(
  env: Env,
  repo: RepoRecord,
  job: CiRun,
  policy: CiPolicy,
  context: RunContext | null,
): Promise<Guard> {
  if (!context?.agent_id) return { outcome: 'allow' };
  if (!policy.environment) {
    const pause = await pauseFor(env, repo);
    if (!pause) return { outcome: 'allow' };
    const message = pauseMessage(pause);
    return { outcome: 'deny', code: 'agents_paused', message, details: {} };
  }
  const agent = jobAgent(job, context.agent_id);
  const deploy = {
    job: job.job_key ?? null,
    environment: policy.environment,
    head_cs: job.head_cs,
  };
  return guardAgentAction(
    env,
    agent,
    repo,
    { action: 'deploy', ...(context.ref ? { ref: context.ref } : {}) },
    { exact: deploy, summary: { run: job.id, ...deploy } },
  );
}

/**
 * Credentials for a job, built once at job start inside the runner (issue
 * #50): variables, the secrets the pipeline names, a per-run OIDC request
 * token, an AWS web identity token file, and a login for the forge's package
 * registry (#53) that the same request token serves. Untrusted runs get
 * nothing.
 */
export async function prepareJob(
  env: Env,
  job: CiRun,
  policy: CiPolicy,
  deadline: number,
): Promise<JobAccess> {
  const none: JobAccess = { env: {}, mask: [], files: [], summary: '' };
  const wants =
    policy.secrets.length > 0 ||
    policy.permissions.id_token === 'write' ||
    policy.permissions.packages === 'write' ||
    policy.environment !== null;
  const context = parseContext(job.context);
  const repo = await getRepo(env, job.repo_id);
  if (repo) {
    // checked again here: a built-in job reaches this point with no claim guard
    const guard = await guardAgentJob(env, repo, job, policy, context);
    if (guard.outcome !== 'allow')
      throw new ApiError(403, guard.code, guard.message, guard.details);
  }
  const trust = await jobTrust(env, job, policy, context);
  // GITHUB_* for translated workflows (#49), trusted or not: they hold no secrets
  const github = repo ? await githubEnv(env, job, repo, context) : {};
  if (!trust.ok || !context || !repo)
    return {
      ...none,
      env: github,
      summary: wants
        ? `Secrets, variables and OIDC withheld: ${trust.reason || 'repository unavailable'}.`
        : '',
    };
  const resolved = await resolveForJob(env, repo, policy.environment, policy.secrets);
  const access: JobAccess = {
    env: { ...github, ...resolved.variables, ...resolved.secrets },
    mask: Object.values(resolved.secrets),
    files: [],
    summary: '',
  };
  const notes: string[] = [];
  const injected = Object.keys(resolved.secrets);
  const missing = policy.secrets.filter((n) => !(n.toUpperCase() in resolved.secrets));
  if (injected.length) notes.push(`secrets ${injected.join(', ')}`);
  if (missing.length) notes.push(`secrets not set: ${missing.join(', ')}`);
  const variables = Object.keys(resolved.variables).length;
  if (variables) notes.push(`${variables} variable${variables === 1 ? '' : 's'}`);
  if (policy.environment) notes.push(`environment ${policy.environment}`);
  let request: string | null = null;
  if (policy.permissions.id_token === 'write') {
    if (!env.CI_OIDC_SIGNING_KEYS) notes.push('OIDC not configured by the operator');
    else if (!env.CI_OIDC_ISSUER && !context.origin)
      notes.push('OIDC for scheduled runs needs CI_OIDC_ISSUER');
    else {
      request = await createRequestToken(env, job.id, deadline);
      const url = `${issuerFor(env, context.origin)}/token?run_id=${job.id}`;
      Object.assign(access.env, {
        YAG_ID_TOKEN_REQUEST_URL: url,
        YAG_ID_TOKEN_REQUEST_TOKEN: request,
        ACTIONS_ID_TOKEN_REQUEST_URL: url,
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: request,
      });
      access.mask.push(request);
      notes.push('OIDC token requests');
      if (policy.aws) {
        // valid until the run deadline (v1 runs stop at 10 minutes), capped at 1 hour
        const lifetime = Math.min(
          MAX_LIFETIME_SECONDS,
          Math.ceil((deadline - Date.now()) / 1000) + 60,
        );
        const minted = await mintIdToken(
          env,
          job,
          policy,
          context,
          'sts.amazonaws.com',
          lifetime,
        ).catch((err: unknown) => {
          notes.push(
            `no AWS token: ${err instanceof ApiError ? err.message : 'signing failed'}`,
          );
          return null;
        });
        if (minted) {
          const token = minted.token;
          access.files.push({ path: AWS_TOKEN_FILE, content: token });
          access.mask.push(token);
          Object.assign(access.env, {
            AWS_WEB_IDENTITY_TOKEN_FILE: AWS_TOKEN_FILE,
            AWS_ROLE_ARN: policy.aws.role_arn,
            AWS_REGION: policy.aws.region,
            AWS_DEFAULT_REGION: policy.aws.region,
            AWS_ROLE_SESSION_NAME: policy.aws.session_name ?? `yag-${job.id}`,
          });
          notes.push(`AWS role ${policy.aws.role_arn}`);
        }
      }
    }
  }
  if (policy.permissions.packages === 'write') {
    // the registry takes the request token as a password: `helm registry login`,
    // `docker login`, or an npm `_authToken`
    if (!context.origin) notes.push('registry login needs a run started from the forge');
    else {
      if (request === null) {
        request = await createRequestToken(env, job.id, deadline);
        access.mask.push(request);
      }
      const host = new URL(context.origin).host;
      Object.assign(access.env, {
        YAG_REGISTRY: host,
        YAG_REGISTRY_USERNAME: 'ci',
        YAG_REGISTRY_PASSWORD: request,
      });
      notes.push(`registry ${host}`);
    }
  }
  access.summary = notes.length ? `Job access: ${notes.join('; ')}.` : '';
  return access;
}
