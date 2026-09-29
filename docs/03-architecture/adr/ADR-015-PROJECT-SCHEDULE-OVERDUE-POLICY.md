# ADR-015: Project-local schedule overdue policy

Status: Accepted under delegated controller authority; exact implementation review required
Date: 2026-09-29
Requirement IDs: FR-HLT-003, FR-HLT-009, FR-HLT-011, AC-HLT-007, NFR-SEC-001, NFR-REL-003

## Context

The deterministic overdue evaluator already supports local calendar-day boundaries and time zones, but the persisted health assessment path has used a fixed UTC/one-day rule. ProjectUpdatePolicyRevision also has a timezone, but that setting controls update freshness and scheduled scans. Reusing it for overdue health would couple separate policies and could change existing update behavior.

## Decision

Store schedule-health policy in a separate append-only project-scoped ScheduleHealthPolicyRevision table. Each revision contains a validated IANA timezone, a default minimum overdue local-calendar-day threshold, optional bounded overrides by canonical milestone/work-item key, the author, and change time.

Use UTC and a one-day threshold as an implicit SYSTEM_DEFAULT revision 0 for new projects without a stored user policy. Backfill existing projects to revision 1 with those same values so pre-migration behavior remains stable. The existing sealed canonical graph is immutable, so a target type/key resolves to one stable record for that project's lifetime. Only an authenticated PMO administrator with project access may write policy; writes use expectedRevision, canonical target validation, a serialized transaction, and an audit event. Readers require project authorization.

The server loads the current policy and sealed canonical schedule in the same assessment transaction. It stores server-derived assessedAt (the evaluator as-of time), the exact policy revision, rule revision, selected canonical due-date field/value and target record ID/project revision, local assessment date, timezone, effective threshold, and computed overdue days in the immutable assessment envelope. A replay returns the original envelope. Import proposals, spreadsheet rows, AI output, and connector records are not inputs.

## Consequences

- A policy change affects only new assessments. Existing assessment evidence and idempotent replays remain interpretable under their stored rule revision.
- Forecast end remains the selected due date when present; planned end is used otherwise. Missing dates remain unassessable and completed/cancelled records do not become overdue.
- Project schedule policy remains independent of update freshness and does not write canonical schedule facts.
- The migration is additive. Application rollback may retain the new table and constraints. The prior evaluator resumes UTC/one-day behavior and ignores non-default policies. If any project has a non-default policy, keep the API service offline during rollback and do not restore assessment traffic to the prior evaluator. Resume only after compatible evaluator code is deployed or a forward fix is in place. Deleting revisions or rewriting old assessments is not a supported rollback.
- No connector scope, Jira/OAuth onboarding, public callback, external write, or live activation is enabled. OD-013 remains in force.

## Alternatives considered

1. Reuse ProjectUpdatePolicyRevision.timeZone and extend that policy with overdue thresholds. Rejected because update freshness, scheduled scan timing, and overdue calculation have different semantics and change cadence.
2. Keep the fixed UTC/one-day evaluator. Rejected because configured local calendar-day behavior would not reach persisted health assessments and would not satisfy AC-HLT-007.
3. Accept timezone and threshold from the assessment request. Rejected because callers must not select rule inputs for a health result; the server must load the authorized policy and persist its provenance.

## Validation

The exact implementation candidate remains subject to independent review, exact-head Foundation and Documentation checks, migration/upgrade/recovery validation, and browser evidence before merge. This ADR records the bounded architecture decision; it does not accept AC-HLT-007, close Issue #8, accept a story, enable live connectors, or authorize customer activation.
