# EXEC-010: Stored deterministic delivery health assessment

Status: In progress
Owner: Implementation controller
Requirement IDs: AC-HLT-004, FR-HLT-007/008/009/011, FR-MOD-006, NFR-PRV-004, NFR-REL-001/003, NFR-SEC-001/002/004/005/006
GitHub issue: #8 (EPIC-04, STORY-013..015)
Target release: R1
Last updated: 2026-09-27

## Objective

Store and display an authenticated, reproducible assessment that keeps the project manager's reported status separate from a deterministic status calculated from the saved delivery configuration. The server owns assessment inputs, time, rules, authorization, persistence, and retention.

## In scope

- A user with current project read access can explicitly request one assessment. The request contains only project ID and an idempotency key; clients supply no status, facts, source references, rule values, timestamp, time zone, or computed result.
- In one database transaction, recheck project scope, lock matching AccessGrant rows and the CanonicalProject seal row, and read the sealed canonical project graph. The base Project row and sealed schedule rows are immutable to the runtime API role. Calculate from saved project/milestone/work-item configuration, store the exact bounded evaluator input/result, and append an audit event. Use the database UTC clock and record `UTC`; no project time-zone field exists.
- Keep reported RAG from `Project.reportedStatus` and calculate schedule status independently under `schedule-health@1`. Persist selected source record IDs, input fields/values, thresholds, signals, rationale, result, actor, UTC assessed time, idempotency hash and canonical SHA-256 envelope hash.
- Define v1 schedule rule precisely: for open/in-progress milestones and work items, use `forecastEnd` when present, else `plannedEnd`; never treat `baselineEnd` as the current due date. `COMPLETE` and `CANCELLED` records are CLEAR regardless of date. An open/in-progress record is ACTIVE/HIGH when its selected date is at least one UTC calendar day overdue; it is CLEAR/LOW on or after the current UTC date. If neither date exists, mark that signal UNASSESSABLE. No configured schedule targets produces an UNASSESSABLE coverage signal. Any active HIGH/CRITICAL signal maps to RED; absent red, any unassessable signal maps to UNKNOWN; otherwise the schedule-only result is GREEN. v1 emits no AMBER signals. Expose this exact coverage/rule scope; do not imply other health criteria are clear.
- Show the latest stored assessment only after current project read authorization. Label its inputs as saved project configuration and state that source mappings were not retrieved or verified. Display reported and calculated status separately, with signal evidence and rationale.
- Add a per-customer `HealthAssessmentRetentionPolicy`, distinct from proposal-content retention, with configurable content, audit-history, and idempotency hours. A `pmo_admin` changes it through a strict API. No policy means no assessment write. Require audit hours >= content hours and idempotency hours >= audit hours. Each assessment snapshots absolute expiry deadlines from the database assessment time. A shorter policy takes effect immediately; a longer policy never extends an existing deadline or restores redacted content and applies only to new assessments.
- An hourly privileged retention task calls a narrowly scoped security-definer database procedure. At content expiry it redacts input/result and records a redaction event; at audit expiry it purges the minimal assessment tombstone and assessment-specific audit events. A separate minimal command receipt (hashed key, actor/project scope, request hash, assessment ID) remains until idempotency expiry. Reads hide content at its effective expiry even if the sweep is delayed. A same-key retry after content redaction returns the original tombstone; after tombstone purge but before receipt expiry it returns `IDEMPOTENCY_RESULT_EXPIRED` without creating a new row. A key is guaranteed idempotent through its configured idempotency window; after its receipt expiry it is outside the guarantee and clients must use a new key. Normal API/database roles cannot update or delete assessment history; the retention procedure is the only scoped exception.
- Keep reviewed-import proposals and connector observations outside the health input builder. Never call `appendHumanStatement`, alter canonical facts, or publish a proposal.
- Add additive migration, policy/API/worker storage, UI, and updated migration/restore inventories. Preserve existing migrations and retained evidence.
- Keep AC-HLT-004 and Issue #8 open until the complete criterion and required E2E-HLT-004/GOLDEN-002 evidence pass. A schedule-only increment does not accept STORY-013..015 or change completion totals.

## Out of scope

- Connector fetches, source mapping resolution, source proposal use, or publication/writeback.
- Claiming configured values are externally verified source facts.
- Declaring freshness, completeness, blocker age, milestone reconciliation, or other unimplemented signal families clear.
- AI use, editing canonical configuration, configurable rule UI, project time-zone configuration, and acceptance of Issue #8.

## Current state

PR #82 added the pure blocker-age evaluator and PR #84 added the pure reported-versus-calculated evaluator. PR #84 merged as `eae1a386b90fb1124f39298fd3ae0ac006ee4c25`; its candidate tree is `1313ba645edbfba7252ca948238ba7f6c21cddf8`. The evaluator is deterministic but its caller supplies an already-authorized complete snapshot.

The revised plan head `dae098bd06c0fad25cf0146850fceba13ce09ca5` was approved by independent review with no findings. Exact-head [Documentation validation #361](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/36308322917) and [Foundation validation #296](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/36308322882) passed, including the production-boundary job. The candidate implementation adds a server-built UTC schedule-only assessment, scoped persistence and reads, idempotency receipts, strict retention-policy API, privileged expiry worker and separately labeled project display. Full implementation validation and independent exact-head review remain pending.

Project status and delivery structure currently live in `Project` and sealed canonical configuration tables. `CanonicalProjectRepository.detail` enforces current project and portfolio grants. Configured source mappings are pointers only; connector imports remain proposals and are not canonical evidence. Existing `IngestionRetentionPolicy` only covers proposal-content redaction and is not reused for health assessment retention.

## Proposed design

The assessment POST boundary accepts only project ID and `commandKey`. The repository starts a database transaction, reads the immutable base Project row, locks current matching grants and the CanonicalProject seal row, validates the same project/portfolio read policy as the canonical-project route, and loads only bounded `Project`, `Milestone`, and `WorkItem` fields. It does not read `IngestionProposalContent`, external mapping targets, connector cursors, or source payloads. If identity, scope, grant, project, or policy cannot be validated, abort without an assessment row. Only a successfully authorized read with missing schedule configuration or dates may store explicit UNASSESSABLE signals.

Rule `schedule-health@1` uses database UTC `asOf` and UTC calendar-day boundaries. For each open/in-progress milestone and work item, select `forecastEnd`, falling back to `plannedEnd`; do not use baseline or actual dates as a substitute. Date < UTC as-of date gives ACTIVE/HIGH with `minimumOverdueDays=1`; date >= as-of date gives CLEAR/LOW. COMPLETE/CANCELLED gives CLEAR/LOW without requiring a date. Missing selected dates on open work give UNASSESSABLE. If there are no configured schedule targets, add a project-level UNASSESSABLE coverage signal so the evaluator cannot infer GREEN from an empty graph. The versioned calculation rule assigns CRITICAL/HIGH to RED, MEDIUM to AMBER, LOW to GREEN; v1 generates only HIGH active schedule-overdue signals and therefore never synthesizes AMBER. If a red signal and an unassessable signal coexist, retain RED and show the unassessable signal. The view and API identify `coverage=SCHEDULE_ONLY`; this is not full project health.

The request hash covers only the canonical action/project request, not the changing snapshot or current time, so a retried command returns its original stored assessment. A separate `HealthAssessmentCommandReceipt` has a unique key over `customerId + projectId + SHA256(commandKey)`, plus actor subject, request hash, assessment ID, created time and idempotency expiry; it has no FK to the assessment so it can outlive the tombstone. A same-actor, same-hash replay returns the stored assessment or its expired tombstone after fresh authorization. Reuse by another actor or with a different hash returns a generic conflict; if the assessment tombstone has expired but the receipt remains, return `IDEMPOTENCY_RESULT_EXPIRED` and create no row. After the receipt expires, that key is outside the configured guarantee window and a new intentional command must use a new key.

The current policy row has `contentRetentionHours`, `auditRetentionHours`, and `idempotencyRetentionHours`, plus revision, changed-by and changed-at metadata. `pmo_admin` changes it through the API; every change is audited. A retention-change event stores the audit window selected by that revision and expires at `occurredAt + auditRetentionHours`; when it is the current event, the retention procedure clears the nullable policy pointer before deleting the event. Policy metadata remains available after the event expires. A missing policy prevents assessment writes. At creation, the repository records absolute content, audit and idempotency expiry timestamps from the same database UTC assessment time. A policy decrease immediately shortens effective expiry using the earlier of the recorded deadline and the deadline implied by the current policy; a policy increase never lengthens an existing row or re-exposes redacted content and applies only to future assessments.

The hourly worker connects with the worker database role and can only EXECUTE a fixed-search-path security-definer retention procedure. It has no direct assessment or receipt DML. The procedure redacts expired input/result content and appends a retention event; after audit expiry it deletes the tombstone and assessment-specific audit events. It deletes the separate command receipt only after the configured idempotency expiry. The reader checks the effective deadline before returning payload, so delayed sweeps do not extend content access. A retry receipt outlives the assessment tombstone when necessary and prevents duplicate creation for the full configured retry horizon.

Persistence uses a new additive migration and customer/project-scoped keys. Assessment and receipt insert guards reject normal UPDATE/DELETE; the privileged retention procedure is a tightly scoped and separately tested exception. The command receipt is deliberately not FK-bound to assessment history, so it can enforce idempotency through its configured horizon. Assessment-specific audit rows have no FK that prevents configured expiry. Policy-change audit rows also expire under their captured per-revision audit window; the nullable current-event FK is detached before delete. Use canonical JSON serialization and bounded strict schemas for hashes and payloads.

## Files and modules expected to change

- Domain assessment builder and strict retention-policy/assessment schemas; `delivery-health.ts` remains pure.
- New `packages/data` assessment and retention repositories; Prisma models; generated client; additive migration; scoped SQL retention function.
- API assessment controller, pmo-admin policy route, contracts, app composition and production wiring.
- Worker task schedule and least-privilege execution of the retention function.
- `CanonicalProjectDetails` UI, preserving the existing visual system.
- Domain/data/API/worker/UI tests; E2E-HLT-004 and GOLDEN-002 evidence.
- Migration/upgrade/restore inventories, role grants, traceability, implementation status, this ExecPlan and affected evidence catalog.

## Data model or migration impact

Add append-only project-scoped assessment rows containing ID, customer/project scope, actor, UTC assessed time, command-receipt hash, rule revision, bounded JSON input/result, envelope hash, absolute content/audit expiry timestamps and redaction timestamp. Input/result become nullable only through the retention function; after audit expiry, the function may delete the tombstone and assessment-specific events. Add `HealthAssessmentCommandReceipt` with customer/project scope, hashed command key, actor subject, request hash, assessment ID, creation time and expiry; retain it after assessment deletion until idempotency expiry. Add a separate per-customer `HealthAssessmentRetentionPolicy` with content/audit/idempotency hours, revision, changed-by/time. Require audit >= content and idempotency >= audit. Bind project references to the same customer/project. Add a restricted security-definer function, revoke PUBLIC execution, grant only the worker role, and give the API role no update/delete rights. Add migration 15; do not rewrite applied SQL. Update schema, generated Prisma, runtime privileges, release inventories, prior-empty-table checks, database-contract fixtures, upgrade/restore evidence and redacted recovery tests.

## Security and privacy impact

Recheck current identity/project read grants in the same transaction that reads inputs and stores the result. A saved assessment is not an authorization token; each read checks current grants. The pmo-admin retention route rechecks an authenticated admin identity and records every policy revision. Restrict selects to required schedule fields; do not copy narrative, owners, source URLs, connector values or proposal content. Apply retention expiry before returning JSON and physically redact it through the privileged worker. Normal API roles are insert/read only for assessments. The worker can execute only the fixed-scope retention function. Keep customer/project scope in every database join and FK.

## Connector and permission impact

No connector calls or source publication. Project/portfolio read policy follows the canonical-project boundary. Configured mappings are not evidence. Any later external or versioned project fact use requires separate design for current source grants, authority policy, source/revision identity, expiry/conflict and historical-proof access. Only `pmo_admin` can change health-assessment retention policy; source ingestion and project readers cannot.

## Open-source dependency impact

None.

## Implementation stages

1. Independent review of this revised design at a named candidate SHA. Resolve all findings before application code.
2. Implement the bounded server-side schedule builder, request idempotency and immutable assessment repository/migration.
3. Implement strict retention policy API, DB redaction/purge procedure, least-privilege hourly worker, and retention/recovery tests.
4. Add assessment create/read contracts and UI rendering.
5. Run exact-head Foundation and Documentation hosted workflows, production database upgrade/repeat/restore validation, E2E-HLT-004/GOLDEN-002, and independent exact-head review.
6. Merge only the reviewed passing candidate with expected head SHA; verify merged tree/parents, then record post-merge checks and partial AC status.

## Test and evaluation plan

Use synthetic customer/project UUIDs and isolated databases only. Verify reported GREEN with an overdue configured work item produces separate stored calculated RED and reproducible contradiction; same actor/project/key/hash replay returns one row; another actor or mismatched hash using the same scoped key conflicts without a new row; read after grant revocation is denied. Verify exact source row/date/rule/threshold/rationale survive re-evaluation. Test forecastEnd-over-plannedEnd precedence, UTC date boundaries, minimum overdue day, completed/cancelled without dates, missing dates, no schedule targets, unassessable plus known RED, and no false GREEN. Verify imports/proposals cannot affect assessment inputs or canonical facts.

Test retention policy missing/invalid access, pmo_admin-only changes, policy audit revisions, pre-expiry payload readability, read-time redaction before worker execution, physical redaction by the privileged procedure, API UPDATE/DELETE denial, worker denial of direct table DML and unrelated functions, tombstone/event purge at audit expiry, policy-change audit expiry using its captured revision window, command receipt surviving tombstone purge, same-key replay after content expiry, expired-result conflict before idempotency expiry, receipt purge/post-window behavior, monotonic shorter-policy expiry and no visibility restoration after policy increase, repeat sweep idempotency, cross-customer isolation and recovery. The isolated database rehearsal must assert redacted payload fields, retained/deleted audit rows, receipt survival and exact replay behavior. Verify no AI provider call.

Run lint, typecheck, unit, integration, browser, package-boundary, clean/repeat migration, forward-upgrade retention and restore suites through required hosted workflows. E2E-HLT-004/GOLDEN-002 remain partial until their complete approved acceptance scripts pass. Do not use production customer data.

## Rollback and recovery

Migration is additive; prior migrations and rows remain unchanged. Disable assessment/policy routes and the scheduled sweep to stop new writes. Do not drop assessment data as a rollback action. Configured expiry/redaction is the only planned mutation/deletion path and runs only through the reviewed retention procedure. Restore retains the new tables, policies, function privileges and valid migration history; prove clean migration, forward upgrade, repeat deployment and restore before merge. Any other destructive schema removal requires a separately reviewed migration and verified retention/export plan.

## Progress log

- 2026-09-27: Drafted after PR #84 merge.
- 2026-09-27: Independent review of plan SHA `e27282d2f0062a1a72f509b76ea1f915f08f60fd` found four gaps; they were resolved in `80bfd0734e3094be7aa42591d61dd691b1613b68`.
- 2026-09-27: Review of `80bfd0734e3094be7aa42591d61dd691b1613b68` found that purging the assessment tombstone would erase the idempotency uniqueness record and that retention deadline changes needed monotonic semantics. Added a separate command receipt that outlives assessment history and defined the bounded guarantee window and expiry anchors. Independent review approved exact head `dae098bd06c0fad25cf0146850fceba13ce09ca5` with no findings.
- 2026-09-27: Post-merge Foundation verification initially failed at packaged customer restore `sessions_before_commit`; retry attempt 2 passed in run `36305803465`. The revised plan candidate Documentation validation and Foundation verify job passed; its production-boundary validation was still running when implementation began.
- 2026-09-27: Began the approved schedule-only persistence slice on PR #85. The candidate adds bounded schedule input construction, assessment and command-receipt tables, current-grant checks, monotonic retention logic, an execute-only worker purge path, policy API, and separate UI display. AC-HLT-004 and Issue #8 remain open pending complete source-authority coverage and E2E-HLT-004/GOLDEN-002.
- 2026-09-27: Review identified retention-change audit rows that were not expiring and missing database behavior checks. The migration now expires each policy-change event under the audit window captured in that revision, clears the optional current-event pointer first, and the isolated database script exercises redaction, event/tombstone/receipt expiry, replay and repeat sweeps. Exact-head hosted validation remains pending.
- 2026-09-27: The follow-up candidate also fixes nullable JSON response serialization, preserves health API privileges when shared grants are rebuilt, includes the three health tables and ACL checks in prefix-nine upgrade rehearsal, and checks assessment/receipt immutability during recovery. New hosted validation and exact-head review remain pending.
- 2026-09-27: Foundation #306 passed static checks and unit tests, then exposed that a plain clean synthetic migration may run before service roles are provisioned. The candidate now conditionally applies the finite API/worker ACLs when those roles exist, while always revoking PUBLIC access. Fresh exact-head validation remains pending.

## Decisions made

- Use saved project configuration only as explicitly labeled configuration inputs; never label it source-verified evidence.
- Exclude connector/source proposals and all external source mappings from this increment.
- Use UTC because no project time-zone field exists.
- Select forecastEnd, then plannedEnd; use a one-day overdue threshold; clear completed/cancelled items; map active overdue to HIGH/RED; mark missing/empty schedules UNASSESSABLE.
- Require separate pmo_admin-configured content, audit, and idempotency retention; a missing policy prevents new assessment records. Shorter retention takes effect immediately; increases never extend existing deadlines or restore payloads. The idempotency receipt outlives the assessment tombstone through its configured retry window.
- Normal API roles cannot mutate stored assessment history. A least-privilege worker procedure redacts expired payloads, then purges tombstones/events after the audit window.
- Mark output schedule-only and keep AC-HLT-004/Issue #8 open until the complete authorized-source contract and required acceptance evidence pass.

## Risks and mitigations

- **Saved configuration may be stale:** label it as configuration, expose every selected field and do not imply external verification.
- **Schedule-only result could be mistaken for full health:** include and display explicit schedule-only coverage, and keep the epic open.
- **Grant changes can race persistence:** lock/recheck current AccessGrant rows and the canonical seal row in one transaction on writes and recheck every read; the base Project and sealed schedule graph are immutable to the API database role.
- **Retention could expose content after expiry or allow ordinary API mutation:** mask payload by monotonic effective expiry at reads, use a restricted database procedure and hourly worker, preserve only a scoped hashed command receipt through its configured retry window, and test API/worker permissions.
- **New storage could miss recovery controls:** update every migration, table, privilege, upgrade, restore and audit inventory before merge.
- **JSON could exceed bounds or include unrelated data:** use fixed selects, strict schemas, stable canonical hashes, byte/record caps and exact payload fields.

## Validation evidence

Plan independent review approved exact head `dae098bd06c0fad25cf0146850fceba13ce09ca5` with no findings. Exact-head [Documentation validation #361](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/36308322917) and [Foundation validation #296](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/36308322882) passed, including Foundation verify and production-boundary jobs. The schedule-only implementation candidate has not yet completed exact-head hosted validation or independent code review.

## Completion summary

In progress. The slice is schedule-only and does not accept AC-HLT-004, STORY-013..015, or Issue #8.
