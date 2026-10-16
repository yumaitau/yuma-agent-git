# Shared responsibility (DRAFT)

> DRAFT readiness material for issue #69, not approved. **IRAP-experienced
> reviewer: pending.** No Australian data residency is claimed.

## Cloudflare's IRAP assessment

Cloudflare holds an IRAP assessment at PROTECTED. Its public page (read 17
October 2026) lists Workers, D1, R2, Durable Objects and Containers among the
assessed services. **Queues and Workers AI were not on that list**, and
Workers Logs was not named. The page's stated count (36 services) did not
match the length of its own list, so the report itself is the source of
truth. The report, the Cloud Security Controls Matrix and Cloudflare's system
security plan need an NDA and come through the account team or the dashboard.
We have **not** obtained them. ([Cloudflare IRAP](https://www.cloudflare.com/cloudflare-for-government/australia/irap/))

The "IRAP Protected" Data Localization region may use assessed data centres
outside Australia, and neither the "Australia" nor the "IRAP Protected" region
has a Customer Metadata Boundary
([region support](https://developers.cloudflare.com/data-localization/region-support/)).

## Responsibility matrix

Until Cloudflare's controls matrix is read, the Cloudflare column is our
understanding of a typical platform split, not a quote from its report.

| Area                                                                   | Cloudflare                                                  | Yuma (forge)                                                          | Customer (org)                                             |
| ---------------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------- |
| Physical data centres                                                  | Yes                                                         | No                                                                    | No                                                         |
| Platform (Workers runtime, D1, R2, DO, Queues, Containers, Workers AI) | Yes; Queues and Workers AI not shown in IRAP scope          | Chooses services and settings (ADR 0005)                              | No                                                         |
| Network edge, TLS, DDoS                                                | Yes                                                         | Custom domain, Regional Services, HSTS (not configured)               | No                                                         |
| Data location                                                          | Hints only for D1, R2, DO; no Australian jurisdiction       | Chooses hints, encryption of blobs, residency gating (not built)      | Chooses whether to put data in the forge                   |
| Encryption at rest                                                     | Platform encryption (per Cloudflare docs; not checked here) | Envelope encryption of CI secrets, TOTP seeds, backups; blobs not yet | No                                                         |
| Application security                                                   | No                                                          | Yes: auth, RBAC, path rules, rulesets, input validation, audit        | Configures rules and roles for its repos                   |
| Identity                                                               | No                                                          | Sign-in, MFA, SCIM, org SSO enforcement                               | Runs its IdP, its MFA policy and joiner and leaver process |
| Secrets in CI                                                          | No                                                          | Storage, injection rules, masking                                     | Which secrets to store, environment protection rules       |
| CI workloads                                                           | Container isolation                                         | Ephemeral VMs, deadlines, budgets                                     | What its jobs run and reach (no egress control)            |
| Self-hosted runners                                                    | No                                                          | Registration and job protocol                                         | The machines, their hardening and location                 |
| Logging and monitoring                                                 | Workers Logs platform (7 days)                              | Audit log, streaming, request logs                                    | Its SIEM and review of alerts                              |
| Backups                                                                | D1 Time Travel                                              | Scheduled encrypted backups (not running in production)               | Exports of its own repos if it wants a copy                |
| Vulnerability management                                               | Platform patching                                           | Forge code, dependencies, runner image (no programme yet)             | Its own code, via forge features                           |
| Incident response                                                      | Platform incidents                                          | Forge incidents (no plan document yet)                                | Its own incidents; tells Yuma of suspected forge issues    |

## Decisions for Justin

- Whether to request Cloudflare's IRAP report and controls matrix under NDA,
  so this matrix can quote it rather than infer.
- Whether to avoid Queues and Workers AI for any customer who needs services
  inside Cloudflare's IRAP scope, until Cloudflare confirms their status.
- Whether self-hosted runners in the customer's own Australian environment
  should be the recommended CI option for regulated customers.
