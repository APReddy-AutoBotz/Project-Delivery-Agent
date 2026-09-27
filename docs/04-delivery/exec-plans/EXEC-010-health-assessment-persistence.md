# EXEC-010: Stored deterministic delivery health assessment

Status: Draft
Owner: Implementation controller
Requirement IDs: AC-HLT-004, FR-HLT-007/008/009/011, FR-MOD-006, NFR-SEC-001/002/004/005/006, NFR-REL-001/003
GitHub issue: #8 (EPIC-04, STORY-013..015)
Target release: R1
Last updated: 2026-09-27

## Objective

Store and display an authenticated, reproducible assessment that keeps the project manager's reported status separate from a deterministic status calculated from the saved delivery configuration. The server owns assessment inputs, time, rules, authorization, and persistence.

## In scope

- A user with current project read access can explicitly request an assessment for one project. The request contains no status, facts, source references, rule values, timestamp, or time zone.
- In one database transaction, lock the project and current matching grants, read the sealed canonical project graph, calculate from its saved project/milestone/work-item configuration, store the exact bounded evaluator input and result, and add an audit event. Use the database UTC clock and record `UTC`; no project time-zone field exists.
- Keep the reported RAG as the stored project value and calculate the schedule assessment independently under a named, versioned rule. Persist the exact rule inputs, source record IDs, selected date/status fields, signal states/severities, rationale, calculation output, actor, UTC assessment time, and a canonical SHA-256 of the input/result envelope.
- Show the latest stored assessment after rechecking current project read access. The view labels its inputs as saved project configuration and states that configured source mappings have not been retrieved or verified. It presents reported and calculated status in separate, clearly named fields.
- Treat absent or invalid required schedule inputs as UNASSESSABLE and never infer GREEN from missing information. A known red signal remains visible if another signal is unassessable.
- Version the initial default schedule rule in code and show its key/revision and date fields/thresholds. Mark coverage as schedule-only until the other health rules have their own authorized input sources and persisted implementation.
- Keep every reviewed-import proposal and connector observation outside the health input builder. Do not call `appendHumanStatement`, alter canonical facts, or publish a proposal.
- Add an additive migration, immutable assessment storage, scoped API contract, UI, and updated migration/restore inventories. Preserve existing migrations and stored evidence.
- Keep AC-HLT-004 and Issue #8 open until the full criterion and its required E2E-HLT-004/GOLDEN-002 evidence pass; a schedule-only increment does not accept STORY-013..015 or change completion totals.

## Out of scope

- Connector fetches, source mapping resolution, source proposal use, or any publication/writeback.
- Claiming that configured dates/statuses are externally verified source facts.
- Calculating or declaring freshness, completeness, blocker age, milestone reconciliation, or other unimplemented signal families clear.
- AI use, editing canonical configuration, rule-configuration UI, project time-zone configuration, and acceptance of Issue #8.

## Current state

PR #82 added the pure blocker-age evaluator and PR #84 added the pure reported-versus-calculated evaluator. PR #84 merged as `eae1a386b90fb1124f39298fd3ae0ac006ee4c25`; the candidate tree is `1313ba645edbfba7252ca948238ba7f6c21cddf8`. The evaluator is deterministic but its caller supplies an already-authorized complete snapshot. There is no health assessment table, scoped assessment API, or health display.

Project status and delivery structure currently live in `Project` and sealed canonical configuration tables. `CanonicalProjectRepository.detail` enforces current project and portfolio grants. Configured source mappings are pointers only; connector imports remain proposals and are not canonical evidence.

## Proposed design

The write boundary accepts only project ID and an idempotency key. A database repository locks the project row and current grant rows, applies the existing project-read role policy, and loads only the bounded canonical project, milestone, and work-item fields needed by the versioned schedule rule. It does not read `IngestionProposalContent`, external mapping targets, connector cursors, or source payloads. If project/grant state, sealed configuration, bounds, or required inputs cannot be validated, the operation fails closed or persists an explicitly UNASSESSABLE schedule result; it never fabricates source authority.

The builder derives reported status from `Project.reportedStatus`. It derives only schedule signals from configured milestone/work-item state and selected saved date fields, with each input linked to the UUID of its canonical row. The response and UI say these are saved configuration values and that no mapped external source has been checked. The calculation has a schedule-only coverage marker; it must not imply a complete project-health assessment while freshness, completeness, blocker-age, and other signal families are not connected to authorized inputs.

Assessment request and read endpoints return a strict bounded envelope. The POST stores a new immutable history row (or returns the same row for an identical actor/project/idempotency key and request hash). The GET returns the latest assessment only after current read authorization. The UI has an explicit “Assess saved plan” action and renders the newly persisted result, timestamp (UTC), rule key/revision, each included signal's source fields and rationale, and the separate reported status. It does not run an assessment on page load.

Persistence uses a new additive PostgreSQL migration and scoped unique/foreign keys. Database guards reject assessment UPDATE/DELETE. The repository owns evaluation and insertion in one transaction, with a corresponding audit event. A stable JSON envelope is hashed using the repository's canonical serialization. No schema change rewrites old migrations.

## Files and modules expected to change

- New domain builder/assessment wire schemas as needed; existing `delivery-health.ts` remains pure.
- New `packages/data` health-assessment repository, Prisma models, generated client, and additive migration.
- API controller, route contract, app composition and production wiring.
- `CanonicalProjectDetails` UI, with existing visual system and no new design framework.
- Domain/data/API/UI tests, E2E-HLT-004 and GOLDEN-002 evidence.
- Migration/upgrade/restore inventories, traceability, implementation status, this ExecPlan and any affected evidence catalog.

## Data model or migration impact

Add an append-only, project-scoped assessment row containing ID, customer/project scope, actor, UTC assessed time, idempotency key and request hash, rule revision, bounded JSON input/result, canonical envelope hash, and audit-event relation. Use foreign keys and uniqueness constraints that bind every reference to the same customer/project. Include an insert-only database guard and API-role least privilege. Add migration 15 without changing prior migration SQL. Update schema snapshots, release table inventories, prior-empty-table checks, database-contract fixtures, upgrade/restore tests, and redacted recovery artifacts.

## Security and privacy impact

Recheck current identity and project read grants in the same transaction that reads inputs and stores the result. A saved assessment is not an authorization token: every read uses current grants. Restrict project fields to those needed for the schedule calculation; do not copy narrative, owners, source URLs, connector data, or proposal content into the assessment. Keep customer/project scope in all database joins and FKs. Bound JSON and reject malformed/duplicate signal identities. Never expose a saved result after access revocation.

## Connector and permission impact

No connector calls or source publication. Project and portfolio read grants are checked according to existing canonical-project policy. Configured mapping rows are not treated as evidence. Any later use of external or versioned project facts requires a separate design for current source grants, authority policy, source/revision identity, expiry/conflict, and historical-proof access.

## Open-source dependency impact

None.

## Implementation stages

1. Independent review of this design at a named candidate SHA. Resolve all findings before application code.
2. Implement the bounded server-side schedule-input builder and immutable persistence/migration. Add schema guards and repository authorization/race tests.
3. Add strict API contracts, current-authorized create/read paths, audit evidence, and UI rendering.
4. Run exact-head Foundation and Documentation hosted workflows, production database upgrade/repeat/restore validation, E2E-HLT-004 and GOLDEN-002; obtain independent exact-head review.
5. Merge only the reviewed passing candidate with an expected head SHA; verify merged tree and parent order, then record post-merge checks and the partial AC status.

## Test and evaluation plan

Use synthetic customer/project UUIDs and isolated databases only. Verify reported GREEN with an overdue configured work item produces a separate stored calculated RED and a reproducible contradiction; repeat the same idempotent command to prove one stored row; verify exact source record/date/rule/rationale fields survive readback and deterministic re-evaluation; verify UTC date boundaries and unavailable dates fail closed; deny missing/revoked/cross-customer project grants; verify proposals do not change health inputs or canonical facts; reject assessment UPDATE/DELETE at the database boundary; and verify no AI provider is called.

Run existing lint, typecheck, unit, integration, browser, package-boundary, clean/repeat migration, forward-upgrade retention, and recovery suites through required hosted workflows. E2E-HLT-004 and GOLDEN-002 remain partial until their complete approved acceptance scripts pass. Do not use production customer data.

## Rollback and recovery

The migration is additive and existing rows/migrations remain unchanged. Disable the new route/UI to stop new assessments. Retain assessment rows and audit history during rollback. Recovery restores the new append-only table with the database; prove forward upgrade and restore before merge. Any destructive table removal requires a separately reviewed migration and verified retention/export plan.

## Progress log

- 2026-09-27: Drafted the persistence/display boundary after PR #84 merged. No implementation or acceptance claim yet.
- Awaiting independent design review and the post-merge Foundation production-boundary gate.

## Decisions made

- Use project configuration as explicitly labeled configuration inputs; do not label it source-verified evidence.
- Exclude connector/source proposals and all external source mappings from this increment.
- Use UTC because there is no approved project time-zone field or rule.
- Mark this assessment schedule-only and keep AC-HLT-004 partial until its complete authorized-source contract and required acceptance evidence pass.

## Risks and mitigations

- **Configuration may be stale or incomplete:** label it as saved configuration, expose each selected field, and yield UNASSESSABLE/UNKNOWN instead of GREEN when required inputs are absent.
- **A schedule-only result could be mistaken for complete health:** include and display an explicit schedule-only coverage label and keep the epic open.
- **Grant changes could race persistence or reads:** lock/recheck current project and grants in the same transaction on write; recheck on every read.
- **New persistence could omit recovery controls:** update all migration, table inventory, runtime-privilege, upgrade and restore acceptance fixtures before merge.
- **Serialized JSON could exceed bounds or include extra data:** fixed fields, strict schema, stable canonical hash, byte/record caps, and exact per-query selects.

## Validation evidence

None yet. Design review and hosted validation are required before acceptance.

## Completion summary

Not started.
