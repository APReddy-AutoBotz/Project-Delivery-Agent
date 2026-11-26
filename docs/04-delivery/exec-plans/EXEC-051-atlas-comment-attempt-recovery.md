# EXEC-051 Atlas comment attempt recovery

- Status: In progress
- Target: Release 1 controlled action
- Requirements: FR-WRB-004, FR-WRB-007, FR-WRB-008, FR-APP-007, FR-APP-008
- Evidence: AC-WRB-002, INT-WRB-002, FAIL-015
- GitHub issue [#10](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/10)

The Atlas flow already binds a PM's approval to the proposed comment and
fixture revision. Persist one attempt before dispatching the approved comment
to the same fixture. The fixture stores the action marker and payload digest
before the application records the receipt. A repeated command checks for that
exact effect. Without a matching effect, the original attempt stays open for
verification, and the command cannot post again.

Reuse the Atlas project lock and PM assignment to recheck the approval, reply
and fixture revision before submission. Keep the separate application
receipt and synthetic fixture effect in the existing audit ledger. They
contain event references and digests. The existing proposal retains the
approved text. No schema migration or network service is required.

Check the existing Atlas browser workflow and add a focused recovery check
at the boundary between the synthetic fixture effect and its receipt.
Preserve existing receipt decoding and reapproval on a changed fixture.
The proof applies to the synthetic fixture. Real Jira connector permissions,
lookup completeness and live approval decisions remain release gates.

If recovery cannot establish the marker and digest, leave the attempt
unresolved for manual verification. On rollback, the existing receipt
projection can still read finalized comments. Verify any unresolved synthetic
attempt before re-enabling its workflow.
