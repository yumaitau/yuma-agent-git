# Architecture decision records

Each record captures one decision, the options weighed and what would make us
revisit it. Records are numbered in order and never renumbered. To change a
decision, write a new record that supersedes the old one and update the old
record's status.

| ADR                            | Title          | Status                    |
| ------------------------------ | -------------- | ------------------------- |
| [0001](0001-forge-strategy.md) | Forge strategy | Accepted (spikes not run) |

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
