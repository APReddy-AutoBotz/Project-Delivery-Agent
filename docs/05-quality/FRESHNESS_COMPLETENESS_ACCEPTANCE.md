# Freshness and completeness software acceptance

Status: software acceptance decision; effective after this reviewed acceptance increment merges.
Date: 2026-10-22
Story: STORY-013 / EPIC-04
Issue: https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/8
Requirements: FR-HLT-001, FR-HLT-002, FR-UPD-001
Criteria: AC-HLT-001 and AC-HLT-002

## Scope and authority

The implementation controller's existing delegated authority permits acceptance
of complete software stories after original evidence, independent review and
required merge gates pass. This record accepts the complete software contract,
subject to the metadata gates below.

STORY-013 detects overdue updates and missing required facts, and prepares the
contextual due request. It does not include delivery, reply interpretation,
approval, leadership answers or the shared GOLDEN-003 remainder. Those contracts
remain with their existing stories and test ownership.

## Complete requirement evidence

| Requirement | Executed original behavior |
| --- | --- |
| FR-HLT-001 / AC-HLT-001 | Deterministic rules apply the exact freshness boundary, authorized trusted source timestamps and conservative fallback. A stale project persists the configured due obligation; policy revision and repeated scans do not duplicate it. The signed scheduler and saved browser workflow exercise the real application path. |
| FR-HLT-002 / AC-HLT-002 | The result lists every configured required fact and its missing/unconfirmed reason. Eight native cases cover absent, policyless, stale, conflicting, restricted and mixed evidence. The saved API/browser workflow shows zero confirmed facts for an available unconfirmed input, and excludes private evidence values. |
| FR-UPD-001 | The durable due obligation retains an unsent request preview with project context, authorized current known position and exact missing information. E2E-UPD-001 and populated recovery exercise the persisted result. |

The original accepted criterion implementation and PR #96/#97 gate ledger are in
[EXEC-012](../04-delivery/exec-plans/EXEC-012-update-freshness-and-completeness.md).
The original tests include `tests/freshness-signals.test.ts`,
`tests/completeness-signals.test.ts`,
`tests/project-update-policy-binding.integration.test.ts` and
`tests/e2e/project-update.spec.ts`. Schedule configuration and transient preview
are separate supporting [cadence evidence](PROJECT_UPDATE_CADENCE_VALIDATION.md).
The subsequent available-evidence correction and its eight native cases are
recorded in [authorized completeness validation](AUTHORIZED_COMPLETENESS_VALIDATION.md).
The durable connector-to-assessment handoff, source-revocation races, crash/retry
lineage and exact populated restore are recorded in
[ingestion assurance validation](INGESTION_ASSURANCE_VALIDATION.md).

Applicable Definition of Done evidence includes current server authorization,
deterministic rules without an AI provider, immutable audits, generated REST
contracts, saved browser journeys, additive migrations, exact recovery,
documentation and independent source/coverage reviews. This record introduces
no new runtime code, dependency, schema, privileges or connector scope.

## Immutable source and gates

This whole-story audit uses merge
`58da66bcb4d2db78b5d7f3e1e6adf8ffdaced758` from
[PR #112](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/112).
Its ordered parents are `7f70063d8a689d66042de93b2537402538eb8423`, then
reviewed candidate `fbad59b97f444ba6b8a69bf8767d8a4e14b950d4`.
The actual tree equals reviewed `1a6115c0f6100723cd0f31507bd6d0e37e6dbdbc`.

Exact-candidate [Foundation 39725089999](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/39725089999)
and [Documentation 39725089928](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/39725089928)
pass: 1,855 unit tests, 200 native tests, 44 browser tests, fresh role-absent/API-only
bootstrap, exact 85-table migration/recovery, packaged production and both
bundled/external customer upgrade/restore profiles, plus distribution evidence
collection and manifest validation. Passing collection does not approve release.

Post-merge [Foundation 39727701669](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/39727701669)
and [Documentation 39727701670](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/39727701670)
pass on the actual merge. Both native verification and production/customer/
distribution jobs succeeded. Independent complete-story audits find no remaining
behavioral gap in this story's canonical requirements. The delegated controller
records software acceptance, effective only after this documentation increment's
independent exact-candidate review, required checks and verified merge. Those
metadata gates do not replace the already successful implementation gates.

## Limits and recovery

Public OAuth onboarding, callback exposure and live activation remain disabled
under OD-013; comment reads remain disabled under OD-014. Connector/import values remain reviewed
proposals and do not become canonical evidence. Requests remain unsent; no email
delivery, interpretation, approval or external write is accepted here.

Issue #8 stays open for AC-HLT-005's shared GOLDEN-003 remainder, including
AC-QA-005 answer work. Issue #9 stays open for engagement and interpretation. STORY-012/014/015 and the
other unfinished stories retain their existing criteria and dependencies. The
older EXEC-012 increment's withheld story status is historical, not a removed
requirement. All five release/security/customer holds remain open. Original19/20
research capture remains stopped.

For application recovery, revert through review while retaining compatible
schema and immutable history. Restore into a separate quarantined database with
runtime CONNECT denied, then validate current scope and retained lineage before
activation. For this documentation increment, use a reviewed traceability revert
if its decision is withdrawn; no data rollback is necessary.
