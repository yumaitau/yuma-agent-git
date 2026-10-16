# ISM software development control mapping (DRAFT)

> DRAFT, not approved, not for external use. Issue #69. This mapping has not
> been reviewed by anyone with IRAP experience. **IRAP-experienced reviewer:
> pending (name, date and outcome to be recorded here).** It makes no claim of
> Australian data residency; see [ADR 0005](../adr/0005-residency.md).

## Scope and source

- Source: ASD's Information Security Manual (ISM), [Guidelines for software
  development](https://www.cyber.gov.au/business-and-government/cyber-security-frameworks/ism/cybersecurity-guidelines/guidelines-for-software-development),
  **June 2026 release** (the PDF says "Last updated: June 2026"), read on 17
  October 2026. The control text below is our own short paraphrase; read the
  ASD page for the actual wording. ASD publishes the ISM under CC BY 4.0
  (© Commonwealth of Australia).
- Every control in that guideline is listed: 108 controls across software
  development fundamentals, AI application development, mobile application
  development and web application development.
- Not covered yet: the ISM system hardening guideline, which issue #69 also
  names. That is a gap in this draft.
- Code state: local `main` on 17 October 2026.

Two lenses apply, and each row says which:

- **Forge**: the forge is the customer's authoritative source for software, so
  the control is met by a feature a customer can turn on.
- **Yuma**: the control is about how Yuma builds and runs the forge itself.

Status rules:

- **met**: built, and there is a test, config or audit event to point at.
- **partial**: some of it is built; the gap is stated.
- **gap**: not built, or no evidence. Nothing unbuilt is marked met.
- **n/a**: does not apply, with the reason.

Owner: **Yuma** (forge code and Yuma's practice), **Cloudflare** (platform),
**Customer** (the org using the forge), or **Shared**.

Test paths are under `worker/test/`; code paths under `worker/src/`. Audit
events are `action` values in `worker/src/audit/record.ts`.

## Development environments

| Control  | What it asks (paraphrase)                                              | Status  | Owner  | Implementation and evidence                                                                                                                                                                                                                    |
| -------- | ---------------------------------------------------------------------- | ------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ISM-0400 | Keep development, test, staging and production environments separate   | partial | Shared | Forge: CI environments with required reviewers, wait timers and branch rules (`ci/environments.ts`, `ci-pipeline-deploy.test.ts`; events `environment.*`). Yuma: local `wrangler dev` versus `env.prod`; no separate staging deployment exists |
| ISM-1419 | Only develop and change software in development environments           | partial | Shared | Forge: protected branches and rulesets stop direct changes to production branches (`policy/rulesets.ts`, `rulesets.test.ts`). Yuma: no written rule; nothing stops a hot edit to production config                                             |
| ISM-1420 | Do not use production data outside production unless equally protected | gap     | Yuma   | No policy or control. Backups restore only into a fresh environment (`docs/operations/backup-dr.md`), but nothing stops copying production data elsewhere                                                                                      |

## Authoritative source for software

| Control  | What it asks (paraphrase)                                           | Status | Owner    | Implementation and evidence                                                                                                                                                                                                                                                                            |
| -------- | ------------------------------------------------------------------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ISM-2023 | Set up and maintain an authoritative source for software            | met    | Yuma     | Forge: the forge is that source (changesets in D1, objects in R2, Git smart HTTP in `git/`); `commit.test.ts`, `git-receive-pack.test.ts`, `git-upload-pack.test.ts`                                                                                                                                   |
| ISM-2024 | Use the authoritative source for all development work               | gap    | Customer | A customer practice. Yuma itself still develops this repo on GitHub, not on the forge                                                                                                                                                                                                                  |
| ISM-1422 | Stop unauthorised access to the authoritative source                | met    | Yuma     | Forge: every `/api` route needs sign-in (anonymous 401), unreadable repos return 404, roles from orgs and teams, path rules, org SSO enforcement, agent scopes (`auth/rbac.ts`; `rbac.test.ts` route sweep, `pathrules.test.ts`, `org-sso.test.ts`, `agent-identity.test.ts`)                          |
| ISM-1816 | Stop unauthorised changes to the authoritative source               | met    | Shared   | Forge: write role checks, deny-write path rules, ref compare-and-swap (`core/refdo.ts`), rulesets for non-fast-forward, deletion, reviews, CODEOWNERS and signatures (`rulesets.test.ts`, `codeowners.test.ts`, `pathrules.test.ts`); events `ref.move`, `ruleset.bypass`. Customer must turn rules on |
| ISM-2025 | Use issue tracking linked to security issues, changes and bug fixes | met    | Shared   | Forge: issues, labels, milestones and issue references from PRs and commits (`collab/issues.ts`, `collab/references.ts`, `issues.test.ts`); events `issue.*`. Customer chooses to use it                                                                                                               |

## Software artefacts and build

| Control  | What it asks (paraphrase)                                                   | Status  | Owner    | Implementation and evidence                                                                                                                                                                                                                                                           |
| -------- | --------------------------------------------------------------------------- | ------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ISM-2026 | Scan artefacts for malicious content before they enter the source           | gap     | Yuma     | No malware scanning of pushes, uploads, LFS objects, packages or release assets                                                                                                                                                                                                       |
| ISM-2027 | Check artefacts by signature or a hash from a secure channel before import  | partial | Shared   | Forge: content addressing by SHA-256 (`core/blobs.ts`), LFS and OCI digests checked on upload (`git/lfs.ts`, `registry/oci.ts`), commit signature verification and `required_signatures` (`git/signatures.ts`, `git-signatures.test.ts`). Imports from GitHub do not check signatures |
| ISM-2028 | Test artefacts for known weaknesses (SAST, DAST or SCA) before import       | partial | Shared   | Forge: SCA through lockfile parsing and OSV advisories (`security/deps/`, `deps.test.ts`); SARIF upload from any SAST tool (`security/code-scanning.ts`, `sarif.test.ts`); `security_alerts` ruleset blocks merges with new alerts. No built-in SAST or DAST runs                     |
| ISM-2102 | Periodically retest existing artefacts for known weaknesses                 | partial | Shared   | Forge: hourly OSV sync re-matches stored dependency graphs (`security/deps/osv.ts`); history secret scans (`security/secrets/history.ts`). SAST and DAST depend on the customer's CI                                                                                                  |
| ISM-2029 | Limit third-party libraries and components to trustworthy sources           | gap     | Shared   | No allowlist of package sources or Actions. The npm and OCI registries host packages; they do not proxy or filter upstream ones                                                                                                                                                       |
| ISM-2030 | Scan commits for secrets and keys and block them                            | met     | Yuma     | Forge: push protection on Git push and the commit API, admin bypass with reason (`security/secrets/scan.ts`, `secret-scanning.test.ts` "push protection" and "commit RPC"); events `secret_scanning.bypass`, `secret_scanning.alert.update`                                           |
| ISM-2031 | Use build tools that add security features to executables, and turn them on | gap     | Customer | Depends on the customer's toolchain. The forge does not check compiler or build flags                                                                                                                                                                                                 |
| ISM-2032 | Build only after all automated tests pass with no warnings or errors        | partial | Shared   | Forge: `required_status_checks` and current-head CI before merge (`rulesets.test.ts`, `ci-planner.test.ts`). Warnings are not treated as failures unless the customer's commands do so. Yuma: this repo's CI runs lint, typecheck and tests (`.github/workflows/ci.yml`)              |

## Secure development practice

| Control  | What it asks (paraphrase)                                                   | Status  | Owner | Implementation and evidence                                                                                                                                                                       |
| -------- | --------------------------------------------------------------------------- | ------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ISM-2120 | Have and keep a secure software development policy                          | gap     | Yuma  | No written policy. `CONTRIBUTING.md` sets code rules (strict TypeScript, zod at boundaries) but is not a security policy                                                                          |
| ISM-2033 | Document, protect and maintain software security requirements               | partial | Yuma  | Security requirements live in GitHub issues and `CONTRIBUTING.md`; not collected or kept as a requirement set                                                                                     |
| ISM-2034 | Document and review security design decisions through the life cycle        | partial | Yuma  | ADRs in `docs/adr/` (for example 0002 SAML, 0003 policy engine, 0005 residency); review is not recorded                                                                                           |
| ISM-2035 | Identify and document security roles, responsibilities and knowledge needed | gap     | Yuma  | Not documented                                                                                                                                                                                    |
| ISM-2036 | Identify and document developers' security responsibilities                 | gap     | Yuma  | Not documented                                                                                                                                                                                    |
| ISM-2121 | Do not use developers who lack the security skills a task needs             | gap     | Yuma  | No process. Note that AI agents write much of this code; the guideline counts them as developers                                                                                                  |
| ISM-2037 | Train developers who lack those skills                                      | gap     | Yuma  | No training record                                                                                                                                                                                |
| ISM-2038 | Keep a register of developers' security knowledge and skills                | gap     | Yuma  | No register                                                                                                                                                                                       |
| ISM-0401 | Follow Secure by Design through the life cycle                              | partial | Yuma  | Deny by default auth, append-only audit, envelope-encrypted secrets, credential masking (`docs/ci-oidc-aws.md`). Not assessed against ASD's Secure by Design guidance                             |
| ISM-1238 | Use threat modelling                                                        | gap     | Yuma  | No threat model document                                                                                                                                                                          |
| ISM-2039 | Review the threat model as the software and threats change                  | gap     | Yuma  | Depends on ISM-1238                                                                                                                                                                               |
| ISM-2040 | Use secure programming practices for the language                           | partial | Yuma  | TypeScript strict, zero `any`, zod at every boundary, ESLint in CI (`CONTRIBUTING.md`, `eslint.config.js`); no language-specific secure coding standard adopted                                   |
| ISM-2041 | Use memory-safe languages, or memory-safe practices                         | met     | Yuma  | Worker, CLI and SDK are TypeScript on V8; no native code in this repo                                                                                                                             |
| ISM-2042 | Follow Secure by Default, with security features on and at no extra cost    | partial | Yuma  | Sign-in required everywhere, CI gets no credentials unless opted in, push protection on. MFA for token creation is off by default (`REQUIRE_MFA_FOR_TOKENS`); rulesets must be turned on per repo |
| ISM-1780 | Use SecDevOps practices                                                     | partial | Yuma  | Hermetic tests, lint, typecheck, OpenAPI lint and a secret grep on every PR (`.github/workflows/ci.yml`); no SAST or SCA in this repo's own CI                                                    |
| ISM-2043 | Structure software for readability and maintainability                      | partial | Yuma  | Module layout in `docs/architecture.md`; not measured                                                                                                                                             |

## Software features

| Control  | What it asks (paraphrase)                                                    | Status  | Owner  | Implementation and evidence                                                                                                                                                                                                 |
| -------- | ---------------------------------------------------------------------------- | ------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ISM-1796 | Sign files with executable content using a trusted certificate chain         | gap     | Yuma   | The `yag` CLI and runner image are not code signed                                                                                                                                                                          |
| ISM-1797 | Sign installers, patches and updates, or give checksums                      | partial | Shared | Forge: release assets carry signed provenance attestations (`releases/provenance.ts`, `provenance.test.ts`; event `release.attest`). Yuma: its own CLI and Worker builds are not signed or checksummed                      |
| ISM-2044 | No default credentials; any needed are set at install                        | met     | Yuma   | No built-in accounts; first users sign in through GitHub or OIDC; admin lists come from Worker vars set by the operator (`docs/deploy.md`)                                                                                  |
| ISM-2045 | Backwards compatibility must not weaken security                             | partial | Yuma   | The GitHub REST compatibility layer (`compat/github/`) goes through the same auth; not separately reviewed                                                                                                                  |
| ISM-2046 | If users can be impersonated, do not log sensitive data and set permissions  | n/a     | Yuma   | No user impersonation feature. Agents and app tokens act on behalf of a user with their own principal and audit actor (`auth/principal.ts`)                                                                                 |
| ISM-2047 | Tell the user through another channel when an authentication factor is reset | gap     | Yuma   | Passkey and TOTP changes are audited (`mfa.passkey.*`, `mfa.totp.*`) but the user is not notified                                                                                                                           |
| ISM-2048 | Stop non-admin users changing their own permissions                          | met     | Yuma   | Role and team changes need admin or owner (`rbac.test.ts` "admin CRUD", `orgs.test.ts`); agents are never admins                                                                                                            |
| ISM-2049 | Force re-authentication when permissions or credentials change               | partial | Yuma   | Roles are read from D1 on every request, so changes apply at once; SCIM deprovision revokes all sessions and tokens (`scim.test.ts`). No forced re-login on a role change                                                   |
| ISM-2050 | Validate signatures against a trust chain and check revocation (CRL or OCSP) | partial | Yuma   | x509 (gitsign) signatures chain to `SIGSTORE_TRUST_ROOTS` (`git/signatures.ts`, `git-signatures.test.ts`); no CRL or OCSP check                                                                                             |
| ISM-2051 | Produce enough event logs to detect security events                          | met     | Yuma   | Hash-chained audit log per org, search, export and SIEM streaming (`audit/record.ts`, `audit/stream.ts`, `audit.test.ts` "audit coverage"); `yag audit verify`                                                              |
| ISM-2052 | Protect sensitive data in event logs                                         | partial | Yuma   | Audit targets never hold secret values; CI logs mask injected values (`ci/mask.ts`); request logs carry an input digest, not content (`middleware/observe.ts`). Workers Logs output from 93 `console` calls is not reviewed |
| ISM-1798 | Publish a hardening or loosening guide                                       | partial | Yuma   | `docs/deploy.md` covers secure settings (MFA for tokens, org SSO, CI credentials); no single hardening guide                                                                                                                |
| ISM-2053 | Publish end-of-life procedures, including account and data removal           | partial | Yuma   | Repository export (`docs/operations/backup-dr.md`, `export.test.ts`), SCIM deprovisioning; no documented end-of-life or data destruction procedure                                                                          |

## Bills of materials and provenance

| Control  | What it asks (paraphrase)                                         | Status  | Owner  | Implementation and evidence                                                                                                                                                       |
| -------- | ----------------------------------------------------------------- | ------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ISM-2054 | Use imported components' SBOMs to check for known vulnerabilities | partial | Shared | Forge: dependency graph from lockfiles matched to OSV (`security/deps/graph.ts`, `deps.test.ts`); SBOM files themselves are not read                                              |
| ISM-1730 | Produce and publish an SBOM                                       | gap     | Yuma   | No SBOM export for repos and none published for the forge                                                                                                                         |
| ISM-2082 | Use imported components' cryptographic bills of materials         | gap     | Yuma   | Not built                                                                                                                                                                         |
| ISM-2083 | Produce and publish a cryptographic bill of materials             | gap     | Yuma   | Not built                                                                                                                                                                         |
| ISM-2055 | Use imported components' build provenance                         | partial | Shared | Forge: `required_provenance` ruleset checks provenance this forge issued (`provenance.test.ts`); provenance shipped with third-party components is not checked                    |
| ISM-2056 | Produce and publish build provenance                              | partial | Shared | Forge: in-toto and SLSA provenance for releases and agent sessions (`releases/provenance.ts`, `provenance/issue.ts`, `docs/provenance.md`). Yuma: not produced for its own builds |

## Network APIs

| Control  | What it asks (paraphrase)                                                            | Status  | Owner  | Implementation and evidence                                                                                                                                                                            |
| -------- | ------------------------------------------------------------------------------------ | ------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ISM-1818 | Authenticate and authorise clients of internet-facing APIs that change data          | met     | Yuma   | Session or bearer token on every `/api` route, RBAC per route, agent scopes (`rbac.test.ts` route sweep, `agent-identity.test.ts`, `auth.test.ts`)                                                     |
| ISM-2013 | The same for APIs that change data and are not internet-facing                       | n/a     | Yuma   | The forge has no internal-only API; Durable Object stubs are reached only from the Worker                                                                                                              |
| ISM-1817 | Authenticate and authorise clients of internet-facing APIs that read non-public data | met     | Yuma   | As ISM-1818; unreadable repos return 404 (`rbac.test.ts`, `pathrules.test.ts`)                                                                                                                         |
| ISM-2014 | The same for non-internet-facing APIs that read non-public data                      | n/a     | Yuma   | As ISM-2013                                                                                                                                                                                            |
| ISM-1910 | Log internet-facing API calls that change or read non-public data centrally          | partial | Shared | One structured log line per request (`middleware/observe.ts`) to Workers Logs (7 days, Cloudflare); security actions in the audit log and SIEM stream. Request logs are not shipped to a central store |
| ISM-2015 | The same for non-internet-facing API calls                                           | n/a     | Yuma   | As ISM-2013                                                                                                                                                                                            |

## Input handling and databases

| Control  | What it asks (paraphrase)                                                             | Status  | Owner | Implementation and evidence                                                                                                                                                    |
| -------- | ------------------------------------------------------------------------------------- | ------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ISM-1240 | Validate and sanitise all input from the internet                                     | partial | Yuma  | zod schemas on bodies and queries (`api/contract.ts`, route files), capped Git pack parsing with fuzz tests (`test/fuzz/git-wire.test.ts`); not audited route by route         |
| ISM-2016 | Validate and sanitise all input from a local network                                  | n/a     | Yuma  | No local network inputs; all input arrives over the internet                                                                                                                   |
| ISM-2057 | Document input validation rules, implement them and test both valid and invalid input | partial | Yuma  | Rules are the zod schemas and OpenAPI (`docs/openapi.json`); many tests cover invalid input; not documented as a rule set                                                      |
| ISM-2058 | Validate data before deserialising it                                                 | partial | Yuma  | JSON is parsed then validated with zod; D1 rows and queue messages are parsed with zod (`CONTRIBUTING.md`); not checked for every queue consumer                               |
| ISM-2059 | Limit uploads to set file types and scan them before access, execution or storage     | gap     | Yuma  | Size limits and `file_extension_restriction` rulesets exist (`policy/rulesets.ts`); no malware scanning                                                                        |
| ISM-1275 | Filter database queries for legitimate content and correct syntax                     | partial | Yuma  | D1 access goes through bound parameters (`db/client.ts` `q`, `q1`, `run`); not audited query by query                                                                          |
| ISM-1276 | Use parameterised queries, not dynamically built ones                                 | partial | Yuma  | Values are always bound; a few queries build column names or placeholder lists from fixed values (for example `usage/record.ts` `budgetUsed`). Not audited across the codebase |
| ISM-1278 | Give away as little database structure as possible in errors                          | met     | Yuma  | Unknown errors return `internal_error` with no detail (`api/errors.ts`)                                                                                                        |
| ISM-1536 | Log user-initiated database queries and their errors centrally                        | gap     | Yuma  | Query errors reach Workers Logs only; queries are not logged centrally                                                                                                         |

## Testing, review and vulnerabilities

| Control  | What it asks (paraphrase)                                                          | Status  | Owner  | Implementation and evidence                                                                                                                                                                  |
| -------- | ---------------------------------------------------------------------------------- | ------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ISM-2061 | Peer review all critical and security-related components                           | partial | Shared | Forge: required reviews, CODEOWNERS and agent review loops (`codeowners.test.ts`, `review-threads.test.ts`, `agent-review.test.ts`). Yuma: review of this repo's own changes is not recorded |
| ISM-2060 | Use code review to check Secure by Design and secure programming                   | partial | Shared | As ISM-2061; no security checklist for reviewers                                                                                                                                             |
| ISM-2062 | Unit and integration test, with positive and negative cases                        | met     | Yuma   | Vitest in miniflare across `worker/test/` (88 test files), CLI smoke with real Git, fuzz tests; run in CI                                                                                    |
| ISM-0402 | Test for vulnerabilities with SAST, DAST and SCA before each release and regularly | gap     | Yuma   | No SAST, DAST or SCA runs against this repo; no penetration test recorded                                                                                                                    |
| ISM-2122 | Use suitable AI models to help security testing                                    | partial | Yuma   | Agent review loops can review PRs (`reviews/`); not used as a security testing step                                                                                                          |
| ISM-1616 | Run a vulnerability disclosure program                                             | gap     | Yuma   | None                                                                                                                                                                                         |
| ISM-1755 | Have a vulnerability disclosure policy                                             | gap     | Yuma   | No `SECURITY.md` or policy                                                                                                                                                                   |
| ISM-1756 | Have vulnerability disclosure processes and procedures                             | gap     | Yuma   | None                                                                                                                                                                                         |
| ISM-1717 | Host `security.txt` on each internet-facing website domain                         | gap     | Yuma   | Not served                                                                                                                                                                                   |
| ISM-1908 | Disclose vulnerabilities responsibly and on time, with CWE and CPE                 | gap     | Yuma   | No process                                                                                                                                                                                   |
| ISM-1754 | Fix vulnerabilities on time                                                        | gap     | Yuma   | No target times set                                                                                                                                                                          |
| ISM-1909 | Do root cause analysis and fix whole classes of vulnerability                      | gap     | Yuma   | No process                                                                                                                                                                                   |
| ISM-1911 | Log security-relevant use, errors and crashes centrally                            | partial | Shared | Audit log and SIEM stream for security actions; errors and crashes only in Workers Logs (7 days)                                                                                             |

## AI application development

The forge runs agents on Workers AI (`agents/llm.ts`) and serves an MCP
endpoint, so these apply.

| Control  | What it asks (paraphrase)                                          | Status  | Owner      | Implementation and evidence                                                                                                                  |
| -------- | ------------------------------------------------------------------ | ------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| ISM-2084 | Document AI models and systems with model and system cards         | gap     | Yuma       | Not written; the default model is named in `docs/architecture.md` only                                                                       |
| ISM-2072 | Store AI models in a format that cannot run code                   | n/a     | Cloudflare | The forge stores no models; Workers AI hosts them                                                                                            |
| ISM-2085 | Do not expose exact model confidence scores                        | met     | Yuma       | The model gateway returns text and tool calls only (`agents/llm.ts`); no scores are requested or shown                                       |
| ISM-2103 | Do not train on organisational data without informed consent       | gap     | Shared     | The forge does not train models. Workers AI's terms on customer data have not been checked into this repo                                    |
| ISM-2123 | Securely delete prompts and outputs when a chat session is removed | gap     | Yuma       | Transcripts are kept in the agent Durable Object and R2 (`repos/<repo>/agents/<task>/transcript.jsonl`); no deletion path found              |
| ISM-2086 | Verify the source and integrity of models and weights              | n/a     | Cloudflare | Models are Cloudflare-hosted; covered by Cloudflare, if at all                                                                               |
| ISM-2087 | Verify the source and integrity of training data                   | n/a     | Yuma       | The forge does not train models                                                                                                              |
| ISM-2088 | Validate training data for reliability and accuracy                | n/a     | Yuma       | As ISM-2087                                                                                                                                  |
| ISM-2089 | Monitor model performance and investigate anomalies                | partial | Yuma       | Superfan monitors and AI phase timings (`agents/superfan.ts`, `observability/metrics.ts` `recordAi`); quality is not tracked                 |
| ISM-2090 | Rate limit inference queries                                       | partial | Yuma       | API rate limits (`middleware/ratelimit.ts`, `hardening.test.ts`) and per-task step budgets (`agents/budget.ts`); no inference-specific limit |
| ISM-2091 | Enforce resource limits on models                                  | met     | Yuma       | Task budgets and org or agent token budgets that stop work (`agents/budget.ts`, `usage/record.ts` `budgetStop`, `usage.test.ts`)             |
| ISM-2092 | Fine-grained access control for AI applications                    | met     | Yuma       | Agent identities with scopes, agent policies and guardrails (`auth/agents.ts`, `policy/`, `policy.test.ts`, `guardrail-seams.test.ts`)       |
| ISM-2093 | Role-based access to sensitive data for AI applications            | met     | Yuma       | Agent tools run under the same RBAC and path rules as people (`agents/tools.ts`, `agent-tools.test.ts`, `mcp.test.ts`)                       |
| ISM-1924 | Check prompts for adversarial input                                | gap     | Yuma       | No prompt injection detection                                                                                                                |
| ISM-2094 | Filter AI output for sensitive data and improper output            | partial | Yuma       | Secrets are redacted from transcripts (`secret-scanning.test.ts` "transcript redaction"); no other output filter                             |

## Mobile application development

| Control  | What it asks (paraphrase)                                       | Status | Owner | Implementation and evidence |
| -------- | --------------------------------------------------------------- | ------ | ----- | --------------------------- |
| ISM-1922 | Use the OWASP Mobile Application Security Verification Standard | n/a    | Yuma  | The forge has no mobile app |

## Web application development

| Control  | What it asks (paraphrase)                                               | Status  | Owner      | Implementation and evidence                                                                                                                                                                        |
| -------- | ----------------------------------------------------------------------- | ------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ISM-1239 | Use robust web application frameworks                                   | met     | Yuma       | Hono on Workers, React dashboard (`worker/package.json`)                                                                                                                                           |
| ISM-0971 | Use the OWASP Application Security Verification Standard                | gap     | Yuma       | Not assessed against ASVS                                                                                                                                                                          |
| ISM-1849 | Use the OWASP Top 10 Proactive Controls                                 | gap     | Yuma       | Not assessed                                                                                                                                                                                       |
| ISM-1850 | Mitigate the OWASP Top 10                                               | partial | Yuma       | Access control, injection and SSRF defences exist (RBAC, bound queries, private address refusal in `webhooks/deliver.ts`); no assessment against the list                                          |
| ISM-2063 | Set HttpOnly, Secure and SameSite on session cookies                    | met     | Yuma       | `auth/session.ts` (Secure on https origins, `SameSite=Lax`); `auth.test.ts`                                                                                                                        |
| ISM-2064 | Session cookies hold only signed opaque bearer tokens                   | partial | Yuma       | Tokens are opaque random values checked against a stored hash, not signed (see ISM-2065)                                                                                                           |
| ISM-2065 | Unsigned opaque tokens use random ids with at least 128 bits of entropy | met     | Yuma       | 32 random bytes (256 bits); D1 stores only the SHA-256 (`auth/session.ts`)                                                                                                                         |
| ISM-2066 | Manage sessions centrally on the server                                 | met     | Yuma       | Sessions in D1 with expiry, revocation on logout and deprovision (`auth/session.ts`, `scim.test.ts`)                                                                                               |
| ISM-2067 | Support single logout wherever single sign-on is supported              | gap     | Yuma       | Local logout only; no OIDC RP-initiated or back-channel logout                                                                                                                                     |
| ISM-1424 | Send Content-Security-Policy, HSTS and X-Frame-Options headers          | partial | Shared     | Set on the MCP consent page, unsubscribe page and release downloads (`mcp/oauth.ts`, `api/notifications.ts`, `api/releases.ts`); not on the dashboard or API generally; HSTS not set by the Worker |
| ISM-1552 | Serve all content only over HTTPS                                       | partial | Cloudflare | Cloudflare serves HTTPS on `workers.dev`; "Always Use HTTPS" and HSTS for a custom domain are not configured in this repo                                                                          |
| ISM-1851 | Mitigate the OWASP API Security Top 10                                  | partial | Yuma       | Object-level auth on every route (`rbac.test.ts` sweep), rate limiting, size caps; no assessment against the list                                                                                  |
| ISM-1241 | Encode all web output                                                   | partial | Yuma       | React escapes by default; Markdown rendering is sanitised (`markdown.test.ts`); server-rendered HTML pages not reviewed                                                                            |

## Totals

| Status  | Count |
| ------- | ----- |
| met     | 21    |
| partial | 42    |
| gap     | 35    |
| n/a     | 10    |
| Total   | 108   |

## Gaps with existing tickets

Gaps that already have a ticket: residency (#68), evidence export API (#69),
production backups (#70). No other gap has a ticket yet; this draft does not
open any (the ticket said the reviewer would walk them).

## Decisions for Justin

- Who reviews this pack with IRAP experience, and when. The reviewer field
  above stays "pending" until then.
- Whether to raise one ticket per gap, or group them (vulnerability disclosure,
  threat model and policy; SBOM and CBOM; malware scanning; single logout;
  security headers).
- Whether Yuma should move this repo's own development onto the forge
  (ISM-2024) and when.
- Whether to add the ISM system hardening guideline to this mapping now or in
  a later pass.
- Which statuses you accept as "met" for an external audience; this draft is
  strict, and an assessor may still downgrade some.
- Whether to commission SAST, DAST and a penetration test of the forge
  (ISM-0402).
