# Project Update Cadence Validation

## Scope

AC-ADM-002 adds schedule configuration and a transient calculation over the latest source-authorized assessment pinned to the current immutable policy revision. This code does not create queue items, send reminders, activate Jira OAuth, or write canonical facts.

The policy records at most eight increasing reminder offsets in business days, one project-manager escalation, and optional local quiet hours. The configured freshness threshold remains an absolute UTC instant from the existing server-selected source timestamp and elapsed freshness window. Schedule rendering uses the project IANA zone, Monday-Friday days, start-inclusive/end-exclusive quiet hours, forward resolution through DST gaps, and the earlier instant for repeated local times.

A preview returns the current policy and assessment revision IDs, assessment as-of time, source date and basis, logical due instant, initial eligible request time, and each stage's UTC instant, local wall time, numeric offset, and recipient. Preview inputs contain no client-provided timestamp. Source reader permissions and the escalation recipient's current responsibility and read grant are checked server-side on save and preview.

## Historical revisions and recovery

Migration 202609290002_project_update_cadence adds columns with empty reminders, zero escalation, null recipient, and null quiet-hours defaults. Existing immutable revisions remain unchanged. The integration acceptance inserts a legacy-shaped revision without the new columns and verifies those defaults through the repository.

If migration application fails, stop release and follow the documented backup and restore procedure. Roll back application code by deploying a version that ignores the new columns; retain the migration and data for the forward fix. Do not rewrite old policy or assessment revisions.

## Executable evidence

- tests/project-update-schedule.test.ts covers weekday counting, weekend and quiet-hour deferral, cross-midnight windows, DST gaps/overlaps, bounds, invalid local dates, zones, and determinism.
- tests/project-update-schedule.integration.test.ts covers legacy defaults, append-only policy revisions, missing-grant and non-PM denials, current-recipient grant revocation, transient preview with no extra persisted preview row, and stale optimistic revisions.
- tests/e2e/project-update.spec.ts includes E2E-ADM-002 for policy configuration, browser preview, lack of send controls, repeatable preview, and fail-closed behavior after a policy revision change.
- Foundation validation runs build, lint, typecheck, unit/integration/recovery tests, database migrations, browser workflows, and production-boundary checks.

## Remaining requirements

This increment implements one PM escalation recipient and a schedule preview only. Channels, delivery, response handling, full team-lead escalation cascades, customer holiday calendars, and how a changed policy affects dispatch for an already-open obligation remain outside this acceptance slice. FR-ESC-002 remains only partially addressed.
