# EXEC-050: Manual confirmation of a captured update

Status: In Progress
Owner: Implementation controller
Requirement IDs: FR-EVD-005, FR-UPD-007, FR-UPD-008, FR-UPD-010, FR-ESC-006, NFR-AI-001, NFR-REL-002, NFR-SEC-001
GitHub issues: [#9](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/9), [#10](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/10)
Target release: R1
Last updated: 2026-11-26

## Objective

Provide a manual path from a retained reply to a confirmed status fact when
there is no usable interpretation. Reuse the capture history, fact ledger,
and reminder recalculation.

For an ambiguous status reply, let the same reviewer request a focused
follow-up through the owner's active invitation (FR-UPD-009, AC-UPD-005,
GOLDEN-006, FAIL-010). The question asks for current status, the responsible
person, and an exact calendar date when relevant. This increment uses a
reviewer action and the in-app invitation, with no external notification.
When the captured request needs only a forecast among the supported facts,
reuse the same review and invitation to ask for the exact forecast date.

## In scope

A reviewer can see an actionable item for the latest retained owner reply
when the active request asks for `project.status`. The reviewer enters a
bounded status statement and confirms it as a human assessment. Source
authority still decides whether that statement satisfies the request.

Also allow a reviewer to confirm a requested `project.forecast` as an exact
calendar date, alongside or independently of status. Save the selected facts
in one transaction with their individual expected revisions and receipts.
Recalculate cadence after all selected facts are recorded so a generation
change cannot interrupt a combined confirmation.

When the reply contains a single explicit `Status:` or `Forecast:` line,
show the matching value as a proposal for the reviewer. Use the fact
confirmation schemas to validate the proposals and require a calendar date
in YYYY-MM-DD format for forecast. Conflicting or missing labels leave the
field for manual review. This works without a model and keeps the proposals
derived from the retained reply.

## Out of scope

Model configuration, baseline date changes, other fact types, live Jira comments and external
messages. Unresolved required facts keep their existing follow-up path.

## Current state

The capture flow stores immutable unconfirmed replies and permits raw reading
by the named recipient and authorized configured reviewers. The fact ledger
can append authorized human statements. The scheduling engine recomputes
required-fact satisfaction and replaces or suppresses pending stages when
current source evidence changes.

## Proposed design

Show the manual review on the existing capture history. Use the same project
lock for reviewer authorization, the latest reply, the optimistic fact
revision, fact append, source assessment, and immutable confirmation receipt.
The receipt links the request, original response, fact, version and evidence
IDs. Persist only the reviewer-authored status as fact content. The original
reply stays in its existing content store and retains its purge deadline.

Once a confirmation is recorded, its item shows the reviewer and receipt.
An exact retry while the capture is active returns the original receipt. If
reassessment ends the active capture, the archived request shows the receipt
while the reviewer still has access. The configured cadence service runs the
source assessment with its own current readership. Its existing authority
and freshness rules determine whether it suppresses or replaces pending work.
A reviewer-private fact stays in the ledger with its existing access policy.

## Files and modules expected to change

Project update contracts, capture history and its API, the existing fact
repository, the capture history UI, and focused tests in the current suites.

## Data model or migration impact

The existing fact ledger and append-only audit table store the fact and
confirmation. Pending manual reviews are derived from active captured replies.
No migration is required.

Clarification records only the request, latest response and issuance epoch
in the existing audit ledger. A newer owner reply returns the item to manual
review. The question is built into the application, and asking it leaves the
existing follow-up schedule in place.

## Security and privacy impact

Require the current scoped PMO role, membership in the frozen and current
reviewer lists, current source readership for both parties, and the existing
capture epoch and expiry. The API checks the latest response and fact revision
inside the transaction. The receipt carries references and scope, with raw
response content restricted through existing capture and retention controls.

## Connector and permission impact

Uses the existing API database role and fact-append permissions.

## Open-source dependency impact

No added dependency.

## Implementation stages

1. Reuse fact append inside the capture transaction and return the receipt.
2. Expose and confirm the current item in the existing capture history.
3. Verify that an authoritative status removes it from outstanding work while a
   missing forecast stays requested.

## Test and evaluation plan

Extend the API contract suite and the existing native engagement suite.
Check reviewer denial, stale revision, an attributable fact, receipt recovery,
replanning with a service-readable fact and preserved follow-ups for a
reviewer-private fact.
Check that a stale revision in a combined status and forecast confirmation
rolls back both statements, and that a successful pair creates two attributable
receipts and satisfies the pending reminders when both sources qualify.
Run the required hosted checks on the exact candidate.

## Rollback and recovery

Revert the UI and endpoint to remove manual confirmation. Existing fact,
assessment and audit rows remain readable in the current ledger. Use the
existing fact correction and source policy controls if a statement needs
correction. Preserve the audit history.

## Progress log

- 2026-11-26. Verified post-merge PR #197 and traced this workflow to the Release 1 critical path.

## Decisions made

Start with the existing `project.status` fact type. Reuse the current
reviewer, append and schedule boundaries. Derived review items avoid a new
queue table.

## Risks and mitigations

Source access or the capture generation can change before submission. Recheck
both under the project lock and fail closed. Epoch mismatch and source
retirement leave no new confirmation. Reassessment failures roll back the
statement and receipt with the pending work.

## Validation evidence

Record the exact reviewed candidate, hosted checks and observed workflow
results in its pull request.

INT-EVD-006 checks that the confirmation's reviewer and timestamp match the
audit event, the event references the original captured reply and the confirmed
fact version, and the original text stays in retained response content.

## Completion summary

The first increment covers the manual status workflow within the existing
capture policy. Broader interpretation and additional fact types remain
tracked in Issue #10.
