# CI secrets, environments and OIDC deploys to AWS

Issue #50. CI jobs can now receive credentials, but only when the pipeline asks
for them and the run passes every check below. This page covers the security
model, operator setup, key rotation, an AWS setup that pushes a Helm chart to
ECR and deploys to EKS, and how the same tokens work with other clouds.

## Security model

By default a job still gets no credentials. The repository CI settings, or each
job of a YAML pipeline ([pipelines](pipelines.md)), opt in with these fields:

| Pipeline setting                                            | What the job gets                                                                                                            |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `secrets: ["NAME", ...]`                                    | Those secrets as environment variables (environment, then repository, then org value)                                        |
| (always, for trusted runs)                                  | All variables at the same three scopes                                                                                       |
| `permissions: { id_token: "write" }`                        | A per-run request token to fetch OIDC ID tokens (`YAG_ID_TOKEN_REQUEST_URL` / `_TOKEN` and the `ACTIONS_ID_TOKEN_*` names)   |
| `aws: { role_arn, region, session_name? }` (needs id_token) | A token file plus `AWS_WEB_IDENTITY_TOKEN_FILE`, `AWS_ROLE_ARN`, `AWS_REGION`, `AWS_DEFAULT_REGION`, `AWS_ROLE_SESSION_NAME` |
| `environment: "production"`                                 | That environment's secrets and variables, after its protection rules pass                                                    |

Protections, all enforced on the server:

- **Untrusted runs get nothing.** Pull requests from forks, pull requests whose
  author no longer has write access, and runs without a recorded trigger get
  no secrets, variables or tokens. (Pull requests come only from the same
  repository today; the fork check is in place for when forks arrive.)
- **Environments gate deploys.** Required reviewers (people or team members;
  never the person or agent that started the run), a wait timer, allowed
  branch and tag globs, and a "people only" flag that refuses runs started
  with a bearer token. A gated run waits as an approval request; its `ci_runs`
  row is created only when it is dispatched, and the runner checks the
  approval again before injecting anything. The approver is in the audit log.
- **Injection happens at job start, inside the run's VM.** Values go to the
  repository commands as process environment only. They never reach the
  container image, the trusted boot script, or the separate publisher VM.
- **Logs are masked.** Every injected value, the request token and the AWS
  token are replaced with `***`, including base64 (any alignment, wrapped at
  76 columns), URL-encoded forms and values split across lines or log chunks.
  Values shorter than 4 characters cannot be stored, because they cannot be
  masked safely.
- **Org secrets reach every org repository** whose pipeline names them; org
  owners and admins manage them. Keep deploy credentials at environment scope.
- **Secrets are write-only.** No API returns a secret value. Writes need a
  browser session, repo or org admin rights, and a passkey or authenticator
  step-up in the last 12 hours when the user has one enrolled.
- **Envelope encryption.** Values are AES-256-GCM encrypted with a per-owner
  data key; data keys are wrapped by the `SECRETS_KEK` Worker secret. The
  ciphertext is bound to its scope and name, so a row copied elsewhere does not
  decrypt.
- **Short-lived identity.** ID tokens last 10 minutes by default (1 hour
  maximum). Request tokens are stored hashed, bound to one run, and stop
  working when the run ends or reaches its deadline.
- **Everything is audited**: secret, variable and environment changes,
  approval requests and decisions, and every ID token issued (its claims,
  never the token).

What this does not protect against: an opted-in job runs repository code
with internet access, so it can send its secrets anywhere. Anyone who can
change that code on a trusted branch, or open a pull request as a writer, can
read repository-level secrets in a run. Put deploy credentials behind a
protected environment, and prefer OIDC roles with narrow trust policies over
stored keys.

## Operator setup

1. Generate an OIDC signing key. The script writes files with mode 0600, never
   overwrites, and prints only key ids:

   ```bash
   node scripts/ci-keys.mjs oidc-new --out ci-oidc-keys.json
   npx wrangler secret put CI_OIDC_SIGNING_KEYS --env prod -c worker/wrangler.jsonc < ci-oidc-keys.json
   ```

   Keep `ci-oidc-keys.json` in your password manager or vault (you need it to
   rotate; Worker secrets cannot be read back), then delete the local copy.

2. Generate the secrets key-encryption key the same way:

   ```bash
   node scripts/ci-keys.mjs kek --out secrets-kek.txt
   npx wrangler secret put SECRETS_KEK --env prod -c worker/wrangler.jsonc < secrets-kek.txt
   ```

3. Optional: set `CI_OIDC_ISSUER` (a plain var) when the forge has a custom
   domain, for example `https://git.example.com/ci/oidc`. Without it the issuer
   is `{request origin}/ci/oidc`. The value must not change once cloud trust
   policies use it.
4. Optional: set `SECRETS_ADMIN_USER_IDS` (comma-separated user ids) for the
   people who may run the KEK re-wrap.
5. Deploy. `/ci/oidc/*` is in `run_worker_first`, and the discovery document
   and JWKS are public, so cloud IAM can fetch them anonymously:

   ```bash
   curl https://git.example.com/ci/oidc/.well-known/openid-configuration
   curl https://git.example.com/ci/oidc/jwks
   ```

The runner image now includes the AWS CLI v2, Helm 3 and kubectl, pinned and
checksum-verified in `worker/runner/Dockerfile`. Rebuilding the image happens
on the next `wrangler deploy --env prod`.

## Key rotation

### OIDC signing key

The first key in `CI_OIDC_SIGNING_KEYS` signs; every key is published in the
JWKS. Rotate in three steps so verifiers that cache the JWKS never see an
unknown key id:

```bash
# 1. Publish the next key; the current key keeps signing.
node scripts/ci-keys.mjs oidc-stage --current ci-oidc-keys.json --out stage.json
npx wrangler secret put CI_OIDC_SIGNING_KEYS --env prod -c worker/wrangler.jsonc < stage.json
# Wait at least 24 hours for JWKS caches to refresh.

# 2. Sign with the new key; the old key stays published without its private part.
node scripts/ci-keys.mjs oidc-promote --current stage.json --out promote.json
npx wrangler secret put CI_OIDC_SIGNING_KEYS --env prod -c worker/wrangler.jsonc < promote.json
# Wait at least 1 hour (the longest token lifetime).

# 3. Stop publishing the old key.
node scripts/ci-keys.mjs oidc-retire --current promote.json --out retire.json
npx wrangler secret put CI_OIDC_SIGNING_KEYS --env prod -c worker/wrangler.jsonc < retire.json
```

Store the latest file in your vault and delete the others. If a signing key
leaks, skip the waits: promote immediately and retire as soon as running jobs
finish; tokens signed by the leaked key stop verifying once it is retired.

### Secrets KEK

Data keys are wrapped by the KEK; secret ciphertexts never change, so KEK
rotation has no downtime:

```bash
# Build a key ring holding the previous KEK (from your vault) and a new current key.
node scripts/ci-keys.mjs kek --previous secrets-kek.txt --out kek-ring.json
npx wrangler secret put SECRETS_KEK --env prod -c worker/wrangler.jsonc < kek-ring.json
# Re-wrap every data key under the new KEK (repeat until remaining is 0).
curl -X POST https://git.example.com/api/v1/admin/secrets/rewrap \
  -H "cookie: yag_session=…"     # a SECRETS_ADMIN_USER_IDS user with a fresh MFA step-up
# → {"current":"v2","rewrapped":3,"remaining":0}
```

When `remaining` is 0, remove the old key from the ring (keep `current` and
its key) and put the secret again. Until then, both keys must stay in the ring.

## AWS: push a Helm chart to ECR and deploy to EKS

Replace `git.example.com`, `123456789012`, `ap-southeast-2`, `acme/app`,
`prod` and `myapp` with your values.

### 1. Create the IAM OIDC identity provider

```bash
aws iam create-open-id-connect-provider \
  --url https://git.example.com/ci/oidc \
  --client-id-list sts.amazonaws.com
```

The URL must equal the token's `iss` exactly (no trailing slash). The
thumbprint list is optional: IAM fetches it, and for certificates from
well-known public CAs (as on Cloudflare-served domains) it validates against
its own trust store. The condition keys are
`git.example.com/ci/oidc:aud` and `git.example.com/ci/oidc:sub`.

### 2. Trust policy: one repository and branch

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::123456789012:oidc-provider/git.example.com/ci/oidc"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "git.example.com/ci/oidc:aud": "sts.amazonaws.com",
          "git.example.com/ci/oidc:sub": "repo:acme/app:ref:refs/heads/main"
        }
      }
    }
  ]
}
```

### 2b. Trust policy: one protected environment

A pipeline with `environment` set gets `sub = repo:<owner>/<repo>:environment:<env>`,
so the role can only be assumed after that environment's reviewers approved:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::123456789012:oidc-provider/git.example.com/ci/oidc"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "git.example.com/ci/oidc:aud": "sts.amazonaws.com",
          "git.example.com/ci/oidc:sub": "repo:acme/app:environment:production"
        }
      }
    }
  ]
}
```

GitHub Actions trust policies port over by changing the provider and the
`token.actions.githubusercontent.com` condition prefix; the `sub` formats are
the same (`repo:o/r:ref:refs/tags/v1.0.0` and `repo:o/r:pull_request` too).
Never use `StringLike` with `repo:acme/*` on a deploy role.

### 3. Permissions: ECR chart push and EKS deploy

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "EcrLogin",
      "Effect": "Allow",
      "Action": "ecr:GetAuthorizationToken",
      "Resource": "*"
    },
    {
      "Sid": "EcrCharts",
      "Effect": "Allow",
      "Action": [
        "ecr:BatchCheckLayerAvailability",
        "ecr:BatchGetImage",
        "ecr:GetDownloadUrlForLayer",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload",
        "ecr:PutImage",
        "ecr:DescribeImages"
      ],
      "Resource": "arn:aws:ecr:ap-southeast-2:123456789012:repository/charts/app"
    },
    {
      "Sid": "EksKubeconfig",
      "Effect": "Allow",
      "Action": "eks:DescribeCluster",
      "Resource": "arn:aws:eks:ap-southeast-2:123456789012:cluster/prod"
    }
  ]
}
```

Create the ECR repository `charts/app` first. Kubernetes permissions come from
an EKS access entry, not IAM:

```bash
aws eks create-access-entry --cluster-name prod \
  --principal-arn arn:aws:iam::123456789012:role/yag-deploy
aws eks associate-access-policy --cluster-name prod \
  --principal-arn arn:aws:iam::123456789012:role/yag-deploy \
  --policy-arn arn:aws:eks::aws:cluster-access-policy/AmazonEKSEditPolicy \
  --access-scope type=namespace,namespaces=myapp
```

### 4. Pipeline

Use two roles so the chart push and the deploy are separate trust decisions:

- `yag-chart-push`: trust policy 2 (`ref:refs/heads/main`), the `EcrLogin`
  and `EcrCharts` statements.
- `yag-deploy`: trust policy 2b (`environment:production`), `EcrLogin`, read
  access to `charts/app` and `EksKubeconfig`, plus the EKS access entry.

Create the `production` environment (reviewers, `allowed_branches: ["main"]`,
people only) under **CI → Secrets and environments**, and the repository
variable `ECR_REGISTRY` (`123456789012.dkr.ecr.ap-southeast-2.amazonaws.com`).
Then commit `.yuma/pipelines/deploy.yml` ([pipelines](pipelines.md)):

```yaml
name: deploy
on:
  push:
    branches: [main]
  manual:
concurrency:
  group: deploy-${{ ref }}
jobs:
  chart:
    timeout_seconds: 600
    permissions: { id_token: write }
    aws:
      role_arn: arn:aws:iam::123456789012:role/yag-chart-push
      region: ap-southeast-2
    steps:
      - run: aws sts get-caller-identity
      - run: aws ecr get-login-password | helm registry login --username AWS --password-stdin ${{ vars.ECR_REGISTRY }}
      - run: helm package charts/app -d dist && helm push dist/app-*.tgz oci://${{ vars.ECR_REGISTRY }}/charts
  deploy:
    needs: chart
    environment: production
    timeout_seconds: 600
    permissions: { id_token: write }
    aws:
      role_arn: arn:aws:iam::123456789012:role/yag-deploy
      region: ap-southeast-2
    steps:
      - run: aws eks update-kubeconfig --name prod
      - run: |
          version="$(helm show chart charts/app | sed -n 's/^version: //p')"
          helm upgrade --install app "oci://${{ vars.ECR_REGISTRY }}/charts/app" --version "$version" -n myapp --wait
      - run: kubectl -n myapp rollout status deploy/app --timeout=120s
```

A push to `main` runs `chart` at once with `sub = repo:acme/app:ref:refs/heads/main`.
When it passes, `deploy` waits for a `production` reviewer (the person or agent
that pushed cannot approve it); the pipeline shows "Waiting for approval to
deploy to production" and the request is listed under **CI → Secrets and
environments** and `GET /api/v1/repos/acme/app/environment-approvals`. Once
approved (and after any wait timer), `deploy` starts with
`sub = repo:acme/app:environment:production` and the environment's secrets and
variables. A rejected or expired request, a branch outside
`allowed_branches`, or a pipeline started by an agent token under a people-only
environment skips `deploy` with the reason. The AWS CLI and SDKs read
`AWS_WEB_IDENTITY_TOKEN_FILE` themselves, so ECR login, `helm` and
`aws eks get-token` (used by the kubeconfig) all authenticate without keys.

The repository CI settings (the v1 settings pipeline) take the same fields for
a single job: `PUT /api/v1/repos/acme/app/ci` with `environment`, `secrets`,
`permissions` and `aws`. Starting that run returns `{"approval": {...}}` while
it waits. **Retry** on a finished settings run
(`POST /api/v1/repos/acme/app/ci/runs/:id/retry`) reuses its trigger (event,
ref, pull request), so the retried run passes the same branch rules, asks for
approval again and gets the same `sub`.

**Token lifetime.** The AWS token file is written once at job start and is
valid until the job deadline plus a minute (jobs stop at 10 minutes, the cap
is 1 hour). The SDK exchanges it for STS credentials that last 1 hour by
default, so no refresh is needed.

## Claims

| Claim               | Example                                                  |
| ------------------- | -------------------------------------------------------- |
| `iss`               | `https://git.example.com/ci/oidc`                        |
| `aud`               | `sts.amazonaws.com` (default) or `?audience=` on request |
| `sub`               | see below                                                |
| `repository`        | `acme/app`                                               |
| `repository_owner`  | `acme`                                                   |
| `repository_id`     | forge repo id                                            |
| `ref`, `ref_type`   | `refs/heads/main`, `branch` (or `tag`, or `''` for PRs)  |
| `sha`               | Git SHA-1 of the commit (when computed)                  |
| `changeset`         | forge changeset id                                       |
| `run_id`, `job`     | run uuid, pipeline job key (`deploy`) or `ci`            |
| `event_name`        | `workflow_dispatch`, `pull_request`, `push`, `schedule`  |
| `environment`       | `production` (only when set)                             |
| `actor`, `actor_id` | login and user id that started the run                   |
| `actor_kind`        | `human` (session), `agent` (token), `system` (schedule)  |
| `job_workflow_ref`  | `acme/app/.yuma/pipelines/deploy.yml@refs/heads/main`    |
| `iat`, `nbf`, `exp` | issue time, same, `iat` + 600 (60 to 3600 on request)    |
| `jti`               | unique token id (in the audit log)                       |

`sub` is the first that applies:
`repo:<owner>/<repo>:environment:<env>`, `repo:<owner>/<repo>:pull_request`,
`repo:<owner>/<repo>:ref:refs/heads/<branch>`, `repo:<owner>/<repo>:ref:refs/tags/<tag>`.
Each pipeline job gets its own `sub` from its own `environment`, so in one
pipeline a build job and a deploy job match different trust policies. A run of
a bare changeset id (no branch, tag, PR or environment) cannot get a token.
Scheduled runs have no request origin, so they need `CI_OIDC_ISSUER` set to get
tokens.

Request a token for another audience from inside a job:

```bash
curl -fsS -H "authorization: Bearer $YAG_ID_TOKEN_REQUEST_TOKEN" \
  "$YAG_ID_TOKEN_REQUEST_URL&audience=api://AzureADTokenExchange" | jq -r .value
```

Tools built for GitHub Actions that read `ACTIONS_ID_TOKEN_REQUEST_URL` and
`ACTIONS_ID_TOKEN_REQUEST_TOKEN` work unchanged.

## Other clouds and Vault

The tokens are standard OIDC JWTs (RS256, public JWKS), so the GitHub recipes
work with the issuer and `sub` values above:

- **Google Cloud workload identity federation**: create an OIDC provider with
  issuer `https://git.example.com/ci/oidc`, map `google.subject=assertion.sub`
  and `attribute.repository=assertion.repository`, and request the token with
  the provider's audience.
- **Azure federated credentials**: on an app registration or managed identity,
  add a federated credential with issuer `https://git.example.com/ci/oidc`,
  subject `repo:acme/app:environment:production` and audience
  `api://AzureADTokenExchange`.
- **HashiCorp Vault JWT auth**: `vault write auth/jwt/config
oidc_discovery_url=https://git.example.com/ci/oidc bound_issuer=https://git.example.com/ci/oidc`,
  then a role with `bound_audiences` and `bound_claims` on `sub` or
  `repository` + `environment`.
- **Cloudflare**: Cloudflare API tokens cannot be exchanged for OIDC tokens
  today. Store a narrowly scoped API token as an environment secret instead.

## Acceptance check against a real AWS account (manual)

Not run in CI: it needs a public deployment and a test AWS account. Steps:

1. Deploy this branch to a test forge with a public HTTPS hostname, with
   `CI_OIDC_SIGNING_KEYS` and `SECRETS_KEK` set and CI enabled.
2. Check `curl https://<host>/ci/oidc/.well-known/openid-configuration` returns
   the issuer `https://<host>/ci/oidc`, and `/ci/oidc/jwks` returns one RSA key.
3. In the test account, create the OIDC provider (step 1 above) and a role
   `yag-oidc-test` with the branch trust policy (step 2) for your test repo and
   `main`, and no permissions beyond what `sts:GetCallerIdentity` needs (none).
4. Save the test repo's pipeline with `permissions.id_token: "write"`, `aws`
   pointing at the role, and commands `aws sts get-caller-identity`.
5. Start a run on `main`. Expected: the log shows the assumed-role ARN
   `arn:aws:sts::<account>:assumed-role/yag-oidc-test/yag-<run id>`.
6. Negative checks: change the trust policy `sub` to another branch and rerun
   (expect `AccessDenied` from `AssumeRoleWithWebIdentity`); run from another
   branch with the original policy (expect `AccessDenied`).
7. Check the forge audit log has a `ci.oidc.token` event with the run's claims.
8. Delete the role and the OIDC provider from the test account.
