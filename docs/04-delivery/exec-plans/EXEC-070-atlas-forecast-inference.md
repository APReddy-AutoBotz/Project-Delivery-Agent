# EXEC-070 Atlas forecast risk inference

Issue #12, STORY-029, FR-QA-005, FR-QA-009 and AC-QA-003.

The Atlas leadership answer can flag a possible forecast risk when its
authorized schedule shows a later forecast, integration started late, and
the current Jira blocker is still open. Use the same current evidence
already returned by the answer. Label the forecast risk as agent inference
and include its exact schedule, milestone and Jira references. Keep the
reviewer's verified cause and confidence independent.

Show the inference in the current answer. The existing report uses its
approved facts. No model call, data write or connector change is involved.
Extend the current Atlas browser journey to verify the label and evidence
and to withhold the inference after Jira or schedule access is removed.
Revert the answer field and its rendering to roll back.
