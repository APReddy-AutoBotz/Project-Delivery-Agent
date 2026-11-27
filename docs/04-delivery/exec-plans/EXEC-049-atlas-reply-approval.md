# EXEC-049: Atlas reply-to-PM approval

- Status: In Progress
- Owner: Implementation controller
- Requirement IDs: FR-UPD-006, FR-UPD-007, FR-UPD-008, FR-UPD-009, FR-APP-001, FR-APP-002, FR-APP-003, FR-APP-004, FR-APP-005, FR-APP-006, NFR-SEC-001
- GitHub issues: [#9](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/9), [#10](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/10)
- Target release: R1 synthetic demo milestone
- Last updated: 2026-11-26

## Objective

Let the synthetic Atlas contributor record an update, confirm an API access
status and hand the result to the assigned PM for a decision.

## In scope

Atlas API access status, interpretation confirmation, the ATLAS-248 comment
diff, a simulated PM approval or rejection, and receipt for recording an
approved simulated comment.

## Out of scope

Live providers, canonical fact writes, reminder suppression, live Jira
onboarding and comment processing, and live action receipts.
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

## Management snapshot

This synthetic increment exercises AC-RPT-001 and AC-RPT-002 in Issue #13
through the existing Atlas project screen. FR-RPT-001/004/005/007/009/010,
NFR-SEC-001 and TR-STACK-008 apply. ADR-007 keeps final distribution subject to
approval and ADR-010 requires an editable PowerPoint.

After the PM records a simulated receipt, a scoped leadership user can save
an internal draft. The project lock binds the sealed schedule and exact
approved reply and receipt to an append-only audit record. The same record ID,
reporting month, generation time and evidence feed the project snapshot,
email preview and one editable PowerPoint slide. The reporting month uses
UTC at capture. Repeating the save on the same evidence reopens the same draft.
Each user can reopen their most recent draft while the originating capture is
still accessible, including after newer source evidence arrives.

The existing synthetic mode, scoped leadership grant, capture epoch, source
reader gates and retention remain effective on reopen and download. The draft
stores structured synthetic facts and references. The report includes no raw
reply, request text or invitation locator. No migration or connector scope is
needed. PptxGenJS is pinned in the approved dependency register. External
distribution, report approval, final report retention and portfolio coverage
remain open under Issue #13.

The saved Atlas browser journey checks the shared revision in the project and
email, editable PPTX text, replay, frozen evidence after a later reply and
access denial after source revocation. Reverting removes the draft routes and
renderer. Existing synthetic audit rows remain historical metadata.

## Final project report approval

This Atlas-only increment exercises FR-RPT-007/009/010, AC-RPT-004,
AC-AUD-001 and NFR-SEC-001. The Atlas report is a synthetic internal project
narrative. The assigned project manager reviews it under the existing project
narrative permissions. Portfolio report approvals follow their own roles.

Leadership explicitly submits a saved snapshot. The same assigned Atlas PM
reviews the latest submission and records one approval or rejection for its
exact request and snapshot IDs. The project lock, append-only audit log and
current source and capture checks apply to submission, decision and reads.
Repeating the current matching decision returns the recorded result. A newer
submission supersedes an older pending review.

Approval finalizes the saved fact set and records its reviewer and decision
time. The project view, email preview and editable PowerPoint use those same
facts and approval metadata. An authorized author can reopen the exact report
by snapshot ID while the originating retention and source grants permit.
Exports are rendered from the saved report. Customer distribution and
generalized reporting remain open. Reverting removes approval routes and
controls while retaining the audit history and compatibility with existing
drafts.

Extend the existing Atlas browser journey for the handoff, role denials,
decision replay, final PowerPoint text, and immutable facts after a later
reply. Update the existing API contract checks.

For the Atlas portion of FAIL-016, render the final PowerPoint for the exact
pending snapshot before recording the first approval. If rendering fails or
the output violates the report contract, leave the report pending for the PM
to retry. Render outside the
project lock and reuse the repository's final scope and version checks before
writing the decision. Existing decisions retain their replay behavior.

## Approved report distribution

This Atlas-only increment exercises FR-RPT-007/009/010, AC-RPT-004,
AC-AUD-001 and NFR-SEC-001. After final approval, the same assigned PM
can publish the exact reviewed report to the existing Atlas Leadership
persona in the application. The recipient is set by the synthetic fixture.
The reporting policy gates external email and customer distribution.

Before publishing, check the latest review, exact snapshot and approval
request IDs, retained approval, and current project and evidence access
for the PM and recipient. The project lock and append-only audit event
bind one receipt to the approved decision and fixed recipient. Repeating
the same current publication returns its receipt. The recipient can read
the latest delivered report independently of newer drafts. Opening and
downloading recheck the original evidence's scope and retention.

The leadership inbox reuses the approved report and editable PowerPoint.
The audit holds IDs, recipient and capture context. The flow uses the
existing database and internal synthetic identities. A code revert removes
the publication controls and inbox while preserving the audit history.

The existing Atlas browser journey covers pending and rejected reports,
recipient access rechecks, replay, the delivered PowerPoint and reading
the original delivery after a newer draft.

## PM-confirmed delay evidence

This synthetic increment exercises FR-QA-004/005/008/009 and FR-RPT-010
for the Atlas project. After the simulated comment is recorded, the assigned
PM can confirm that API access caused the go-live delay and record their
forecast confidence. The confirmation is scoped to the exact current
schedule revision, owner-approved reply and simulated receipt. The PM can
choose medium, low or unknown confidence while access is pending.

Keep the confirmation append-only and attributable to the PM. Current
source access, retention and reply checks apply. A later reply or schedule
revision removes that confirmation from the current answer. The answer
cites the stored PM evidence and attributes the confidence judgment. New
reports include it in their frozen facts. Earlier snapshots retain their
original evidence and wording, including the unknown fallback. The
fixture does not establish live Jira escalation or complete GOLDEN-001.

Reuse the existing Atlas browser journey for the unknown fallback, PM
confirmation, leadership citation, edited report output, and historical
snapshot behavior. A code revert removes the confirmation controls. Use
the pre-change backup or a fresh disposable Atlas fixture when rolling
back to a build that predates the new saved fact shape.

## GOLDEN-001 evidence for the Atlas demo

This increment covers the remaining demo evidence for FR-QA-004/005/006/008/009
and NFR-SEC-001 in [Issue #12](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/12).
The live leadership answer cites planned and actual integration testing starts
from the sealed canonical fixture, and the open ATLAS-248 Jira blocker from a
separate synthetic source mapping. It calculates whether the start was late
from those dates.

The answer cites the persisted CAPTURE-mode escalation for the currently
assigned PM in the same engagement generation and issuance epoch as the
approved reply's request. The existing invitation checks apply to the
escalation's own source dependencies and retention. Leadership receives its
request reference and capture time. The invitation locator, body and underlying
source values stay private. The capture is the demo's evidence for the
escalation step. It delivers no external message. The live citations are
outside the frozen report format and the customer-facing golden acceptance
remains open.

Extend the existing Atlas browser journey to exercise the three citations and
withhold the escalation when leadership loses access to its source, while the
other authorized claims remain visible. API contract coverage uses the existing
route. There is no new dependency, migration, connector scope, or action.
Reverting the code removes the live citations. Reseed the disposable Atlas
fixture to remove its sample records.

## Approve the PM's edited comment

Under FR-APP-003/005/006/007 and NFR-SEC-001, the assigned PM can edit the
proposed text before approving it in the existing Atlas review. Approval
stores the reviewed single-line text when it differs from the template and
binds the digest to the approval, target and comparison revision. A retry
must match the recorded decision and exact reviewed text. The existing
simulated execution rechecks the same digest and comparison base. Its
receipt supplies the prior revision for the next proposal, where the review
shows the exact recorded text as the current source value.

Keep bodies and author fields from Jira outside the fixture. The bounded
text is PM-authored demo data. Existing default-template approvals remain
readable, including the earlier version without a payload digest. Leadership
continues to receive a receipt reference and the structured owner status.
The existing Atlas test covers edited approval, changed-text retry denial,
receipt replay, and the next comparison against the edited value. This is
synthetic evidence for part of [Issue #10](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/10).
There is no new migration, dependency, or connector scope. For rollback
after an edited approval, revert the code and reseed the disposable fixture.

## Refresh a stale comment comparison

Under FR-APP-007/008, the demo rehearses GOLDEN-009 with an independent
synthetic source change. Preflight compares the current fixture revision
and current comment with the approved comparison. A mismatch records a
replacement proposal and returns a conflict without recording a comment.
The PM screen shows the new base alongside the previous draft text and
requires a separate approval.

The replacement keeps the exact current owner-confirmed response, capture
epoch, assigned PM and retention checks. Its identity differs from the
superseded approval, so a retry of the old action cannot execute the new
proposal. The existing project lock serializes the fixture check, refresh
and receipt. If the source changes again before execution, repeat the same
review flow. The original approval remains available in the audit history.

The Atlas browser journey inserts the separate source change into its
isolated fixture and verifies refusal, replacement, fresh approval and
successful simulated execution. This exercises the synthetic portion of
[Issue #10](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/10).
For rollback, revert the code and reseed the disposable fixture.

## Source freshness on the management snapshot

For FR-RPT-007 and INT-RPT-002, show when the owner submitted the reply saved
with the snapshot and when its evidence availability ends. The
dashboard, email preview and PowerPoint use the same text. The existing browser
journey also checks the report ID, reporting period, generation timestamp,
approval state and editable PowerPoint text.
