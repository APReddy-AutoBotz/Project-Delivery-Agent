# EXEC-059: Approve a saved selected-project report

Status: In progress

Requirements: FR-RPT-005, FR-RPT-007, FR-RPT-010 and NFR-SEC-001.

GitHub issue [#13](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/13).

Leadership can request a decision on an exact saved report. Route the request
to the single currently assigned PM with project and evidence access. The PM
can approve or reject that exact version from the project page. The dashboard,
email preview and editable PowerPoint display the resulting approval state.

Reuse the report snapshot, existing decision shape and append-only audit
records. Recheck the saved evidence and PM assignment at decision time.
Repeated requests and matching decisions reuse their existing records.
The PM view shows readable pending requests first, then the most recent
readable decision.
An approval applies to the saved facts and generation timestamp. Distribution
requires a later increment.

Extend the existing browser journey to exercise the leadership request,
assigned PM review and exact approved output. Check rejection of an
unauthorized decision and a changed report ID. Reverting the routes and panels
disables new handoffs. Existing snapshots and decisions stay in the audit history.
