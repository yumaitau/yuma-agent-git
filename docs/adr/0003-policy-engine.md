# ADR 0003: Agent policies use a typed TypeScript rules DSL

- Status: Accepted
- Date: 2026-10-16
- Issue: #62 (epic #23)

## Context

Issue #62 puts every agent action through an org policy before it takes
effect: which paths an agent may change, size limits, banned operations and
actions that need a person to approve them. The engine runs inside Git
pre-receive, the commit RPC, ref moves, tags, pipeline runs and the agent
tools, so it must be quick (the acceptance bar is under 10 ms at p95 added to
a push), deterministic and fail closed. Epic #23 asks us to choose between
Cedar (through its WebAssembly build), OPA (Rego) and a typed TypeScript rules
DSL. The issue text names the record `0004-policy-engine.md`; 0003 was the
next free number when this landed, so it is 0003.

Facts the choice rests on:

- The rules the pilot needs are few and shallow: path globs, ref globs, file
  and byte counts, force pushes, dependency registries and a risk level. None
  needs entity hierarchies, set reasoning over principals or partial
  evaluation.
- The forge already has a glob matcher with linear time (`globMatch` in
  `worker/src/policy/rulesets.ts`, written for rulesets #41) and validates
  every boundary with zod.
- The Worker bundle has a size budget (`scripts/check-bundle-size.mjs`).
  Cedar's WebAssembly build and an OPA WebAssembly module each add a binary
  module of several hundred kilobytes and a second runtime to load on cold
  start; neither was measured here because neither fits the bundle budget
  without a separate Worker.
- Org admins edit policies through the API and the CLI, and agents read the
  refusal reason to adjust. Both are easier when a policy is plain JSON that
  the API can validate field by field.

## Options

**Cedar via WebAssembly.** An analysable language with a formal model. Costs
a WebAssembly module in the hot path, a schema to keep in step with our facts
and a language org admins must learn. Its strengths (analysis, entity
hierarchies) are not needed for the rules above.

**OPA (Rego).** Very expressive, widely used. Needs the Rego-to-WebAssembly
toolchain to build policies, a module per policy and a runtime in the Worker.
Expressiveness beyond our facts is a cost here: policies become harder to
review and harder to make fail closed.

**Typed TypeScript rules DSL.** A policy is JSON checked by a zod schema
(`policySchema`), evaluated by a pure function over a typed input
(`evaluatePolicy` in `worker/src/policy/engine.ts`). No new runtime, the same
glob matcher as rulesets, and validation errors name the field.

## Scoring

| Criterion                           | Cedar (WASM)    | OPA (Rego WASM)      | TypeScript DSL           |
| ----------------------------------- | --------------- | -------------------- | ------------------------ |
| Bundle and cold start               | WASM module     | WASM module per rule | none added               |
| Speed for a 200-file push           | not measured    | not measured         | p95 1.3 ms (below)       |
| Covers the #62 rules                | yes             | yes                  | yes                      |
| Field-level validation in the API   | via schema      | via tests only       | zod issues per field     |
| Fails closed on a bad policy        | runtime error   | runtime error        | parse error, then deny   |
| Formal analysis of policy conflicts | yes             | partial              | no                       |
| Effort to add a condition           | schema + entity | Rego + input mapping | one zod field + one test |

Measured with `npm run bench:policy -w worker` (Node 22, Apple silicon,
2000 runs after a warm-up), timing what pre-receive does per agent push:
parse a changed `package.json` (80 dependencies), evaluate the default pack
and hash the payload. D1 reads are I/O and not part of the figure.

| Push size  | p50     | p95     | p99     |
| ---------- | ------- | ------- | ------- |
| 200 files  | 0.77 ms | 1.32 ms | 1.62 ms |
| 1000 files | 3.70 ms | 3.93 ms | 4.58 ms |

Workers run the same V8 engine, but the benchmark has not been run inside a
deployed Worker: `performance.now()` does not advance during CPU work there,
so an in-Worker figure needs `wrangler dev` timing or production traces.

## Decision

Use the typed TypeScript rules DSL.

- A policy is `{ version: 1, rules: [...] }`. A rule has an `id`, the
  `actions` it covers (`push`, `changeset.create`, `ref.move`, `pr.merge`,
  `release.publish`, `pipeline.run`, `pipeline.edit`, `secret.write`,
  `issue.ready`), an `effect` (`deny` or `require_approval`) and `when`
  conditions that must all hold: `paths`, `refs` (globs, `!glob` excludes,
  last match wins), `max_files`, `max_bytes`, `force_push`, `risk` and
  `registries`. The strictest match wins; no match allows.
- The default pack is `policies/default.json`. An org's newest stored version
  replaces it whole; repos owned by users run the default pack.
- Policies judge agent identities (#57) and the agent tools (built-in runs and
  MCP calls). People, including people pushing with API tokens that carry the
  default `agent:run` scope, are not judged.
- A held action becomes an approval row bound to the agent, the action and the
  sha256 of the exact payload (old and new SHAs for a push, the whole request
  for a commit). A person approves in the dashboard or the API; the agent's
  next identical attempt proceeds, anything different asks again.
- The policy fails closed: if the stored policy cannot be parsed, agent
  actions are refused with `policy_unavailable`. People are not judged, so
  there is no human fail-open path to configure.
- Size limits use bytes of new content, not lines: counting changed lines in
  pre-receive needs every base blob read and diffed.

## Consequences

- No new runtime or binary module; the engine is about 250 lines with tests
  that run every fixture in `worker/test/fixtures/policy/`.
- `yag policy test` posts a policy and fixtures to `POST /api/v1/policy/test`,
  so the CLI never carries a second copy of the engine. It needs a reachable
  forge.
- There is no formal conflict analysis. Policies stay small and every rule
  has an `id` that appears in each refusal, in the audit log and in the
  approval card.
- `secret.write` and `issue.ready` are accepted actions with nothing to judge
  yet: agents cannot write secrets (session only) and the ready state arrives
  with the work queue (#59). Agent identities cannot merge pull requests at
  all today, so the default `high-risk-merge` rule is a stated intent until
  that changes.

## Review triggers

- Policies need relations the DSL cannot express (for example, "an agent may
  approve another agent's change only when its owner is in team X").
- Org admins ask for static analysis of policy conflicts.
- A measured p95 inside a deployed Worker exceeds 10 ms for a realistic push.
- Cedar or OPA ship a Worker-native build small enough for the bundle budget.
