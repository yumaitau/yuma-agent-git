# Evidence index (DRAFT)

> DRAFT readiness material for issue #69, not approved. **IRAP-experienced
> reviewer: pending.** Every pointer is to something in this repository on 17
> October 2026, or is marked as missing. Nothing here has been checked by an
> assessor.

How to produce the test evidence: `npm test -w worker` (miniflare, no
network), `npm run test:ui -w worker`, `npm test -w yag`
(`YAG_GIT_SMOKE=1` for the real Git smoke). CI runs the same on every pull
request (`.github/workflows/ci.yml`).

## Evidence by topic

| Topic                       | Code                                                   | Tests (`worker/test/`)                                                                    | Audit events (`audit/record.ts`)                               | Docs                                                       |
| --------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------- |
| Authentication and sessions | `auth/oauth.ts`, `auth/oidc.ts`, `auth/session.ts`     | `auth.test.ts`, `oidc.test.ts`, `unique-login.test.ts`                                    | `auth.login`, `auth.logout`, `session.create`, `identity.link` | `docs/deploy.md` section 3a                                |
| MFA                         | `auth/webauthn.ts`, `auth/totp.ts`                     | `mfa.test.ts`                                                                             | `auth.mfa`, `mfa.passkey.*`, `mfa.totp.*`                      | `docs/deploy.md`                                           |
| Provisioning                | `auth/scim.ts`                                         | `scim.test.ts`                                                                            | `scim.user.*`, `scim.group.*`, `scim_token.*`                  | `docs/deploy.md`                                           |
| Org SSO enforcement         | `auth/sso.ts`, `api/org-sso.ts`                        | `org-sso.test.ts`                                                                         | `org.sso.set`, `org.sso.delete`                                | `docs/adr/0002-saml-sso.md`                                |
| Access control              | `auth/rbac.ts`, `auth/guards.ts`                       | `rbac.test.ts` (route sweep), `pathrules.test.ts`, `orgs.test.ts`                         | `member.*`, `org.member.*`, `team.*`, `path_rule.*`            | `docs/architecture.md` section 3                           |
| Agent identities and policy | `auth/agents.ts`, `policy/`                            | `agent-identity.test.ts`, `policy.test.ts`, `guardrail-seams.test.ts`                     | `agent.*`, `policy.*`, `agents.pause`, `agents.resume`         | `docs/adr/0003-policy-engine.md`                           |
| Rulesets and reviews        | `policy/rulesets.ts`, `reviews/`                       | `rulesets.test.ts`, `codeowners.test.ts`, `review-threads.test.ts`, `merge-queue.test.ts` | `ruleset.*`, `pull.review`, `pull.merge`, `merge_queue.*`      |                                                            |
| Commit signatures           | `git/signatures.ts`                                    | `git-signatures.test.ts`                                                                  | `signing_key.add`, `signing_key.remove`                        |                                                            |
| Provenance                  | `releases/provenance.ts`, `provenance/`                | `provenance.test.ts`, `releases.test.ts`                                                  | `release.attest`                                               | `docs/provenance.md`                                       |
| Secret scanning             | `security/secrets/`                                    | `secret-scanning.test.ts`                                                                 | `secret_scanning.*`                                            |                                                            |
| Dependencies and SARIF      | `security/deps/`, `security/code-scanning.ts`          | `deps.test.ts`, `sarif.test.ts`                                                           | `dependency_alert.*`, `advisories.load`, `code_scanning.*`     |                                                            |
| CI secrets and OIDC         | `secrets/`, `ci/inject.ts`, `ci/mask.ts`, `ci/oidc.ts` | `secrets.test.ts`, `ci-oidc.test.ts`, `ci-pipeline-deploy.test.ts`                        | `secret.*`, `variable.*`, `environment.*`, `ci.oidc.token`     | `docs/ci-oidc-aws.md`                                      |
| CI isolation and limits     | `ci/runner.ts`, `ci/capacity.ts`                       | `ci-admission.test.ts`, `ci-runners.test.ts`                                              | `ci.run.*`, `ci.limits.update`, `runner.*`                     | `docs/github-cloudflare-research.md`                       |
| Audit log                   | `audit/record.ts`, `audit/stream.ts`                   | `audit.test.ts` (including "audit coverage")                                              | all                                                            | `docs/deploy.md` (streaming)                               |
| Rate limiting and caching   | `middleware/ratelimit.ts`, `middleware/cachetier.ts`   | `hardening.test.ts`                                                                       |                                                                |                                                            |
| Input handling              | zod schemas in `api/`, `git/pack-reader.ts`            | `test/fuzz/`, route tests                                                                 |                                                                | `docs/openapi.json`                                        |
| Outbound request guards     | `webhooks/deliver.ts`, `mirrors/remote.ts`             | `webhooks-out.test.ts`, `mirrors.test.ts`                                                 | `webhook.*`, `mirror.*`                                        | `docs/webhooks.md`                                         |
| Usage and budgets           | `usage/`                                               | `usage.test.ts`                                                                           | `usage.budget.*`                                               |                                                            |
| Backup and export           | `backup/backup.ts`, `api/export.ts`                    | `backup.test.ts`, `export.test.ts`                                                        | `backup.create`, `repo.export`                                 | `docs/operations/backup-dr.md`                             |
| Live deployment checks      |                                                        |                                                                                           |                                                                | `docs/deployment-smoke-2026-10-15.md`                      |
| Residency                   |                                                        |                                                                                           |                                                                | `docs/adr/0005-residency.md`, `docs/residency.md` (drafts) |

## Missing evidence

- Compliance evidence export API (`GET /api/v1/orgs/:org/compliance/evidence`):
  not built.
- Production backup runs and a restore drill record: none.
- Penetration test, SAST and DAST reports for the forge: none.
- Cloudflare IRAP report and controls matrix: not obtained (NDA).
- Policies: secure development, vulnerability disclosure, incident response,
  change approval: none written.
- Reviewer sign-off for this pack: pending.

## Decisions for Justin

- Whether test runs should be archived per release as evidence (for example
  CI logs kept for a set period), since today they live only in GitHub
  Actions history.
- Who keeps this index current, and how often it is checked.
