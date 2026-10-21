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

Native integration, browser, documentation, final exact-candidate reviews,
reconciliation against verified main and complete fresh hosted CI are pending.
No passing credit is assigned to pending steps. Prior PR #110 results belong to
their own candidate and do not validate this correction.

The first expanded native run passed 168/169 tests across 14 files. Its conflict
fixture failed because project-update preparation calculates a conflict but does
not persist the separate authority-conflict ledger. The corrected fixture calls
the real authority capture API, checks its CONFLICTING delivery and positive ledger
count, then expires the policy. Assertions and production code are unchanged.
A fresh complete run is required; the failed log remains retained.
An initial documentation run rejected missing reverse test ownership; adding
INT-HLT-002 to both owning criteria produced a passing 245-requirement,
91-criterion, 38-story, 142-specification validation.

## Recovery and acceptance

Revert this reader/test/documentation correction through review and rebuild.
No migration rollback or data restoration is needed; immutable assessment history
retains its recorded classification. Ordinary hosted validation must still exercise
upgrade, exact recovery and packaged customer profiles on the final candidate.
Issue #8 remains open. Accepted totals stay R0 3/5, R1 2/33, overall 5/38 (13.2%).
All five distribution/legal/signing/security release holds remain open.
