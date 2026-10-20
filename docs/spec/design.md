# Design: Should I Bother?

- Status: Draft <!-- Draft | In review | Approved -->
- Last updated: 2026-10-20
- Implements: requirements.md (REQ-*, NFR-*)

## Overview
- Deployment target: <!-- from product.md: GCP | Local / on-device | Other -->
<!-- One paragraph + a diagram (Mermaid) of the main components and data flow. -->
```mermaid
flowchart LR
  user[User] --> api[Service]
```

## Options considered
<!-- 2–3 architecture options with trade-offs; the chosen one links to its ADR. -->

## Components
| Component | Responsibility | Tech / service (GCP service or local runtime) | Requirements |
|---|---|---|---|

## Data model
<!-- Entities, key fields, ownership, retention, data classification. -->

## Interfaces
<!-- APIs (endpoints, events, CLI), request/response shapes, errors, versioning. -->

## Security design
<!-- GCP: service accounts, IAM, Secret Manager, ingress. Local / on-device: device trust
     boundary, listening interfaces, local data at rest, calls that leave the device. -->
- Identities: <!-- service accounts per workload, human access; or local users/devices -->
- Access control (least privilege):
- Secrets: <!-- Secret Manager, which secrets, who accesses; or none / local git-ignored files -->
- Network exposure: <!-- public endpoints, ingress protection; or localhost/LAN only -->
- Data protection: <!-- encryption, PII handling -->
- Threats considered: <!-- top risks and mitigations -->

## Reliability and operations
- Failure modes and handling:
- Observability: <!-- logs, metrics, alerts, SLO dashboards -->
- Backups / recovery:

## Environments and deployment
<!-- GCP: dev/prod projects, CI/CD, rollout and rollback strategy.
     Local / on-device: supported machines (OS, RAM, GPU), setup, model/asset downloads, distribution. -->

## Testing strategy
<!-- Unit / integration / e2e: what each level covers; how ACs map to tests. -->

## Cost estimate
<!-- Main cost drivers and a rough monthly range (label as estimate); for a local target,
     hardware requirements and any paid external APIs. -->

## Decisions
| ID | Decision | ADR |
|---|---|---|
| D-1 | | docs/adr/000N-... |

## Traceability
| Requirement | Design section(s) |
|---|---|
