# EXEC-013: Persisted schedule overdue policy

Status: Complete  
Owner: Implementation controller  
Requirement IDs: FR-HLT-003, FR-HLT-009, FR-HLT-011, PR-005, BR-003, NFR-SEC-001, NFR-REL-003, AC-HLT-007  
GitHub issue: #8  
Target release: R1  
Last updated: 2026-09-29

## Objective

Complete AC-HLT-007 for persisted health assessments. Apply the deterministic overdue evaluator using an authorized project-scoped schedule policy. Preserve the selected canonical due-date field and value, local assessment date, timezone, effective threshold, and policy/rule revisions so each signal can be reproduced later.

## In scope

- Evaluate only sealed canonical milestone and work-item snapshots already used by health assessment persistence.
- Resolve a separately versioned project schedule policy containing an IANA timezone, a default overdue threshold, and optional per-target overrides.
- Preserve current behavior with an explicit UTC/one-local-day policy on migration; apply the same defaults to projects created after migration.
- Expose scoped policy reads and PMO-admin writes with optimistic revision checks, canonical target validation, and audit events.
- Persist the policy snapshot and effective rule inputs in new assessment envelopes. Keep old assessments readable under their original rule revision.
- Add a PMO policy editor and render saved schedule-overdue evidence in the health assessment panel.
- Update runtime and published OpenAPI contracts, traceability, integration coverage, and Playwright proof.

## Out of scope

- Reading import proposals, connector records, or spreadsheet rows as schedule facts.
- Publishing proposals as canonical facts.
- Jira/OAuth onboarding, public callbacks, live Jira activation, or connector permission changes. Per OD-013, live onboarding remains disabled and AC-CON-001 remains partial.
- Changing reported health status, delivery-health bands, blocker-age authority, thresholds, or replay semantics.
- Reusing ProjectUpdatePolicyRevision timezone, adding runtime dependencies, or adding customer-specific branches.

## Current state

The pure evaluateOverdueSignals domain evaluator already handles local calendar-day boundaries and DST. Persisted health composition still uses UTC with a fixed one-day threshold, so it does not apply project-local dates or saved project schedule configuration. Assessment persistence uses immutable envelopes and command receipts; import proposals are not a schedule source.

## Proposed design

Use a new append-only ScheduleHealthPolicyRevision table, keyed by customer, project, and revision. Keep this policy separate from update-freshness configuration because those rules serve different purposes. Store timezone, default minimum overdue days, per-target overrides, author, and timestamp. Existing projects receive revision 1 with UTC and one day; projects with no row use implicit SYSTEM_DEFAULT revision 0 with the same effective values (not a user-authored policy). The existing sealed canonical graph is immutable, so a target type/key resolves to one stable target for the life of that project.

Only a server-authorized PMO administrator with project access may change this policy. A write requires expectedRevision, validates the timezone and bounded thresholds, and accepts overrides only for existing canonical milestone/work-item keys. A transaction-scoped exclusive lock serializes policy changes with assessments; assessment creation holds the matching shared lock while it snapshots the current policy and canonical dates. Replays return their saved envelope without recomputation.

The domain assessment calls the existing deterministic overdue evaluator using server time and the policy loaded by the repository. It records the server-derived top-level assessedAt as the evaluator's as-of time, plus the selected forecast/planned due-date field and value, canonical target type/key/record ID/project revision, local assessment date, timezone, effective threshold, days overdue when calculable, policy revision, and rule revision for active, clear, and unassessable targets. The evaluator does not load proposals or call a provider. A versioned rule keeps historical assessments interpretable.

The web panel exposes the policy editor to PMO administrators and shows saved signal inputs to users already authorized to read assessments. Runtime and published OpenAPI contracts stay aligned. Public OAuth onboarding and live Jira activation remain disabled under OD-013.

## Files and modules expected to change

- packages/domain/src/health-assessment.ts and packages/domain/src/overdue-signals.ts: policy contracts, deterministic evaluator composition, and local-calendar day differences.
- packages/data/src/health-assessment.ts and packages/data/src/blocker-age-assessment.ts: scoped revision reads/writes, serialized snapshots, test-only fixed-as-of injection, audit, and persistence.
- packages/data/prisma/schema.prisma and a new additive migration: revision storage, compatibility defaults, and accepted assessment rule revision.
- apps/api/src/health-assessment-controller.ts and apps/api/src/contract.ts: policy endpoints and strict contracts.
- apps/web/src/health-assessment.tsx: authorized editor and saved evidence presentation.
- docs/03-architecture/OPENAPI_FOUNDATION.json: published contract.
- docs/03-architecture/adr/ADR-015-PROJECT-SCHEDULE-OVERDUE-POLICY.md: separate project-policy architecture decision.
- docs/03-architecture/DEPLOYMENT_AND_OPERATIONS.md and docs/06-commercial-deployment/FOUNDATION_OPERATIONS.md: configuration and upgrade/recovery guidance.
- .github/workflows/foundation-validation.yml: publish the new browser proof artifact.
- tests/schedule-health.test.ts, tests/blocker-age-assessment.integration.test.ts, tests/api-contract.test.ts, and tests/e2e/project-evidence.spec.ts: evaluator, persisted boundary/replay/authorization, contract, and browser behavior.
- scripts/acceptance/ingestion-prefix-nine-upgrade.mjs and scripts/test-database.mjs: existing-project backfill and table-privilege assertions.
- scripts/rehearse-recovery.mjs: immutable backup/restore comparison for the new policy table.
- requirements/traceability/acceptance-baseline-gates.yaml, requirements/traceability/tests.yaml, docs/04-delivery/ACCEPTANCE_CRITERIA.md, this plan, and governance records.

## Data model or migration impact

Add an immutable, project-scoped policy revision table with bounded JSON overrides, a composite project/customer foreign key, and a latest-revision index. Backfill preexisting projects to UTC/one-day revision 1. New projects without a revision use the identical revision-0 default. Widen health-assessment rule/coverage checks without rewriting prior rows. Grant the API role only SELECT/INSERT, deny worker access, and grant backup read access. Migration remains additive; never rewrite a released migration.

## Security and privacy impact

The API checks identity and project authorization server-side. Policy writes additionally require the PMO-admin role and validate each override against a canonical target in the same customer/project. Clients cannot submit assessment time, canonical dates, health results, or one-off policies for assessment. Audit details contain configuration metadata only. Proposal contents and secrets are not read or logged.

## Connector and permission impact

No connector scopes, credentials, OAuth callbacks, source reads, or external writes are added. Live Jira activation remains disabled.

## Open-source dependency impact

No dependency is added.

## Implementation stages

1. Complete domain policy schemas and deterministic evaluator composition with saved rule inputs.
2. Add additive policy persistence, compatibility defaults, scoped service methods, and transactional revision handling.
3. Add API/OpenAPI contracts and the PMO editor/evidence view.
4. Add unit, database integration, API contract, and browser acceptance evidence; run hosted validation on the exact candidate.
5. Obtain separate non-author exact-candidate review; resolve findings and re-run required gates before merge.
6. After merge, verify post-merge gates, update issue acceptance/evidence, and record recovery and final status without closing Issue #8 or claiming story acceptance.

## Test and evaluation plan

- Unit boundary tests cover timezone local midnight, DST-safe calendar-day comparison, forecast-over-planned precedence, target overrides, missing dates, and configured signal inputs.
- Database integration tests cover implicit revision-0 defaults, a populated-prefix upgrade proving revision-1 UTC/one-day backfill for an existing project, a test-only fixed clock through the persisted repository for local-midnight and threshold boundaries, active/clear/unassessable saved targets, canonical record/revision provenance, PMO/project-scope denials, invalid timezone/target, concurrent expectedRevision writes, assessment/policy serialization, replay after a policy change, and schedule-policy table ACL.
- API contract tests cover policy reads/writes and invalid requests.
- Playwright covers PMO configuration, a saved assessment using that revision, visible canonical due-date/threshold evidence, and a screenshot artifact.
- Run Foundation and Documentation workflows on the exact candidate. Foundation includes build, architecture/contracts, lint/typecheck/unit, migration/seed, integration, recovery, and browser workflows. Post-merge gates remain required.

## Rollback and recovery

The migration is additive and preserves existing records. If candidate code must be rolled back, retain the new table and widened constraints. The prior application version ignores policy revisions and resumes UTC/one-day evaluation. Use that rollback only while all projects remain at equivalent defaults. If any non-default schedule policy exists, keep the API service offline during rollback and do not restore assessment traffic to the prior evaluator. Resume only after compatible evaluator code is deployed or a forward fix is in place. Do not drop policy revisions or alter assessment history during rollback. Use the established encrypted backup/restore workflow for database recovery, then run repository recovery and integrity checks. Prefer a forward fix after the new revision table contains policy data.

## Progress log

- 2026-09-29: Confirmed the pure evaluator exists and the persisted health path bypasses it. Reused the independently reviewed recommendation for a separate project-scoped policy; implementation is in progress.
- 2026-09-29: Added versioned policy/evaluator integration, scoped persistence/API contracts, additive migration, admin presentation, and unit/integration/API traceability. Browser proof and independent final review remain required.
- 2026-09-29: Exact-candidate review and hosted Foundation/Documentation checks passed. PR #100 merged candidate `6078da2ed075afff95a45fb951d5b9143c58b3df` as `4fc8c4a4ae4974d5ff5691acf643c82ea7bdb019` with an identical reviewed tree; post-merge Documentation passed. Post-merge Foundation #519 passed after a targeted retry of the bundled restore check. AC-HLT-007 acceptance evidence and AC-HLT-006 provider-disabled evidence are recorded; Issue #8 remains open.

## Decisions made

- Keep schedule-health timezone independent from update-freshness timezone.
- Preserve historical and migrated behavior as UTC with a one-day local calendar threshold.
- Store policy revisions append-only and snapshot the revision into each new assessment.
- Require PMO-admin authority plus project scope for writes, optimistic revision checks, and existing canonical targets for overrides.
- Keep import proposals outside the health input and preserve OD-013's disabled live-onboarding boundary.

## Risks and mitigations

- Local dates differ from UTC and daylight-saving transitions can create short/long days. Use the date-only evaluator and assert local-calendar boundaries, not elapsed hours.
- A policy change racing an assessment could create ambiguous provenance. Share the project-scoped transaction lock; the assessment stores the exact loaded revision.
- An invalid or stale override could mislead readers. Validate IANA zones and bounds in the domain schema, and validate target existence in the authorized project transaction. Canonical schedule keys cannot be reused in the current sealed immutable graph; any future target replacement/mutability must bind overrides to stable record IDs and revisions.
- Old assessments lack a new policy snapshot. Keep the old rule revision supported and present the UTC/one-day fallback only for those historical envelopes.

## Validation evidence

Independent non-author review approved exact candidate `6078da2ed075afff95a45fb951d5b9143c58b3df` with no blockers. It recorded one non-blocking duplicate latest-revision index. Exact-head [Foundation #518](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/36531184293) and [Documentation #560](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/36531184311) passed. Verified merge `4fc8c4a4ae4974d5ff5691acf643c82ea7bdb019` preserves candidate tree `7931c1ec963441532ac109df93de068591be0fd5`; post-merge [Documentation #561](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/36547688711) passed. Post-merge Foundation #519 passed on attempt 2 after the first production-boundary attempt stopped in bundled customer restore at `sessions_before_commit`; see [attempt 2](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/36547688703?attempt=2). Verify passed on both attempts. Successful test evidence covers persisted policy backfill/revision 0, timezone/local-midnight thresholds, saved due-date and rule inputs, policy replay, browser presentation, migration, upgrade, restore and production boundary. CI artifacts are retained on the linked workflow run, including `schedule-overdue-policy-browser`, `production-boundary-evidence`, and distribution evidence.

The HLT-specific behavior for AC-HLT-005 is also verified by the passing source-authorized HTTP integration and assigned-PM browser case; its traceability entry maps those results. The composite GOLDEN-003 remains planned because it additionally requires AC-QA-005 shared-answer behavior. AC-HLT-006's provider-disabled unit and persistence integration passed. Issue #8 records AC-HLT-006 and AC-HLT-007 after this evidence update, remains open, and accepted-story totals remain unchanged.

## Completion summary

AC-HLT-007 implementation and required execution/recovery evidence are complete. AC-HLT-006 provider-disabled reproducibility evidence is complete. This plan does not close Issue #8, accept STORY-013/014/015, alter accepted-story totals, enable live Jira/OAuth onboarding, or approve customer activation.
