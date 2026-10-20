# 0001. Record architecture decisions

- Status: Accepted
- Date: 2026-10-20

## Context
We need a lightweight way to record significant technical decisions and their reasons,
readable by humans and AI agents working on this repository.

## Decision
We record Architecture Decision Records in `docs/adr/`, numbered sequentially, using the
template from the `adr` skill. Accepted ADRs are not rewritten; new ADRs supersede them.

## Consequences
- Decisions and trade-offs are discoverable next to the code.
- Agents can read the ADRs to follow past decisions instead of re-deciding.
