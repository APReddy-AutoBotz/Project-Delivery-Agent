# Authorized completeness input validation

Date: 2026-10-22
Plan: [EXEC-018](../04-delivery/exec-plans/EXEC-018-authorized-completeness-inputs.md)
Issue: https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/8
Requirements: FR-HLT-001, FR-HLT-002, FR-UPD-001, NFR-SEC-001, NFR-REL-003
Criteria: AC-HLT-001/002; this correction does not accept a complete story.

## Corrected boundary

`DatabaseProjectUpdateRepository.assessInTransaction` counts only versions marked
`available` by the complete authority result, independently of the current
authority selection. Readable but stale or policyless evidence is UNCONFIRMED;
genuinely absent values remain MISSING. Restricted placeholders never count.
Unresolved evidence earns no trusted timestamp, known-position value or source
satisfaction. Source selection, provenance, conflict and expiry rules are unchanged.

Historical assessments remain immutable as-of metadata under current project
scope. Current reads still redact protected references and values after source
revocation. A new assessment excludes those versions; it does not rewrite history.
No schema, migration, dependency, endpoint, connector scope or visual style changes.
No message or source write is issued. Spreadsheet imports remain proposals, live
Jira/OAuth remains disabled and research capture remains explicitly stopped.

## Regression coverage

The native repository suite uses real source sharing, authority policy resolution,
database assessment and persisted previews. Its eight cases cover no policy,
expired readable versions, restricted-only evidence, mixed visibility, a recorded
conflict whose versions expire, current revocation with unchanged history, empty
fact definitions/absent facts, and project/service denial without writes.

Assertions check returned and persisted classification, original project-created
freshness fallback, no known position or satisfaction credit, one stable open
obligation, empty persisted dependencies and matching value-free previews.
Case-insensitive synthetic markers and every source/version/evidence ID must be
absent from unresolved views and stored input/result/dependencies/preview.
Historical current reads suppress protected references while original rows remain
byte-for-byte equal as structured database values.

`scripts/test-database.mjs` explicitly includes the new suite. The existing
`tests/e2e/project-update.spec.ts` adds an API-to-saved-view browser regression for
readable evidence with no policy. Its displayed label must remain UNCONFIRMED,
with the existing reason and unsent-preview explanation; private values stay hidden.
Planned or prechecked cases are not passing execution evidence.

## Executed local checks

- All eight workspace packages build and typecheck successfully.
- Required lint and explicit native/browser test lint pass.
- Full unit regression: 1,824 tests across 105 files pass in 111.10 seconds with
  two workers and unchanged assertions/deadlines.
- Final standard regression after main reconciliation and browser-helper correction:
  **1,824 units/105 files pass in 82.32 seconds**. All eight packages build and
  typecheck; required and explicit test lint pass. Architecture verifies eight
  packages/97 source files; all 42 exact direct/override records pass registration.
  The unchanged audit threshold passes with zero high/critical and four moderate
  findings. Documentation validates 245 requirements, 91 criteria, 38 stories and
  142 test specifications. No assertion, deadline or threshold was weakened.
- Independent early coverage review found no implementation/API/fixture blocker;
  its privacy assertion requests were addressed and prechecked. Both design reviews
  approved SHA256 `43da45afb741369195c9eab3cbd1cb8d24fcfe5b09e13ce23d140ec2d8ec164a`.

The initial new Docker network creation failed because address pools were full,
before a volume/container was created. A new dedicated PostgreSQL 17.11 container
and private volume were then created on the default bridge at loopback port 51258,
with only postgres/template databases. The first native runner stopped at the
unchanged port guard before migrations/seed. An exclusive loopback 55432 bridge
to that dedicated server permits the unchanged harness; it fails if occupied and
does not stop or replace a service. Default local pdaa and unrelated resources are
untouched. Failed attempts/logs and isolated databases remain retained.

The corrected full native run passes **169 tests across 14 files** in 255.53
seconds, including all eight new completeness cases. The unchanged harness also
passes populated prefix-nine upgrade, 24-migration clean/repeat deployment, exact
84-business-table inventory, real synthetic seed and privilege/retention checks.
Its target is `pdaa_test_1792612255248` on the dedicated server. No default local
database was migrated, seeded, reset or restored.

Private work was preserved in a local checkpoint and reconciled onto verified
main `8de60639586bd572d5e34257d07b25e683605b96`; that main tree equals reviewed
PR #110 tree b2c1023b71fc10cbc7da954275b7e8d67cd35649. All three project-update
Playwright journeys pass in **22.1 seconds** on a separate clean synthetic target,
`pdaa_test_1792612870268`. The new no-policy saved API/browser case, existing
scheduled stale-preview case and cadence preview case pass without increasing
timeouts. Root visually inspected `artifacts/evidence-workflow-authorized-completeness.png`:
UNCONFIRMED/reason, zero confirmed facts, stale fallback and unsent value-free
preview are visible within unchanged Antigravity styling. Existing CI uploads its
evidence-workflow screenshot glob without a workflow change.

Final local gates pass. Exact-candidate reviews and complete fresh hosted CI
remain pending.
No passing credit is assigned to pending steps. Prior PR #110 results belong to
their own candidate and do not validate this correction.

The first expanded native run passed 168/169 tests across 14 files. Its conflict
fixture failed because project-update preparation calculates a conflict but does
not persist the separate authority-conflict ledger. The corrected fixture calls
the real authority capture API, checks its CONFLICTING delivery and positive ledger
count, then expires the policy. Assertions and production code are unchanged.
The corrected complete run above supplies the passing evidence; the failed log
remains retained without passing credit.
An initial documentation run rejected missing reverse test ownership; adding
INT-HLT-002 to both owning criteria produced a passing 245-requirement,
91-criterion, 38-story, 142-specification validation.

The first browser run reused the populated native fixture database: the new case
passed, while both existing policy-editor journeys failed. A separate clean target
passed the new and stale-preview cases but the cadence editor still timed out on
its disabled Save button, with incomplete trace diagnostics. These failed logs,
screenshots and available traces are retained separately. The shared browser helper
now waits for the real initial policy GET to finish before editing controlled fields,
avoiding a race with form hydration. The final clean run above passes all three
journeys with the original assertions and deadlines. Product form code is unchanged.

## Recovery and acceptance

Revert this reader/test/documentation correction through review and rebuild.
No migration rollback or data restoration is needed; immutable assessment history
retains its recorded classification. Ordinary hosted validation must still exercise
upgrade, exact recovery and packaged customer profiles on the final candidate.
Issue #8 remains open. Accepted totals stay R0 3/5, R1 2/33, overall 5/38 (13.2%).
All five distribution/legal/signing/security release holds remain open.
