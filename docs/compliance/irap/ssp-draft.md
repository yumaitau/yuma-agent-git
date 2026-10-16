# System security plan (DRAFT)

> DRAFT readiness material, not a system security plan anyone has approved,
> and not ready for an assessor. Issue #69. **IRAP-experienced reviewer:
> pending.** No security classification is claimed for the system, and no
> Australian data residency is claimed (see
> [ADR 0005](../../adr/0005-residency.md), Proposed).

## 1. System identification

| Field                 | Value                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------- |
| System name           | yuma-agent-git (the forge)                                                                        |
| System owner          | Yuma IT (Justin Middler), to be confirmed                                                         |
| Purpose               | Source hosting, review, CI, package registry and agent runtime for Yuma and its clients           |
| Deployment            | One Cloudflare Workers deployment (`env.prod` in `worker/wrangler.jsonc`), on `workers.dev`       |
| Target classification | Not decided. Cloudflare's IRAP assessment is at PROTECTED; the forge itself has not been assessed |
| Status                | Pilot. No production customer data until ADR 0005 is Accepted                                     |
| Date of this draft    | 17 October 2026                                                                                   |

## 2. System description

The forge is a TypeScript Worker (Hono) on Cloudflare. It stores repository
history as content-addressed objects in R2 and metadata in D1, serialises ref
updates through Durable Objects, runs background work on Queues, runs CI jobs
in Cloudflare Containers (production only) and runs agents on Workers AI
(production only). It speaks Git smart HTTP, Git LFS, OCI and npm registry
protocols, a JSON API (`docs/api.md`, `docs/openapi.json`), MCP, and a GitHub
REST compatible API. Design: [docs/architecture.md](../../architecture.md).

Users: people (browser dashboard, `yag` CLI, Git), agents (API, MCP), CI
runners (Cloudflare containers and self-hosted runners), apps and webhooks.

## 3. System boundary

Inside the boundary (Yuma operates and is responsible):

- The Worker code in `worker/src` and the dashboard in `worker/dashboard`.
- Configuration in `worker/wrangler.jsonc` and Worker secrets.
- The Cloudflare resources bound to it: D1 `yag-db`, R2 `yag-objects`, six
  Durable Object classes, eight Queues, the CI container image and Workers AI
  use. The full list is in [docs/residency.md](../../residency.md).
- The `yag` CLI (`cli/`), SDK (`sdk/`) and runner image (`worker/runner/`).

Outside the boundary (connected, not operated by Yuma): Cloudflare's platform
(covered by its own IRAP assessment), GitHub, OIDC identity providers,
customers' webhook receivers, SIEM sinks and mail service, mirror remotes,
`api.osv.dev`, container registries and anything CI jobs reach. Data flows:
[data-flows.md](data-flows.md).

## 4. Roles

| Role                  | Who                         | Notes                                                               |
| --------------------- | --------------------------- | ------------------------------------------------------------------- |
| System owner          | To be confirmed             |                                                                     |
| Operator              | Yuma IT                     | Deploys, holds Worker secrets, sets instance admin lists            |
| Instance admins       | Users in `*_ADMIN_USER_IDS` | Audit, backups, CI capacity, secrets KEK, SCIM, security advisories |
| Org owners and admins | Customers                   | Members, teams, SSO, rulesets, secrets, environments, webhooks      |
| Developers and agents | Customers                   | Repository work within their roles and scopes                       |
| Cloud provider        | Cloudflare                  | Physical, platform and network security per its IRAP report         |
| IRAP assessor         | Not engaged                 | Booking an assessment is a business decision (out of scope for #69) |

## 5. Security controls summary

Control by control status lives in [ism-mapping.md](../ism-mapping.md) (ISM
software development guideline, June 2026 release: 21 met, 42 partial, 35 gap,
10 n/a). Shared responsibility with Cloudflare is in
[shared-responsibility.md](shared-responsibility.md). Evidence is indexed in
[evidence-index.md](evidence-index.md).

Main controls in place, in brief:

- Sign-in on every API route; OIDC, GitHub OAuth, passkeys, TOTP, SCIM and
  per-org SSO enforcement.
- Role-based access at org, team, repo and path level; agent identities with
  scopes, policies and guardrails.
- Rulesets: reviews, status checks, CODEOWNERS, signed commits, provenance,
  security alerts, merge queue, file restrictions.
- Push protection for secrets; dependency alerts from OSV; SARIF intake.
- Envelope-encrypted CI secrets (`SECRETS_KEK`), encrypted TOTP seeds,
  encrypted backups; short-lived CI OIDC tokens; log masking.
- Append-only, hash-chained audit log with SIEM streaming.

Main gaps, in brief (each is a row in the mapping):

- No residency controls (ADR 0005), blob content stored in plaintext.
- No production backups yet (#70).
- No vulnerability disclosure policy, `security.txt`, threat model, secure
  development policy, SBOM, malware scanning, SAST or DAST of the forge,
  single logout, or full set of security headers.
- System hardening guideline not yet mapped.

## 6. Data and classification

What the forge holds: source code and history, issues, reviews and comments,
CI logs and artifacts, packages, release assets, agent transcripts, user
profiles and emails, session and token hashes, encrypted secrets, audit
events and usage records. Where each lives:
[docs/residency.md](../../residency.md).

No classification has been agreed. If a customer needs OFFICIAL: Sensitive or
PROTECTED handling, that is a decision for Justin with the customer, after the
residency decision and an assessment.

## 7. Incident response and continuity

- Response levers: pause all agents, cancel CI runs, revoke tokens and
  sessions, disable an agent, turn off CI (`CI_ENABLED`).
- Continuity: [docs/operations/backup-dr.md](../../operations/backup-dr.md);
  RPO and RTO targets are set there but production backups are not running.
- No incident response plan document exists. Gap.

## 8. Change management

Changes go through pull requests on GitHub with CI (lint, typecheck, tests,
OpenAPI lint, a secret grep on `wrangler.jsonc`). Database changes are
numbered migrations that are never edited once applied. Deploys are run by
the operator (`docs/deploy.md`). Change approval is not recorded formally.
Gap.

## Decisions for Justin

- Who is the system owner, and who signs this plan.
- Whether to target a classification (for example PROTECTED) and when.
- Whether and when to engage an IRAP assessor (paid; out of scope for #69).
- Who reviews this pack with IRAP experience; record the name and date here.
- Whether to write an incident response plan and a change approval record as
  the next readiness steps.
