# Tenancy, metering and pricing (DRAFT)

> DRAFT for Justin to decide, issue #79. Nothing here is approved. No plans,
> limits, billing or metering code has been built for it, and the `LICENSE`
> file is unchanged. Prices are in USD unless marked, and each one carries the
> date it was read. Check them again before quoting them to anyone.

## Where things stand

- The forge is one Cloudflare deployment for Yuma (the pilot), with many orgs
  in one D1 database. Orgs, teams, agent identities and per-org CI capacity
  exist (`worker/src/api/orgs.ts`, `worker/src/auth/agents.ts`,
  `worker/src/ci/capacity.ts`).
- Usage accounting from #61 exists: append-only `usage_events` with a
  `usage_daily` rollup kept by a trigger (`worker/migrations/0042_agent_review_cost.sql`,
  `worker/src/usage/record.ts`). It records three kinds: `tokens` (Workers AI
  calls, and tokens agents report for other models), `ci_seconds` (per run, by
  instance type; self-hosted runners at $0) and `storage` (bytes per repo per
  day, from the cron). Each event is priced from a versioned table
  (`worker/src/usage/prices.ts`) and budgets can alert or stop an agent.
- `GET /api/v1/orgs/:org/usage` returns those three kinds for an org. It does
  **not** yet return seats or agents, and there are no `plans` or `org_plans`
  tables. Both are in #79's scope and wait for this direction.
- `LICENSE` says "MIT License placeholder". That is not a licence.
- [ADR 0005](../adr/0005-residency.md) (residency) is Proposed. Any hosted
  offer for Australian customers depends on it.

## Direction options

| Option              | What it means                                                                                              | For                                                                     | Against                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Internal only       | Yuma's own forge for Yuma and its managed clients, no price list                                           | No billing, support or sales load; fastest to keep useful               | No revenue; costs carried by Yuma; harder to justify IRAP effort                           |
| Hosted, per seat    | Yuma runs it multi-tenant; each person in an org is a paid seat                                            | Familiar to buyers (GitHub, GitLab); predictable revenue                | Agents do most of the work here, so seats undercount use; heavy agent orgs lose Yuma money |
| Hosted, per agent   | Price per active agent identity, people free or cheap                                                      | Matches what makes this forge different; agent count is already tracked | Agents are cheap to create; needs a clear "active agent" rule; unfamiliar to buyers        |
| Usage-based         | Charge for CI seconds, storage and model tokens above an allowance, on top of a base fee                   | Tracks Cloudflare cost closely; #61 already records all three           | Bills are hard to predict; needs invoicing and limits that fail safely                     |
| Self-hosted licence | Customers run it on their own infrastructure under a paid licence (ties to ADR 0005 option 2)              | Answers guaranteed residency; customer pays the infrastructure          | Needs a portable edition that does not exist; support across environments                  |
| Mix                 | For example: hosted at a per-seat base with an agent and usage allowance, plus a self-hosted licence later | Covers small teams and regulated buyers                                 | Most to build and explain                                                                  |

## Tenancy models

| Model                            | Today                                    | Notes                                                                                                   |
| -------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Shared, many orgs per deployment | How the pilot runs                       | Cheapest; one D1 for everyone; isolation is RBAC and org SSO in code; a D1 size limit applies (see #78) |
| One deployment per customer      | Possible by copying the `prod` env block | Separate D1, R2 and Worker per customer; cleaner for residency and IRAP; more deploys to run            |
| Customer-hosted                  | Not possible yet                         | Needs the portable edition (ADR 0005 option 2)                                                          |

## Competitor prices

Read on 17 October 2026 from each vendor's public page. "Unverified" means we
could not confirm it on that date.

| Product                    | Model and list price                                                                                                                                           | CI and storage                                                                                                       | Source                                                                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub                     | Free $0; Team $4 per user per month "for the first 12 months" (the later price was not shown); Enterprise from $21 per user per month on the same terms        | 2,000 / 3,000 / 50,000 Actions minutes a month; Linux 2-core $0.006 per minute, 1-core $0.002, arm 2-core $0.005     | [github.com/pricing](https://github.com/pricing), [runner pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing) |
| GitHub Copilot             | Individual Pro $10, Pro+ $39, Max $100 a month (AI credits at $0.01 each); Business and Enterprise prices not shown; "Agent HQ" not named on the page          | Coding agent draws AI credits                                                                                        | [Copilot plans](https://github.com/features/copilot/plans)                                                                              |
| GitLab                     | Free $0; Premium $29 per user per month billed annually; Ultimate custom                                                                                       | 400 / 10,000 / 50,000 compute minutes; extra minutes $10 per 1,000; storage 10 GiB free, extra $5 per 10 GiB a month | [about.gitlab.com/pricing](https://about.gitlab.com/pricing/)                                                                           |
| Codeberg (Forgejo)         | Free, donation funded, for free software projects only; no private hosting service (up to 100 MB private content for contributors)                             | Ask first above 750 MiB Git storage                                                                                  | [Codeberg FAQ](https://docs.codeberg.org/getting-started/faq/)                                                                          |
| Commercial Forgejo hosting | Unverified: we did not find and check a commercial Forgejo host's price list                                                                                   | Unverified                                                                                                           | Forgejo itself is GPLv3+ from v9.0 ([forgejo.org](https://forgejo.org/2024-08-gpl/))                                                    |
| Cursor Origin              | Early beta; no separate price; included in Cursor Premium ($30 a month), Super ($100), Ultra ($200), Teams ($30+ per user) and Enterprise; not in Free or Plus | Not stated                                                                                                           | [Origin docs](https://cursor.com/docs/origin), [Cursor pricing](https://cursor.com/pricing)                                             |
| GitCafe                    | Private repos free during the public beta; Pro $20 a month; Team 5x $40 per seat; Team 10x $80 per seat; Enterprise custom                                     | Storage from 2 GiB (Free) to 1 TiB + 100 GiB per seat (Team 10x)                                                     | [git.cafe/pricing](https://git.cafe/pricing)                                                                                            |

Unverified items: GitHub Team and Enterprise prices after the first 12 months;
Copilot Business and Enterprise per-user prices; any commercial Forgejo host.

## Cost model

### Cloudflare unit prices

Workers Paid plan, read 17 October 2026. Allowances are per account per
month and are shared by everything on the account.

| Service              | Unit price beyond allowance                                                                                                                                | Monthly allowance                                                   | Source                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Workers Paid base    | $5 per account                                                                                                                                             |                                                                     | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)             |
| Worker requests      | $0.30 per million; CPU $0.02 per million CPU ms                                                                                                            | 10 million requests; 30 million CPU ms                              | as above                                                                                   |
| D1                   | $0.001 per million rows read; $1.00 per million rows written; $0.75 per GB-month                                                                           | 25 billion read; 50 million written; 5 GB                           | [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)                       |
| Durable Objects      | $0.15 per million requests; $12.50 per million GB-s; SQLite storage $0.20 per GB-month                                                                     | 1 million requests; 400,000 GB-s; 5 GB-month                        | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)             |
| Queues               | $0.40 per million operations (about 3 per message)                                                                                                         | 1 million operations                                                | as above                                                                                   |
| R2 Standard          | $0.015 per GB-month; Class A $4.50 per million; Class B $0.36 per million; no egress fee                                                                   | 10 GB-month; 1 million A; 10 million B                              | [R2 pricing](https://developers.cloudflare.com/r2/pricing/)                                |
| Containers           | vCPU $0.000020 per second (active); memory $0.0000025 per GiB-second; disk $0.00000007 per GB-second; Oceania egress $0.05 per GB                          | 375 vCPU-minutes; 25 GiB-hours; 200 GB-hours; 500 GB Oceania egress | [Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/)       |
| Workers AI           | $0.011 per 1,000 neurons; default agent model `@cf/meta/llama-3.3-70b-instruct-fp8-fast` $0.293 per million input tokens, $2.253 per million output tokens | 10,000 neurons a day                                                | [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)       |
| Workers Logs         | $0.60 per million events; 7 days kept; moves to Cloudflare Observability pricing on 1 December 2026                                                        | 20 million events                                                   | [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) |
| Artifacts (not used) | $0.15 per 1,000 operations; $0.50 per GB-month; billed from 14 October 2026                                                                                | 10,000 operations; 1 GB                                             | [Artifacts pricing](https://developers.cloudflare.com/artifacts/platform/pricing/)         |

The CI rate the forge reserves against is the container rate for the
instance type: `standard-2` (1 vCPU, 6 GiB, 12 GB) is $0.00003584 a second
before allowances (`worker/src/ci/config.ts`, `docs/github-cloudflare-research.md`).
That is gross; actual CPU billing is for active use only, so it is an upper
bound for CPU and exact for memory and disk while the VM runs.

### How #61 usage maps to cost

| Metered thing | Recorded today as                                                       | Priced in `prices.ts` as                                               | Cloudflare cost behind it                                                                          |
| ------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Model tokens  | `usage_events.kind = 'tokens'`, `source = 'workers_ai'` or `'reported'` | Workers AI list price for the default model; subscription models at $0 | Workers AI neurons                                                                                 |
| CI seconds    | `kind = 'ci_seconds'`, model = instance type or `self_hosted`           | Container rate per instance type; self-hosted $0                       | Containers, plus the coordinating Durable Object while the job runs                                |
| Storage       | `kind = 'storage'`, bytes per repo per day                              | R2 Standard $0.015 per GB-month                                        | R2 storage; counts the default branch as code search last indexed it, not full history, and not D1 |
| Seats         | Not recorded; countable from org membership                             | Not priced                                                             | Small: sessions, D1 rows, requests                                                                 |
| Agents        | Not recorded as usage; countable from the `agents` table                | Not priced                                                             | Shows up as tokens, CI seconds and Durable Object time                                             |

Not metered at all today: Worker requests and CPU, D1 rows and storage,
Durable Object requests and duration, Queue operations, R2 operations,
Workers Logs and container egress. On a small deployment these mostly sit
inside the allowances, but a hosted product would need at least D1 storage
and R2 operations metered per org.

### Worked example (illustrative, not measured)

Assumptions, all invented for the arithmetic: one org of 10 people and 5
agents; 200 CI runs a month of 5 minutes on `standard-2`; 20 GB stored in R2;
agents use 10 million input and 1.5 million output tokens on the default model.

| Item                | Working                         | Gross cost before allowances |
| ------------------- | ------------------------------- | ---------------------------- |
| CI                  | 200 x 300 s x $0.00003584       | $2.15                        |
| R2 storage          | 20 GB x $0.015                  | $0.30                        |
| Model input tokens  | 10 x $0.293                     | $2.93                        |
| Model output tokens | 1.5 x $2.253                    | $3.38                        |
| Workers Paid base   | per account, shared by all orgs | $5.00                        |
| **Total**           |                                 | **about $13.76 a month**     |

For comparison only: 10 seats of GitLab Premium list at $290 a month, and 10
seats of GitHub Team list at $40 a month during its first 12 months (both read
17 October 2026). This says Cloudflare cost is unlikely to set the price; the
price is about value, support and assurance (for example IRAP). Real numbers
should come from the pilot's `usage_daily` rows and the Cloudflare invoice, not
from this table.

## Licence options for this repository

The current `LICENSE` is a placeholder. Choosing one is Justin's call; this
draft does not change the file. Whatever is chosen, check the licences of the
npm dependencies are compatible before publishing.

| Licence                           | What it allows                                                                                                                                            | Trade-offs                                                                                                                                       |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| MIT                               | Anyone may use, change, host and sell it, closed or open                                                                                                  | Simplest and most trusted; a competitor can host it as a service with no return to Yuma                                                          |
| Apache-2.0                        | As MIT, plus an explicit patent grant and patent retaliation                                                                                              | Preferred by many enterprises for the patent terms; same hosting exposure as MIT                                                                 |
| BSL 1.1 or FSL                    | Source available; production use allowed except competing hosted use; converts to an open licence after a set time (FSL: two years, to Apache-2.0 or MIT) | Protects a hosted business; not open source by OSI definition, which some customers and contributors avoid                                       |
| AGPL-3.0                          | Open source; anyone offering a modified version over a network must share their changes                                                                   | Discourages closed hosted forks; some companies ban AGPL internally; Yuma's own closed additions would need a separate licence or dual licensing |
| Proprietary (all rights reserved) | Only what Yuma grants by contract                                                                                                                         | Fits internal only and a paid self-hosted licence; no community contributions; buyers may want source escrow                                     |

Context: Forgejo moved to GPLv3+ from v9.0 so that modified versions keep
users' freedoms; hosting a modified Forgejo does not itself trigger source
sharing under GPL, which is the gap AGPL closes. ADR 0001 dropped the Forgejo
path, so Forgejo's licence does not bind this repository.

## Constraints from the ticket

- No billing integration until the direction is approved.
- Payment processing is out of scope.
- Usage API must return seats, agents, CI seconds, storage and tokens per org
  (CI seconds, storage and tokens exist; seats and agents do not yet).

## Decisions for Justin

- Direction: internal only, hosted (per seat, per agent, usage based), a
  self-hosted licence, or a mix. Record the choice in this file.
- Tenancy for any hosted offer: shared multi-org deployment, one deployment
  per customer, or both.
- Licence for this repository (MIT, Apache-2.0, BSL or FSL, AGPL-3.0, or
  proprietary), to replace the placeholder `LICENSE`.
- Which units to meter for a hosted offer beyond the current three (seats,
  agents, D1 storage, R2 operations, Durable Object time).
- Whether to price in AUD and whether prices include GST.
- Whether any hosted offer waits for ADR 0005 (residency) to be Accepted.
- Whether to approve building the `plans` and `org_plans` tables and the seats
  and agents fields of the usage API once a direction is chosen.
