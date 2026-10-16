# How the forge supports ASD Essentials and the Essential Eight (DRAFT)

> DRAFT, not approved, not for external use. Issue #69. Not reviewed by anyone
> with IRAP experience (**reviewer: pending**). This page says what evidence
> the forge can give a customer; it does not rate anyone's effectiveness and it
> makes no Australian data residency claim.

## Sources

Read on 17 October 2026 and paraphrased, not copied:

- [ASD Essentials hub](https://www.cyber.gov.au/essentials), published 15
  October 2026.
- [ASD Essentials for enterprise IT](https://www.cyber.gov.au/publication/essentials-for-enterprise-it):
  eight domains. Six are technical (Boundary services, Identity services,
  Critical processes and services, Privileged environments, Business systems,
  User devices) and two are capability domains that run across all of them
  (Governance and culture, Visibility and response). Technical domains are
  sequenced in priority phases: phase 1 is Boundary services and Identity
  services; phase 2 is Critical processes and services and Privileged
  environments; phase 3 is Business systems and User devices. Non-production
  environments, including development, are in scope, and any that can change
  production should be protected like production.
- [Transitioning from the Essential Eight](https://www.cyber.gov.au/publication/transitioning-from-the-essential-eight):
  each Essential Eight strategy maps to at least one Essentials principle;
  earlier maturity ratings do not carry over to the new four-level
  effectiveness ratings (not assessed, not effective, partially effective,
  fully effective); existing evidence is a starting point for a gap analysis.
  Assessors look at coverage, consistency, currency and evidence quality.
- [ASD Essentials for cloud](https://www.cyber.gov.au/publication/essentials-for-cloud):
  linked for completeness; not yet read in detail for this draft.

Action codes below (for example PRO-13) are the enterprise IT chapter's
labels, used only as references.

## Where a forge sits in a customer's environment

A source forge with CI and agents is usually part of **Privileged
environments** (it can change what runs in production) and relies on
**Identity services** (the customer's IdP). Its internet-facing front door
also makes it a **Boundary services** asset. Customers decide the domain
assignment; this page assumes those three.

## Evidence the forge can provide, by domain

Status: **built** (in code with tests), **partial**, or **not built**. API
paths are under `/api/v1`.

### Identity services (phase 1)

| Essentials action                                 | Forge feature                                                                                                  | Evidence a customer can pull                                                                               | Status                           |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------- |
| PRO-13 Identity, credential and access management | OIDC sign-in with the customer's IdP (Google, Entra, any issuer), SCIM users and groups, org SSO enforcement   | `org.sso.set`, `scim.user.*`, `scim.group.*`, `auth.login` audit events; `org-sso.test.ts`, `scim.test.ts` | built                            |
| PRO-13 (phishing-resistant MFA)                   | Passkeys (WebAuthn) and TOTP as a second factor; `REQUIRE_MFA_FOR_TOKENS` makes token creation need recent MFA | `mfa.passkey.add`, `mfa.totp.enroll`, `auth.mfa` events; `mfa.test.ts`                                     | built                            |
| PRO-13 (MFA coverage report)                      | Per-org count of members with a phishing-resistant factor                                                      | None today                                                                                                 | not built (evidence export, #69) |
| PRO-12 Least privilege access                     | Org, team and repo roles; path rules; agent identities with scopes and policies                                | `member.set`, `team.repo.set`, `path_rule.*`, `agent.create`, `policy.update` events; `rbac.test.ts`       | built                            |
| Credential lifecycle                              | SCIM deprovision revokes sessions and tokens; agent token revoke                                               | `scim.user.deprovision`, `token.revoke`, `agent.token.revoke` events                                       | built                            |
| Single logout from the IdP                        | Not supported                                                                                                  | None                                                                                                       | not built                        |

### Privileged environments (phase 2)

| Essentials action                                             | Forge feature                                                                                                                                | Evidence                                                                                                        | Status                                                                          |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| PRO-05 Secure administration                                  | Admin-only routes, instance admin lists set by the operator (`*_ADMIN_USER_IDS`), agents never admins                                        | `rbac.test.ts` route sweep; `ruleset.bypass`, `secret.kek.rewrap` events                                        | built                                                                           |
| PRO-12 Least privilege for deploy credentials                 | CI secrets and OIDC only for opted-in jobs; protected environments with required reviewers, wait timers, branch rules and a people-only flag | `environment.approval.*`, `ci.oidc.token`, `secret.set` events; `ci-oidc.test.ts`, `ci-pipeline-deploy.test.ts` | built                                                                           |
| PRO-04 Secure configuration management                        | Rulesets (reviews, status checks, signatures, provenance, security alerts, merge queue), CODEOWNERS                                          | `ruleset.*` events; `rulesets.test.ts`, `codeowners.test.ts`                                                    | built                                                                           |
| PRO-07 Trustworthy software (application control for runners) | Ephemeral Cloudflare container per job; self-hosted runners register with tokens and labels                                                  | `runner.register`, `runner.update`, `ci.run.create` events; `ci-runners.test.ts`                                | partial: no allowlist of what a job may run; the CI VM has open internet access |
| PRO-16 Cyber supply chain security                            | Commit signature checks, signed provenance for releases, dependency alerts from OSV, SARIF intake                                            | `signing_key.add`, `release.attest`, `dependency_alert.update`, `code_scanning.upload` events                   | partial: no SBOM, no malware scanning                                           |
| PRO-10 Regular and proven backups                             | Encrypted scheduled backups and a tested restore                                                                                             | `backup.create` event; `backup.test.ts`                                                                         | partial: no production backup bucket, no real restore drill (#70)               |

### Boundary services (phase 1)

| Essentials action                  | Forge feature                                                                                                                                            | Evidence                                                       | Status                               |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------ |
| Internet-facing service protection | Sign-in required on every API route; sharded rate limits; SSRF guards on webhooks and mirrors (HTTPS only, private addresses refused, redirects refused) | `hardening.test.ts`, `webhooks-out.test.ts`, `mirrors.test.ts` | built                                |
| PRO-18 Network segmentation        | CI jobs run in separate VMs; publishing uses a second fresh VM                                                                                           | `docs/github-cloudflare-research.md`                           | partial: no egress control from jobs |
| Edge location                      | Regional Services for Australia needs a custom domain (ADR 0005)                                                                                         | None                                                           | not built                            |

### Visibility and response (capability domain)

| Essentials action                             | Forge feature                                                                                                                       | Evidence                                                                         | Status                               |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------ |
| DET-01 Centralised event logging              | Hash-chained audit log per org, search and NDJSON export, signed streaming to a SIEM (`AUDIT_STREAM_URL`)                           | `GET /orgs/:org/audit`, `GET /audit/stream`; `yag audit verify`; `audit.test.ts` | built                                |
| DET-02 and DET-04 Detection of risky activity | Webhooks for security events (secret scanning, dependency and code scanning alerts, environment and agent approvals, usage budgets) | `docs/webhooks.md`; `webhooks-out.test.ts`                                       | partial: no built-in detection rules |
| RES-03 Incident response                      | Pause every agent on the instance; cancel CI runs; revoke tokens                                                                    | `agents.pause`, `ci.run.cancel`, `token.revoke` events                           | built                                |

### Governance and culture (capability domain)

| Essentials action                        | Forge feature                                                                               | Evidence                                                                       | Status                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------- |
| GOV-08 Executive AI accountability       | Agent identities, policies, human approvals by risk, agent review escalation, usage budgets | `policy.approval.*`, `pull.agent_review.escalate`, `usage.budget.alert` events | partial: reports for executives are not built |
| GOV-11 Supplier cyber security assurance | This pack (ISM mapping, shared responsibility with Cloudflare)                              | `docs/compliance/`                                                             | partial: draft, not reviewed                  |
| IDE-01 Asset identification              | Lists of repos, members, agents, runners, apps and webhooks per org through the API         | OpenAPI (`docs/openapi.json`)                                                  | partial: no single asset export               |

## Essential Eight strategies the forge touches

| Strategy                                                           | How the forge helps                                                                                | Status                            |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | --------------------------------- |
| Multi-factor authentication                                        | Passkeys and TOTP; IdP MFA through OIDC; recent MFA for token creation when enabled                | built (coverage report not built) |
| Restrict administrative privileges                                 | Org and repo roles, admin-only routes, instance admin lists, agents never admins, audited bypasses | built                             |
| Application control                                                | Only for CI runners, and only as isolation (ephemeral VMs, runner labels); no allowlisting         | partial                           |
| Patch applications                                                 | Dependency alerts from OSV feed work items                                                         | partial                           |
| Regular backups                                                    | Built and tested locally; not running in production                                                | partial                           |
| Patch operating systems, Office macros, user application hardening | Not relevant to a forge                                                                            | n/a                               |

## Evidence export for GRiCk and Wedgetail

Issue #69 asks for `GET /api/v1/orgs/:org/compliance/evidence` returning audit
stats, MFA coverage, ruleset coverage, signed commit rates and scanning
coverage. **It is not built.** Until it is, the evidence above comes from the
audit export, the usage API and the listed endpoints, and has to be assembled
by hand. The GRiCk and Wedgetail input formats have not been checked.

## Decisions for Justin

- Whether to build the evidence export now, and which fields GRiCk and
  Wedgetail need (format, auth, how often they pull).
- Whether the forge is pitched to customers as part of their Privileged
  environments domain, as assumed here.
- Whether to make `REQUIRE_MFA_FOR_TOKENS` on by default for new deployments.
- Whether to add an allowlist for what CI jobs may run, so "application
  control for runners" can move past partial.
- Who reviews this page with IRAP experience before it goes to any customer.
