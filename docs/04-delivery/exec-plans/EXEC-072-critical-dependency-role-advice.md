# EXEC-072 Critical dependency role advice

Issue #11 and STORY-026. FR-ADV-001, FR-ADV-002, FR-ADV-003, FR-ADV-006,
FR-ADV-007, FR-ADV-008, FR-RPT-002, NFR-REL-003 and NFR-SEC-001 apply.
This implements the shared facts and role guidance in GOLDEN-012.

Reuse the current blocker-age observation and its evidence access checks.
Recognize critical dependencies only when the existing schedule policy names
the open canonical dependency and current evidence establishes its age.
Show the next configured, open milestone with a usable due date as separate
schedule context for the same project.

Reuse the PM action queue and leadership review. The PM sees the current
configured dependency owner when a scoped grant still authorizes that owner,
plus a forecast review suggestion. Leadership sees the intervention decision.
A Scrum Master sees impediment follow-up and sprint impact review through the
same blocker read and display. Scrum Master access requires an authenticated
role, a current matching grant and the sealed project assignment. Keep the
suggestions read-only.

Use the existing source-bound blocker test fixture to verify the same aged
dependency and upcoming milestone across the three audiences, including
what happens when a grant or evidence binding is unavailable. Preserve the
existing output for aged blockers outside the configured critical set.
Revert the advice and read route to roll back. Remove Scrum Master grants
before restoring an earlier database role constraint.
