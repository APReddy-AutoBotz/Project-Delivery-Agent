# Decision Log

| Decision | Date | Status | Reference |
|---|---|---|---|
| Build as a standalone product rather than inside AvalaOS | 2026-09-05 | Accepted | BRD, PRODUCT_SCOPE |
| Position as delivery assurance and coordination, not only reporting | 2026-09-05 | Accepted | VISION_AND_STRATEGY |
| Use a TypeScript-first modular monolith | 2026-09-05 | Accepted under 2026-09-06 delegation | ADR-001, ADR-008 |
| Use PostgreSQL and pgvector | 2026-09-05 | Accepted under 2026-09-06 delegation | ADR-002 |
| Use Graphile Worker for schedules and durable background work | 2026-09-05 | Accepted under 2026-09-06 delegation | ADR-003 |
| Use customer-controlled AI provider routing | 2026-09-05 | Accepted | ADR-004 |
| Use customer-hosted, single-tenant deployments first | 2026-09-05 | Accepted | ADR-005 |
| Require human approval for material writes | 2026-09-05 | Accepted | ADR-007 |
| Adopt libraries through package managers, not copied repositories | 2026-09-05 | Accepted | OPEN_SOURCE_POLICY |
| Defer broad connector support until the Jira-plus-spreadsheet loop is complete | 2026-09-05 | Accepted | RELEASE-1-VERTICAL-SLICE |

## 2026-09-06 delegated controller decisions

The Product Owner authorized applying the five controller corrections and starting
implementation. Routine baseline/ADR decisions below are accepted under that
delegation; independent review, checks and merge remain separate evidence gates.

| Decision | Disposition | Reference |
|---|---|---|
| Routine baseline and ADR approval | Delegated to controller after documented gates | DOCUMENT_CONTROL.md |
| Preserve fact origin through staleness/conflict | Accepted | ADR-009 |
| Security enforced in foundation; review exact candidate with non-author | Accepted | ADR-010, CONTRIBUTING.md |
| R1 Jira comments only; fields R2 | Accepted | OD-003, ADR-010 |
| R1 single-project Q&A; portfolio analysis R3 | Accepted | ADR-010 |
| R1 weekday/timezone/quiet hours; holidays R2 | Accepted | OD-006, ADR-010 |
| PowerPoint required; PDF optional; two initial contradictions | Accepted | OD-007, ADR-010 |
| Independent information satisfaction and external action | Accepted | WORKFLOW_ARCHITECTURE.md |
| Retry preflight and restore quarantine | Accepted | APPROVAL_AND_WRITEBACK.md, DEPLOYMENT_AND_OPERATIONS.md |
| No unsupported commercial outcome claim | Retain proposed terms; measure pilot evidence | PILOT_SUCCESS_METRICS.md |

## Publication and partial-increment acceptance, 2026-09-06

The Product Owner explicitly approved public publication. PRs #2/#3/#4 merged
after separate exact-candidate review and passing remote checks. Four milestones
and ten implementation issues are published. Accept the foundation merge only
for its documented synthetic scope; keep STORY-001..005 in progress until their
full contracts pass. Tailwind and pgvector deferrals are outstanding requirement
work, not approved waivers. R0 remains 0/5 and R1 0/33 accepted.
