# EXEC-049: Atlas reply-to-PM approval

- Status: In Progress
- Owner: Implementation controller
- Requirement IDs: FR-UPD-006, FR-UPD-007, FR-UPD-008, FR-UPD-009, FR-APP-001, FR-APP-002, FR-APP-004, FR-APP-005, FR-APP-006, NFR-SEC-001
- GitHub issues: [#9](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/9), [#10](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/10)
- Target release: R1 synthetic demo milestone
- Last updated: 2026-11-24

## Objective

Let the synthetic Atlas contributor record an update, confirm an API access
status and hand the result to the assigned PM for a decision.

## In scope

Atlas API access status, interpretation confirmation, the ATLAS-248 comment
diff, a simulated PM approval or rejection, and receipt for recording an
approved simulated comment.

## Out of scope

Live providers, canonical fact writes, reminder suppression, live Jira
onboarding and comment processing, arbitrary draft text, and live action receipts.
The full release stories and customer decisions remain open.

## Current state

Main at `8b25643` contains the authenticated invitation, append-only reply
capture, current access checks, and saved escalation browser fixture.

## Proposed design

Use the existing capture and project screens. The synthetic reply fixture
suggests one bounded status from explicit fixture wording. The owner can
choose either permitted status when the reply needs clarification. Confirm
only the latest retained reply on the original request. The PM sees the
structured status, reply reference and a versioned server-authored comment
for the ATLAS-248 fixture. The required PM is the current configured and
assigned PM with a matching scoped grant. The PM can approve or reject the
exact proposal, and each request rechecks source access and capture lifetime.

## Files and modules expected to change

Project update domain/repository, invitation and project API contracts, the
existing web screens, and the isolated escalation browser fixture.

## Data model or migration impact

Two append-only audit event types record the response and fixture template
references, confirmed status and decision. The project lock serializes
confirmation, correction and decision. Repeating the same decision returns
the recorded value. A later reply makes the previous proposal unavailable.
The demo needs no schema migration.

## Security and privacy impact

Feature requires local non-production synthetic development identity and the
Atlas fixture project. Existing capture policy, grant, issuance, expiry and
source access checks apply. The PM receives structured status and reply
metadata. The app does not copy raw response text into the proposal or audit.

## Connector and permission impact

Existing project manager and contributor roles apply. The demo comment state
has no connector binding or action dispatch capability.

## Open-source dependency impact

No new dependency.

## Implementation stages

1. Add the confirmation and decision to the existing capture repository.
2. Expose owner confirmation and the PM review on the existing screens.
3. Exercise the saved workflow in the existing browser fixture.

## Test and evaluation plan

Run the existing invitation and API contract tests. Use one real browser
journey for clarification, owner confirmation, a PM decision, a direct denial
for a leadership reader, and persisted decision reload. Existing hosted
Foundation validation includes the isolated browser harness.

## Rollback and recovery

Revert the feature code to remove the synthetic UI and routes. Existing
append-only audit rows remain readable as historical metadata. The existing
capture quarantine applies to restored installations.

## Progress log

2026-11-24. Verified merges of PR #188 and PR #189 before starting this slice.

## Decisions made

Use a local synthetic fixture with versioned comment templates and audit
events. Keep captured reply contents under the existing readership and
retention policy.

## Risks and mitigations

Validate reply currency and the PM's role on the server for every decision.
The proposal has the same lifetime and source access boundary as its origin.

## Validation evidence

Record exact candidate and browser results with the PR.

## Completion summary

PR #190 delivered the stored synthetic PM decision on main at `e28a8c9`.

## Synthetic comment receipt

This follow-up exercises FR-APP-005/007/008/010, FR-WRB-004/007 and
NFR-REL-001 in the existing Atlas fixture. The owner confirmation snapshots
the current revision and prior comment. The PM approves that diff. On a
separate explicit action, the same scoped PM can record the approved comment
against the fixture after the server rechecks the reply, current source access,
approval expiry, approved payload digest, and exact fixture revision and
base comment. Revision zero represents the empty fixture shown by PR #190,
so an older stored approval remains usable while the fixture is still empty.

The existing project lock serializes those checks and the append-only audit
insert. The insert is both the simulated write and its receipt. A retry of
the current approval returns its existing receipt. A new reply requires
another confirmation and decision. The receipt stores the linked response,
decision, digest, revision and audit context. No connector operation,
dependency, migration or live scope is introduced. A source conflict returns
409 without recording a comment. When reverting, use a fresh disposable demo
fixture or restore its pre-change copy. The older build expects the previous
audit record shapes. The existing database retains the audit history.

Extend the existing Atlas browser journey to check pre-approval and leadership
denial, persisted receipt replay, and a fresh diff after the owner replies again.

## Cited leadership answer

The next synthetic milestone covers portions of FR-QA-001/003/004/005/006/008/009
and NFR-SEC-001 in [Issue #12](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/12).
The question is fixed and scoped to the selected Atlas fixture. The server reads
the sealed synthetic schedule, computes calendar-day movement, and publishes
the latest owner-confirmed status and its simulated receipt when the PM's
approval and the underlying source access remain valid. The schedule, reply,
and receipt have separate citations. The answer gives the reply timestamp and
check time. The cause of the schedule movement and confidence in the forecast
remain unknown on the available records.

Require a current leadership grant and current readership of the captured
dependencies. Leadership receives the structured reply reference and receipt
from the approved fixture. The raw reply and invitation contents retain their
existing readership. Revalidate on query, focus and expiry. No migration,
dependency, model provider, connector scope, or external action is introduced.
The customer-facing Q&A stories and GOLDEN-001 remain open.

The existing Atlas journey checks the 14-day calculation, citation targets, raw
reply withholding, responder and PM separation, and denial after a source
reader is removed. A code revert removes the leadership question and keeps
the approval and receipt data compatible.
