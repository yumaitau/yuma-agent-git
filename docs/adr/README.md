# Architecture decision records

Each record captures one decision, the options weighed and what would make us
revisit it. Records are numbered in order and never renumbered. To change a
decision, write a new record that supersedes the old one and update the old
record's status.

| ADR                               | Title                                             | Status                    |
| --------------------------------- | ------------------------------------------------- | ------------------------- |
| [0001](0001-forge-strategy.md)    | Forge strategy                                    | Accepted (spikes not run) |
| [0002](0002-saml-sso.md)          | SAML sign-in waits for a safe verifier            | Accepted                  |
| [0003](0003-policy-engine.md)     | Agent policies use a typed TS rules DSL           | Accepted                  |
| [0004](0004-code-search.md)       | Code search uses a trigram index in D1            | Accepted                  |
| [0006](0006-metadata-sharding.md) | Metadata shards by org, with a directory database | Proposed                  |

## Template

```markdown
# ADR NNNN: Title

- Status: Proposed | Accepted | Superseded by ADR NNNN
- Date: YYYY-MM-DD
- Issue: #N

## Context

What forces the decision, with sources.

## Options

The realistic paths, one short paragraph each.

## Scoring

A table of options against the criteria, citing sources or measurements.

## Decision

What we chose and why.

## Consequences

What this makes easier, harder or necessary.

## Review triggers

Facts that would reopen the decision.
```
