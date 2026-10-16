import type { Env } from '../env';
import { getRepo } from '../db/repos';
import { ApiError } from '../core/errors';
import { resolveForJob } from '../secrets/store';
import type { CiPolicy, CiRun } from './config';
import { parseContext } from './context';
import { jobTrust } from './environments';
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

/**
 * Credentials for a job, built once at job start inside the runner (issue
 * #50): variables, the secrets the pipeline names, a per-run OIDC request
 * token, and an AWS web identity token file. Untrusted runs get nothing.
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
    policy.environment !== null;
  const context = parseContext(job.context);
  const trust = await jobTrust(env, job, policy, context);
  const repo = await getRepo(env, job.repo_id);
  if (!trust.ok || !context || !repo)
    return {
      ...none,
      summary: wants
        ? `Secrets, variables and OIDC withheld: ${trust.reason || 'repository unavailable'}.`
        : '',
    };
  const resolved = await resolveForJob(env, repo, policy.environment, policy.secrets);
  const access: JobAccess = {
    env: { ...resolved.variables, ...resolved.secrets },
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
  if (policy.permissions.id_token === 'write') {
    if (!env.CI_OIDC_SIGNING_KEYS) notes.push('OIDC not configured by the operator');
    else if (!env.CI_OIDC_ISSUER && !context.origin)
      notes.push('OIDC for scheduled runs needs CI_OIDC_ISSUER');
    else {
      const request = await createRequestToken(env, job.id, deadline);
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
  access.summary = notes.length ? `Job access: ${notes.join('; ')}.` : '';
  return access;
}
