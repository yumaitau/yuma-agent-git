# Data flows (DRAFT)

> DRAFT readiness material for issue #69, not approved. **IRAP-experienced
> reviewer: pending.** Locations are as described in
> [docs/residency.md](../../residency.md); nothing here claims data stays in
> Australia.

The overall picture of every store and log sink is in
[ADR 0005](../../adr/0005-residency.md#data-flow). The flows below show the
main paths one at a time, with the trust boundary each crosses. Code paths are
under `worker/src/`.

## 1. Sign-in

```mermaid
sequenceDiagram
  participant U as Person (browser)
  participant W as Worker
  participant IdP as OIDC provider or GitHub
  participant D1 as D1
  U->>W: GET /auth/oidc/:provider
  W->>U: redirect with PKCE, nonce, state cookie
  U->>IdP: sign in (IdP's own MFA)
  IdP->>U: redirect with code
  U->>W: callback with code
  W->>IdP: token exchange, JWKS fetch
  W->>D1: create session (SHA-256 of a 256-bit token), audit auth.login
  W->>U: HttpOnly session cookie
  U->>W: passkey or TOTP step-up (auth.mfa)
```

Code: `auth/oidc.ts`, `auth/oauth.ts`, `auth/session.ts`, `auth/webauthn.ts`,
`auth/totp.ts`. Crosses: internet to Cloudflare edge; Worker to IdP.

## 2. Git push and commit

```mermaid
sequenceDiagram
  participant C as Git client or agent
  participant W as Worker
  participant R2 as R2 OBJECTS
  participant D1 as D1
  participant DO as REF_LOCK DO
  participant Q as Queues
  C->>W: git-receive-pack or POST changesets (token or session)
  W->>W: RBAC, path rules, org SSO, agent scopes, guardrails
  W->>W: secret scan (push protection), signature checks
  W->>R2: write blobs and trees (content addressed)
  W->>D1: insert changeset, Git id mapping
  W->>DO: compare-and-swap ref (rulesets checked)
  DO->>D1: ref head, audit ref.move
  W->>Q: derived-data, forge-events, notifications
```

Code: `git/receive-pack.ts`, `core/commit.ts`, `core/refdo.ts`,
`security/secrets/scan.ts`, `policy/rulesets.ts`.

## 3. CI job

```mermaid
sequenceDiagram
  participant W as Worker
  participant Q as ci-runs queue
  participant DO as CiRunnerDO
  participant VM as Container VM
  participant R2 as R2 OBJECTS
  participant Net as Internet
  W->>Q: run admitted (budget and org capacity in D1)
  Q->>DO: claim once, set deadline alarm
  DO->>VM: start fresh VM, stream source in
  DO->>VM: inject secrets and OIDC token only if opted in and allowed
  VM->>Net: package installs, cloud APIs (no egress control)
  VM->>DO: output (masked)
  DO->>R2: ci/logs, artifacts, caches
  DO->>VM: destroy
```

Code: `ci/runs.ts`, `ci/runner.ts`, `ci/inject.ts`, `ci/mask.ts`. Self-hosted
runners pull jobs over HTTPS instead and run on customer machines
(`ci/runners.ts`, `docs/runner-protocol.md`).

## 4. Agent task

```mermaid
sequenceDiagram
  participant P as Person or app
  participant W as Worker
  participant Q as agent-jobs queue
  participant A as YagAgent DO
  participant AI as Workers AI
  participant R2 as R2 OBJECTS
  P->>W: POST agents/tasks
  W->>Q: task id
  Q->>A: wake
  loop think, act, observe
    A->>AI: prompt with repository content
    A->>W: tools under the agent's RBAC and scopes
  end
  A->>R2: transcript (secrets redacted)
  A->>W: usage event (tokens), budget check
```

Code: `agents/runtime.ts`, `agents/llm.ts`, `agents/tools.ts`,
`usage/record.ts`.

## 5. Outbound integrations

| Flow                  | From                             | To                        | Payload                      | Guard                                            |
| --------------------- | -------------------------------- | ------------------------- | ---------------------------- | ------------------------------------------------ |
| Webhooks              | `webhooks/deliver.ts`            | Customer URL              | Domain events                | HTTPS, private addresses refused, HMAC signature |
| Audit stream          | `audit/stream.ts`                | `AUDIT_STREAM_URL`        | Audit events                 | HTTPS, HMAC signature                            |
| Email                 | `notify/email.ts`                | PaperBoy or Email Routing | Notification text            | Signed unsubscribe links                         |
| Mirrors               | `mirrors/remote.ts`              | Any Git host              | Repository content in or out | Private addresses and redirects refused          |
| GitHub import, export | `bridge/`, `git/fetch-client.ts` | GitHub                    | Repository content in or out | Admin started, App permissions                   |
| Advisories            | `security/deps/osv.ts`           | `api.osv.dev`             | Package names and versions   | `OSV_SYNC=off` stops it                          |

## Decisions for Justin

- Whether these diagrams are enough for an assessor, or whether a formal data
  flow diagram per classification level is needed.
- Whether outbound integrations should be listed per org in the product, so a
  customer can see where its data goes.
