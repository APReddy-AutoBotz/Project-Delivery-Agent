# EXEC-014: Configure update cadence and preview its schedule

Status: In Progress  
Owner: Implementation controller  
Requirement IDs: FR-ADM-004, FR-ESC-002, FR-UPD-012, NFR-SEC-001, AC-ADM-002  
GitHub issue: #9  
Target release: R1  
Last updated: 2026-09-29

## Objective

Implement AC-ADM-002 by letting an authorized project administrator configure the project update threshold, reminder offsets, one project-manager escalation recipient, and quiet hours, then inspect a deterministic schedule preview.

The preview is a pure calculation over a source-authorized assessment pinned to the saved policy revision. This increment creates no dispatch work and sends no message.

## In scope

- Extend the immutable project update policy revision with bounded reminder business-day offsets, one PM escalation delay and recipient, and an optional local quiet-hours interval.
- Preserve the existing due threshold formula: authority-selected source timestamp plus the elapsed freshnessWindowSeconds, falling back to canonical project creation time only where the existing assessment contract does so.
- Add deterministic request, reminder, and single PM escalation schedule calculation using the project's configured IANA time zone, Monday-Friday business days, quiet-hour deferral, and explicit DST resolution.
- Add a server-authorized transient preview endpoint and project update UI.
- Validate a configured escalation recipient as a current same-project PROJECT_MANAGER responsibility with a current project or portfolio read grant. Recheck the role and grant within the policy-save transaction.
- Add an additive database migration, pure schedule tests, policy authorization/integration coverage, browser acceptance evidence, and upgrade/recovery inventory updates.

## Out of scope

- Sending email, chat, Jira or other messages; creating a dispatcher, worker task, queue item, or outbound action.
- Escalation to team leads or leadership; channel selection; multi-stage recipient chains. These remain required work under FR-ESC-002 beyond this bounded AC-ADM-002 slice.
- Customer holiday calendars, recipient-specific time zones, response collection, pause/delegation behavior, or automatic rescheduling of an active obligation when its policy changes.
- Any live Jira OAuth onboarding/activation (OD-013), comment reads (OD-014), or canonical-fact writes. Spreadsheet rows remain reviewed import proposals.

## Current state

- ProjectUpdatePolicyRevision is append-only and currently stores the freshness window, project IANA zone, required facts, responsible owner, scan flag/service identity, and audit metadata.
- A due obligation pins one policy revision. Its cycle identity can reuse the same open obligation across revisions when its source threshold, owner, and required facts are unchanged.
- Existing assessments persist the server-selected source date, source-date field, threshold instant, timestamp basis, as-of instant, and policy revision. latest() rechecks project and source-reader access before returning referenced values.
- EXEC-012 explicitly excludes reminders and escalation; no message dispatch exists in that workflow.

## Proposed design

1. Treat the due threshold as an absolute UTC instant: sourceDate + freshnessWindowSeconds. The IANA zone formats the instant and controls calendar scheduling; it never shifts the logical due time.
2. Configure quiet hours as optional local HH:mm start/end values in the project IANA zone. Both values must be present together and must differ. The interval is start-inclusive/end-exclusive; start later than end means it crosses midnight.
3. A request first becomes send-eligible at the earliest weekday instant at or after logical dueAt that is outside quiet hours. A weekend deferral preserves the local wall time. A quiet-hour deferral moves to the interval end. Apply both rules repeatedly until eligible.
4. Schedule reminder offsets and one PM escalation offset from the first eligible request time, in strictly increasing business-day order, preserving its local wall time. Count Monday-Friday only; holidays are not skipped in this R1 slice. Each stage is itself deferred to the next allowed weekday/outside-quiet-hours time.
5. Resolve DST gaps by advancing a nonexistent local time to the first valid local minute after the gap. Resolve overlaps to the earlier UTC instant. Return UTC instant, local wall time, zone and numeric offset for every stage.
6. The preview endpoint reads the latest saved assessment only when it was created under the current policy revision and current project/scope authorization remains valid. It rejects stale revision inputs and rechecks every stored source reference. The preview returns asOf, assessment ID/revision, policy revision, source-date field/value/basis, logical dueAt, adjusted initial request time, and the ordered stage schedule. It accepts no client timestamp and persists no preview record.
7. New policy revisions may specify up to eight positive, increasing reminder offsets (1–90 business days), one optional PM escalation offset (1–90 days) greater than all reminders, and a recipient that must be configured if escalation is enabled. An empty reminder array, zero escalation delay, null recipient and null quiet hours are explicit disabled values for pre-existing revisions and remain safe for old application versions.
8. Schedule settings are snapshots. A saved revision does not rewrite an existing obligation pinned to a prior revision. This no-dispatch preview shows the selected assessment and settings only; the later dispatch increment must define how changes affect an open obligation before sending.
9. Add only new columns with database defaults and checks; never update immutable policy or assessment rows. Rollback retains the additive columns and data and follows the existing forward-only migration/restore recovery procedure.

## Files and modules expected to change

- packages/domain/src/project-updates.ts and a new pure schedule module under packages/domain/src/
- packages/domain/src/index.ts
- packages/data/src/project-updates.ts
- packages/data/prisma/schema.prisma and a new timestamped migration
- apps/api/src/project-update-controller.ts and the API contract/OpenAPI generation inputs if needed
- apps/web/src/project-updates.tsx and styles as needed
- Pure, integration, and browser tests plus requirements/traceability/tests.yaml
- Migration, prefix-upgrade and recovery inventories and relevant operator documentation
- The new ExecPlan, exec-plan index, implementation status, and Issue #9 evidence after all required gates pass

## Data model or migration impact

Add reminderBusinessDayOffsets smallint[] NOT NULL DEFAULT '{}', escalationAfterBusinessDays smallint NOT NULL DEFAULT 0, nullable escalationRecipientSubject, nullable quietHoursStartLocal and quietHoursEndLocal (HH:mm) to ProjectUpdatePolicyRevision.

Constrain reminder count and values, strict ordering and uniqueness, the escalation enabled/recipient pair, escalation ordering after reminders, local-time syntax, and the quiet-hours pair/equality rule. Extend Prisma and strict request/view schemas with the same bounds. Keep policy revisions immutable and preserve zero-notification defaults for historical rows without updating them.

## Security and privacy impact

Require pmo_admin plus current project configuration grant for policy writes. Validate the escalation recipient's responsibility and current project/portfolio read access under the same transaction locks as the policy revision write. Preview reads are scoped to the authenticated actor and project; it exposes only derived schedule times and source-timing metadata from an authorized, revision-pinned assessment. Source-reference revocation or an assessment/policy revision mismatch fails closed. All preview values remain transient. No secrets, raw source values, or outbound actions are added.

## Connector and permission impact

No connector calls or scope changes. No outbound send/dispatch. Spreadsheet proposals remain outside canonical source resolution. The PM escalation subject must be explicitly represented by a same-project responsibility and current project or portfolio grant.

## Open-source dependency impact

No new runtime dependency. Use the platform's IANA time-zone support and deterministic in-domain schedule logic.

## Implementation stages

1. Add the pure calendar/quiet-hour calculation and strict schedule schemas.
2. Extend persisted policy read/write and authorize same-project PM recipient at save time.
3. Add revision-pinned transient preview endpoint and project UI.
4. Add migration, upgrade/recovery manifests, traceability, and customer/operator documentation.
5. Obtain exact-candidate independent non-author review, pass exact-head Foundation and Documentation validation, merge, then confirm post-merge validation. Only then record AC-ADM-002 evidence in Issue #9; keep Issue #9 open and story totals unchanged.

## Test and evaluation plan

- Pure schedules: UTC and non-UTC zones, logical due vs eligible request, exact quiet-hour boundaries, weekday/weekend deferral, cross-midnight windows, offsets/order/bounds, holidays explicitly not skipped, DST gaps/overlaps, repeatability, and invalid-zone/time inputs.
- Integration: append-only policy revision, defaults for old rows, optimistic revision conflicts, arbitrary/non-PM recipient denial, removed responsibility, missing/revoked project/portfolio grant, cross-project denial, and preview access revocation/revision mismatch with no inserted preview or outbound work.
- Browser: save a bounded cadence/quiet-hours policy, assess at a pinned revision, preview the due/request/reminder/PM-stage times, and prove no dispatch or send is created.
- Run the repository-mandated build, architecture/contracts, unit/integration/recovery, lint, typecheck, browser, documentation, migration/upgrade and distribution checks.

## Rollback and recovery

Forward-only migration; do not mutate prior migrations or immutable policy/assessment rows. Roll back the application to code that ignores the new nullable/defaulted columns; preserve them for the forward-compatible recovery path. Use the repository's clean, prefix-upgrade, failed-migration recovery and restore procedures before resuming service.

## Progress log

- 2026-09-29: Read-only design review identified wall-clock, DST, PM scope, transient preview, revision-pinning, FR-ESC-002 scope, and legacy-default requirements.
- 2026-09-29: PR #101 HLT acceptance ledger merged to main as 353979d99de3bb46bff16f1321afb5e6f2a4fa8a after exact-head Foundation #521 and Documentation #566 passed.
- 2026-09-29: Implemented the cadence domain model, additive migration, PM responsibility/grant validation, revision-pinned transient preview endpoint, administrator UI, pure/integration/browser acceptance coverage, and upgrade/recovery documentation on exec/ac-adm-002-schedule. Exact-candidate hosted checks are pending.
- 2026-09-29: Preserved disabled defaults for pre-cadence policy clients, aligned PM subject validation to the canonical subject schema, distinguished canonical creation time from fact timestamps, and made a preview fail closed when any saved source dependency is no longer readable. Added browser evidence for source-access revocation. Exact-candidate hosted checks remain pending.

## Decisions made

- A source-authorized assessment provides the pinned source-date basis; clients cannot select or supply the source timestamp.
- The due threshold is elapsed time and is retained separately from a quiet-hour/weekend-adjusted initial request eligibility time.
- Reminder/escalation offsets are business-day offsets from the first request-eligible instant.
- One PM escalation is the bounded AC-ADM-002 slice. Channels, team-lead stages, customer holidays, and dispatch remain open work; FR-ESC-002 is not claimed complete.
- Existing open obligations continue to point to their original immutable policy revision. This preview does not claim or implement rescheduling behavior for a future dispatch.

## Risks and mitigations

- Time-zone rule changes can change a future preview: pin the IANA zone, policy revision, as-of instant and calculated UTC offsets in each transient response.
- A source reference can become inaccessible after assessment: recheck its current reader grant for every preview and fail closed on revocation.
- Preview may be confused with a sent reminder: label it as a preview, persist no schedule event, create no queue item and prove zero dispatch in browser/integration acceptance.
- FR-ESC-002's channels and full cascade remain incomplete: state this in the PR and keep downstream dispatch/channel behavior unchecked.

## Validation evidence

Pending implementation and exact-candidate/post-merge validation.

## Completion summary

AC-ADM-002 implementation and scoped evidence are not yet complete. Issue #9 remains open and no EPIC-05 story acceptance or accepted-story total is inferred.
