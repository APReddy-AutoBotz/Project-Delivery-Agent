# EXEC-060: Deliver a selected-project report in-app

Status: In progress

Requirements: FR-RPT-004, FR-RPT-005, FR-RPT-007, FR-RPT-009, FR-RPT-010 and NFR-SEC-001.

GitHub issue [#13](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/13).

The assigned PM can deliver an approved report to its requesting leader.
Bind delivery to the exact snapshot, request and recorded approval. Check both
users’ current project and evidence access before recording delivery. Reuse a
matching receipt on retry.

The requesting leader can open the latest delivered version for the selected
project. Render the saved facts and original generation time in each output.
The in-app delivery record carries the exact report identifiers and time.
The PM view shows readable approval requests first, then approved reports
ready for delivery, followed by recent decisions and receipts.

Extend the existing browser journey to deny delivery before approval, deliver
the approved version, retry the action and reopen the same delivered report
after a different draft has been saved and a newer freshness assessment
recorded. Verify the delivered dashboard, email preview and editable deck.
Revert the delivery route and panel
controls to disable the feature. Existing receipts remain in the audit history.
