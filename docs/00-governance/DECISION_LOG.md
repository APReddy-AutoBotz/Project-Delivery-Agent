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

## Customer-hosted boundary implementation, 2026-09-06

Accept ADR-011's native React/Tailwind layer, explicit production file secrets,
shared verified database transport and configurable OIDC scope/logout behavior
under delegated routine architecture authority. Modern pnpm deploy and bounded
optional-build-peer metadata hooks separate runtime packages from development
tools; upstream package files are unchanged. Controlled TLS/Keycloak fixtures run
only in isolated development containers. Commercial distribution, OS license
review, complete notices and final image vulnerability disposition are not waived.
EXEC-003 remains open until its complete acceptance scope is evidenced.

## Executable foundation contracts, 2026-09-06

Accept ADR-012 under delegated routine architecture authority. Shared Zod schemas
generate OpenAPI and validate requests/successful responses; development-only Ajv
independently verifies actual HTTP bodies. Exact MIT Ajv 8.20.0 and ajv-formats
3.0.1 are approved for development validation. TypeScript import/package gates
enforce the documented boundaries, and worker heartbeat persistence moves behind
a domain repository port. No new schema or integration is required. STORY-001/002
acceptance remains conditional on complete evidence, exact review, CI and merge.

## First foundation story acceptance, 2026-09-06

Accept STORY-001 / AC-FND-001 and STORY-002 / AC-DATA-001 under delegated
implementation controller authority. Non-author review approved exact `56e4fbd`;
all three remote jobs passed and PR #18 merged as `5829e23`. Saved CI artifacts
match the reviewed source tree and confirm 44 native tests, eight production
groups, migration/recovery and the remaining required checks. See
FOUNDATION_CONTRACT_VALIDATION.md for full immutable references. R0 is 2/5 (40%);
R1 is 0/33 (0%). STORY-003/004/005, Issue #5, customer deployment and commercial
release/distribution remain open; no release gate or customer prerequisite is waived.

## Foundation operations adapter, 2026-09-06

Accept ADR-013 under delegated routine implementation authority. A separate
operations image reuses approved dependencies and PostgreSQL 17 tools, shares the
pinned Prisma migration ledger/lock, provisions restricted roles, and authenticates
encrypted backups before a fresh quarantined restore. Customer reference Compose
supports bundled or external PostgreSQL. No dependency version, business schema,
connector scope or customer activation is introduced. Cross-cluster bootstrap,
restore promotion/action reconciliation and full distribution gates remain open.
Independent review and immutable packaged acceptance are required before merge.
