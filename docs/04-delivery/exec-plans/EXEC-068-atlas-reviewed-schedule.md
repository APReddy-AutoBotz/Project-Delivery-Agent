# EXEC-068 Atlas reviewed schedule evidence

Issue #14, AC-PRO-001, E2E-HERO-001, BR-004/005, PR-001 through PR-006,
FR-CON-006/007 and FR-EVD-003/004/006/007/009. ADR-007 and ADR-009 apply.

Bind the Atlas schedule to the exact portfolio row selected in the existing
reviewed CSV import. Use the sealed Atlas source mapping to identify the row
and reuse receipt integrity and current source readers inside the project
transaction. Hold the retention policy while reading the receipt and its
availability deadline. Require two typed dates that match the approved
canonical schedule revision. Unavailable, ambiguous or conflicting reviewed
evidence prevents the configured Atlas answer from using those dates. The
Jira blocker and integration milestone are evaluated with their own evidence.
Earlier
Atlas fixtures without that mapping retain their canonical schedule behavior.

Show the reviewed receipt in the existing schedule citation. Keep the receipt
identity with any new frozen Atlas snapshot and recheck access to the same
receipt before opening, approving or distributing it. No imported row directly
writes a canonical fact. The normal CSV import, general field authority and
production connector scope continue through their own approved workflows.

Extend the existing native Atlas journey with one scoped source revocation
and restoration before report approval. Verify the existing receipt and dates
in the answer, withholding after revocation and the exact saved report after
restoration. Roll back the Atlas resolver and use a fresh synthetic fixture.
