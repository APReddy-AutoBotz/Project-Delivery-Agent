# EXEC-057: Selected-project management draft

Status: In progress

Requirements: FR-RPT-001, FR-RPT-004, FR-RPT-005, FR-RPT-007, FR-RPT-010 and NFR-SEC-001.

GitHub issue [#13](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/13).

## Scope

An authorized leader can preview the selected project's schedule and saved update
freshness as a management draft. An explicit preview checks current authorization
and collects one point-in-time set of facts. The dashboard, email preview and
editable PowerPoint use that same set with the reporting month and generation
time. Show how the draft was sourced and label it Draft in every output.

Reuse the current leadership answer's canonical and update-policy reads, and the
server-side PowerPoint renderer from Atlas. Disclose saved freshness only when
its source references are still readable. The draft lives in the authorized
browser view. Recheck the same facts before export and preserve the original
generation time in the download. A new preview creates a new observation. Durable report runs,
approvals and distribution are separate release work.

## Verification and rollback

Extend the existing selected-project browser journey to check one shared set of
schedule and freshness values, the editable deck, and current project denial.
Use the generated OpenAPI contract and the current hosted checks. Revert the
panel and endpoint to roll back. There is no stored draft, migration, connector
scope change or email delivery.

## Scheduled draft generation

STORY-030 and AC-PERF-001 also depend on FR-RPT-005, NFR-PERF-003,
TR-STACK-006 and ADR-003. Reuse the generic management draft fact set and
the existing PowerPoint renderer from a Graphile Worker task. An explicitly
configured portfolio scope and service subject define where the task can run.
Apply current project and source access to that subject at preparation time
and record it as the service actor.

Prepare a stable report run for each selected project and reporting period.
Render the frozen draft in the worker and complete the same run after a
retry. Authorized leadership can preview the frozen draft. To request approval
and distribution, leadership can generate and save a live report from the
project. The report job and connector synchronization must run during the
measured dashboard read workload to demonstrate the performance criterion.
