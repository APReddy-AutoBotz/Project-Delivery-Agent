# EXEC-071 Project report audit search

Issue #14 and STORY-034. FR-AUD-005, FR-AUD-006, FR-AUD-007, FR-RPT-009,
NFR-SEC-001 and NFR-PRV-004 apply with ADR-007.

Expose a read-only search over the existing project report audit events.
Require a current PMO administrator grant for the requested project. Filter
the existing append-only events by actor, action and time, and return a
bounded page in newest-first order. The event metadata identifies the report
snapshot and correlation without including the report, reply or source text.

Reuse the existing report approval and delivery browser journey to check the
saved events and access denial. Verify the API schema with the existing
serialized contract case. Other audit events and retention policy remain part
of STORY-034. Revert the read endpoint and its query to roll back. The audit
ledger uses its existing schema and retention policy.
