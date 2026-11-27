# EXEC-066 PMO portfolio freshness

Issue #13, STORY-030, FR-RPT-003, AC-RPT-006 and NFR-SEC-001.

Add an overview to the existing project workspace for PMO and portfolio
managers. List projects with a current matching project or portfolio grant.
Use the existing read-only update assessment to show the current cadence,
open update needs, missing facts, stale facts and unresolved conflicts. Use
the configured update policy and the viewer's current evidence permissions.

Read one page of ten projects, in stable project ID order. Bind the cursor and
response to the active browser identity. Hold the existing project and grant
locks through each page read. A project without a policy shows that state.
When an assessment cannot safely be disclosed, show that it is unavailable.
Show the recorded due date for a readable open obligation that matches the
current cadence or a still-active cycle. Use the cadence evaluator's due date
for an overdue update before its obligation is recorded. Show the last
verified update only when the evaluator has verified input dates.

Verify one real PMO session with authorized and hidden projects, a missing
or stale update, a conflicting required fact, and a project link. Confirm
role denial and run the existing exact API serialization and required CI
checks. Recovery is to revert the overview; it performs read-only queries.
