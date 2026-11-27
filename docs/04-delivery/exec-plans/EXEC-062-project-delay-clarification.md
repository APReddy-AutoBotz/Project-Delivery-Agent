# EXEC-062: Ask the assigned PM for delay evidence

Status: In Progress
Requirement IDs: FR-QA-006, FR-QA-008, FR-QA-009, FR-QA-012 and NFR-SEC-001.
GitHub issue: [#12](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/12).
Target release: R1
Last updated: 2026-11-27

An authorized leader can ask about a verified positive schedule movement when
the cause is unknown. Use the existing baseline and forecast question and
record one request for the exact current schedule revision and uniquely
assigned project manager. Recheck authorization and assignment when the PM
opens the request. The request carries the dates and asks for supporting
evidence. The assigned project manager can confirm a current, individually
authorized human statement from the configured `project.delay_cause` fact.
Bind the confirmation to the request, schedule and evidence version. Leadership
can see a confirmed cause when that exact source remains readable and selected
by the current authority policy.

Reuse the Atlas clarification contract, project authorization and audit
storage. An exact retry returns the existing request. A changed schedule
requires a fresh answer. The read and request stay within the application.
The synthetic Atlas project keeps its original clarification workflow.

Extend the existing Atlas browser journey on the second canonical project.
Check the leader's request, exact replay, assigned PM confirmation and leadership
read. Revoke project or source access and verify the respective denial or
unknown cause. Verify the API contracts and required hosted checks. Revert the
routes and controls to roll back. Audit entries remain.
