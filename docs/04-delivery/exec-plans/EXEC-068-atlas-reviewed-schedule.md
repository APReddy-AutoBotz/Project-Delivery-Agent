# EXEC-068 Atlas reviewed schedule evidence

Issue #14, AC-PRO-001, E2E-HERO-001, BR-004/005, PR-001 through PR-006,
FR-CON-006/007 and FR-EVD-003/004/006/007/009. ADR-007 and ADR-009 apply.

Bind the Atlas schedule to the exact portfolio row selected in the existing
reviewed CSV import. Use the sealed Atlas source mapping to identify the row
and reuse receipt integrity and current source readers inside the project
transaction. Hold the retention policy while reading the receipt and its
availability deadline. Read both typed dates from the authorized reviewed row
and calculate movement from those dates. The sealed Atlas mapping supplies dates
that the project leaves unset. Reviewed values must agree with any populated
canonical date because existing approvals are bound to the project revision.
Unavailable, ambiguous or disagreeing rows leave the schedule unavailable. The
Jira blocker and integration milestone use their own evidence. Earlier fixtures
without the mapping retain the canonical schedule.

Show the reviewed receipt in the existing schedule citation. Keep the receipt
identity with any new frozen Atlas snapshot and recheck access and exact saved
dates against that receipt before opening, approving or distributing it. The
project and source locks keep the candidate row stable during the assessment.
Reviewed imports remain proposals in the general CSV workflow. Canonical facts
and connector scopes keep their existing approval paths.

The native Atlas journey leaves the two canonical finish dates unset. Check that
the leadership answer and frozen report derive both dates from the reviewed
spreadsheet and the canonical record retains its unset dates. Reuse the source
revocation and restoration to verify withholding and scope. Roll back the Atlas
resolver and use a fresh synthetic fixture.
