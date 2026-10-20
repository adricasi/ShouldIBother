# Requirements: Should I Bother?

- Status: Draft <!-- Draft | In review | Approved -->
- Last updated: 2026-10-20

IDs are permanent: never renumber or reuse. Deprecate with ~~strikethrough~~ and a note.
Acceptance criteria use EARS style: `WHEN <trigger> [WHILE <state>] THE SYSTEM SHALL <response>`
(or `IF <unwanted condition> THEN THE SYSTEM SHALL <response>`). Each one must be testable.

## Functional requirements

### REQ-001: <short title>
- Story: As a <persona>, I want <capability>, so that <benefit>.
- Priority: Must <!-- Must | Should | Could -->
- Goals: G-1
- Acceptance criteria:
  - AC-001.1: WHEN ... THE SYSTEM SHALL ...
  - AC-001.2: IF ... THEN THE SYSTEM SHALL ...

## Non-functional requirements
| ID | Category | Requirement (measurable) | Verification |
|---|---|---|---|
| NFR-001 | Security | | |
| NFR-002 | Privacy / data classification | | |
| NFR-003 | Availability (SLO) | | |
| NFR-004 | Performance | | |
| NFR-005 | Scalability | | |
| NFR-006 | Cost | | |
| NFR-007 | Observability | | |
| NFR-008 | Compliance | | |

## Out of scope
<!-- Requirements considered and rejected for this version, with the reason. -->
