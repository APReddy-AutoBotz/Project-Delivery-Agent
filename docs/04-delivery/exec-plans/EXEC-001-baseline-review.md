# EXEC-001: Correct and approve the implementation baseline

Status: In Progress
Owner: Implementation controller under Product Owner delegation
Requirement IDs: FR-EVD-003, FR-ADM-001, FR-ADM-002, FR-ADM-003, NFR-SEC-001, NFR-SEC-004, NFR-MNT-004, TR-AUTH-001, FR-UPD-010, FR-WRB-004
GitHub issue: https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/1
Target release: R0
Last updated: 2026-09-06

## Objective

Resolve the five accepted controller findings and material baseline contradictions, validate the implementation contract, and complete Issue #1 before platform implementation.

## In scope

Bootstrap recovery, delegated approval, security dependency order, orthogonal fact state, independent commit-specific review, specialist baseline review, requirement/acceptance/test traceability and bounded Release 1 decisions.

## Out of scope

Production feature implementation, customer data, live messaging, commercial agreements and changes to repository visibility.

## Current state

The workspace contained a ZIP, Git bundle and SHA256 manifest, with no checkout. Both supplied hashes matched. The bundle head was 0eb61161fb8699050ee1ef62bcec51e7a315cd32. A checkout was restored in `project-delivery-agent`; public Git fetch then obtained the newer GitHub main at affdbae. CLI authentication fails with HTTP 401; the authenticated GitHub connector can inspect Issue #1 and repository metadata. No existing user changes were present.

The system Python initially could not run the validator because PyYAML was absent (exit 1). After installing the repository-pinned PyYAML 6.0.2 in `.venv`, the unchanged baseline returned exit 0: `Validated 245 requirements, 67 acceptance criteria and 38 stories.` It warned that 87 R1 Must requirements lacked direct acceptance criteria, then printed `Documentation validation passed.`

## Proposed design

Retain the modular TypeScript monolith. Correct its contracts before scaffolding: implement authentication/authorization/secret controls in foundation, retain provenance when freshness/conflict change, bind human approval to an exact proposal revision, and reconcile uncertain side effects before retry or restore replay.

## Files and modules expected to change

Controller, governance, affected product/requirements/architecture/quality documents, ADRs, structured catalogs, traceability and documentation validator.

## Data model or migration impact

Documentation only. Specify fact provenance separately from freshness and conflict before the first migration exists.

## Security and privacy impact

Make security a prerequisite for real-data ingestion, prohibit model-granted approval, and preserve deny-by-default scope in requests, workers and evidence retrieval.

## Connector and permission impact

No new customer connector scopes. GitHub operations use the existing repository authorization. R1 external project writes are limited to approved Jira comments.

## Open-source dependency impact

PyYAML 6.0.2 is the existing pinned documentation dependency. Runtime packages remain subject to version, license and maintenance verification before installation.

## Implementation stages

1. Inspect current GitHub and local state; record baseline validation.
2. Review A/B/I, D/E/F and C/G/H perspectives in three parallel read-only specialist assignments.
3. Resolve findings, record scope decisions and strengthen validation.
4. Review the immutable candidate with a separate reviewer agent; fix justified findings.
5. Publish the review PR, verify checks on its final SHA, merge and complete Issue #1.
6. Prepare and merge the master plan, then implement EPIC-01 in a separate branch.

## Test and evaluation plan

Documentation validator plus regression tests for approval coverage, invalid IDs, missing test references and story coverage. Planned product tests must remain explicitly planned; a catalog entry is not test execution evidence.

## Rollback and recovery

Revert this documentation change through a PR if necessary. Preserve the original bundle and ZIP. No production data or schema has changed.

## Progress log

- 2026-09-06: Verified supplied artifacts; restored checkout; read live Issue #1; obtained current main; ran baseline validator; started three specialist review assignments covering all nine requested perspectives.

## Decisions made

The user's instruction to apply the five corrections and begin implementation delegates routine baseline/ADR approval after evidence-based gates. Commercial/legal choices and external customer side effects retain their stated approval boundaries. Delegation does not constitute a claim that review, CI or merge already passed.

## Risks and mitigations

CLI authentication remains invalid; use the connected GitHub capability where available. Keep all review and checks tied to the final candidate SHA and never mark planned tests as passing.

## Validation evidence

Baseline validator result recorded under Current state. Final results pending.

## Completion summary

In progress; Issue #1 remains open.

## Candidate validation update

- All nine specialist perspectives complete; findings/corrections recorded in ASTRA_BASELINE_REVIEW.md.
- Corrected catalogs: 245 requirements, 91 criteria, 38 stories, 135 explicitly planned tests; no R1 Must direct acceptance gaps.
- Thirteen validator regression tests pass; candidate validation and exact-commit independent review/remote checks follow before merge.
