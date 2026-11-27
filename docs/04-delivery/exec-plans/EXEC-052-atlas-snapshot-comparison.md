# EXEC-052 Atlas snapshot comparison

- Status: In progress
- Requirements: FR-QA-006 and FR-QA-010
- Evidence: freshness portion of AC-QA-004, AC-QA-008 and INT-QA-008
- GitHub issue [#12](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/12)

Let an authorized Atlas leader select a saved snapshot by ID and compare it
with the current Atlas answer. Show changed schedule, access, simulated
action, and PM assessment values with their respective evidence. Mark
unavailable values explicitly.

Read the live answer and selected same-project snapshot under the existing
Atlas project lock. Reuse report origin authorization and current retention
checks. The comparison exposes the same structured facts through the existing
leadership answer route. It changes no snapshot, approval or delivery state.

Show the latest saved update freshness for the current project policy in the
live answer. Present the saved assessment time, its age basis and whether an
update remains due. Use the existing Atlas project scope and return only the
assessment metadata to leadership.

Use the saved Atlas browser fixture to verify a change after a later owner
reply and comment, plus access denial. Verify that the answer identifies the
stale update evidence alongside the source-authorized Jira blocker. Run the
existing contract suite and required hosted checks. Reverting removes the
optional projections.
