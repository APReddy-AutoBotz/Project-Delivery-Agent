# Project evidence workflow validation

Issue: [#6](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/6).
Plan: [EXEC-006](../04-delivery/exec-plans/EXEC-006-project-evidence-workflow.md).
Status: Accepted after independently reviewed PR #47 merge; reconciliation and release gates remain open.
Accepted: AC-EVD-001/002/003 and AC-ADM-003, completing STORY-011 and part of STORY-012.
Requirements: FR-EVD-001/002/003/004/005/006/007/009/010/012, FR-ADM-005,
NFR-SEC-001/004 and TR-API-001.

## Verified completion

[PR #47](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/47)
merged candidate `5ecefb11c94b9cd63077fa9ac8269e093f0e5a03` as
`2187f3a774f1655ec34eb26dee5381ffeea3a4c4` at 2026-09-11T19:25:42Z, with tree
`12aa5d3ca593f558cbb02ede60c7a0f0b8d7145d`. The
[public gate record](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/47#issuecomment-5639577926) binds three independent immutable source reviews,
both original-artifact reviews and the root's retained evidence checks.
[Foundation 34634884717](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/34634884717)
and [Documentation 34634884612](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/34634884612)
passed for that candidate: 764 unit/contract tests, 85 database/API cases, 18 browser
workflows, seven package builds, 19 packaged groups, both customer profiles, three
populated upgrade prefixes and exact 31-table recovery. The reviewed tree and
ordered merge parents were verified after merge. These are completed candidate
checks; later main-branch repeats have their own results.

Under delegated controller authority, AC-EVD-001/002/003 and AC-ADM-003 are accepted,
completing STORY-011. Typed human statements preserve original versions; explicit
PMO authority changes subsequent captures; saved assessments retain provenance,
freshness and conflict independently and apply current permissions on delivery.
Issue #6 remains open with five of six criteria accepted. AC-EVD-004 / GOLDEN-003
and STORY-012 still require canonical milestone/mandatory-work reconciliation and
a durable request delivered to the currently authorized PM.

Accepted stories: R0 3/5 (60%); R1 2/33 (6.1%). These fixed story fractions do not
measure engineering effort or commercial readiness. The five inventory, licensing,
vulnerability, distributed-layer and signing release gates remain open. The current
87-file distribution evidence retains 832 High/Critical scanner occurrences,
112 validated dispositions and 720 unresolved occurrences; no new disposition
or customer-release approval is granted.

No migration, table, database grant, external dependency version or connector scope
changes. Current matching role/grant and source permissions protect every operation;
known denial clears protected browser state. Transient failures hide protected
content and disable mutations while retaining in-memory state for safe retry.
No AI call, external write or real-data
activation. Recovery uses a compatible application revert preserving additive
history, or encrypted restore into a fresh quarantined target.

## User and administrator workflow

Open an authorized project and its **Project evidence** section. Choose a literal
fact type from the paged catalogue, or enter a new key to open its empty history.
Keys belong to the project; they do not link or update a canonical child or date.
History retains each original typed value, statement, source/evidence identifiers,
confirmer and timestamps. History paging freezes its upper revision; the fact
catalogue pages live metadata. Neither page supplies the assessment's inputs.

A project manager, portfolio manager or PMO administrator with a matching current
scope can enter a text, number, boolean, date or empty statement. Review the exact
value, original statement and UTC times, then confirm. Attribution and observation
time come from the server. On an uncertain response, retry the same reviewed
request. A conflict requires a fresh review. Leaving the project or losing access
clears private drafts. A transient failure hides and disables them while keeping
the reviewed request in memory for a safe retry.

Statements initially remain private to their confirmer. A PMO administrator can
choose **Manage source readers**, inspect the saved revision, and review an exact
replacement of the state and reader subject IDs. Readers also need current project
permission. An uncertain access-save response requires closing, reloading and
comparing the saved state before another explicit replacement.

PMO administrators can configure an explicit authority rule. The form replaces the
whole rule with one tier covering human-statement sources, including approval,
validity and conflict behavior; it does not preserve undisplayed tiers. The active
rule display retains all configured tiers and separates published versus active
revisions. Human confirmation cannot supply APPROVED status. No default authority
is installed. Disabling or scheduling a rule changes only subsequent assessments
at the applicable time; earlier history and saved results remain immutable.

Choose **Capture new assessment** to use the server's current clock, complete
bounded history and applicable policy. The saved result displays provenance,
freshness, conflict, authority reasons, expiry and the original fact target/time.
Every saved result is historical, including CURRENT-at-capture. An elapsed validity
warning never rewrites those saved dimensions. A copied link contains only IDs and
requires current authentication and scope; current source restrictions withhold
copied results. The reconciliation signal does not create a PM request.

## Verification boundaries

The nine strict REST operations are in the generated OpenAPI contract. Inputs
reject spoofed provenance/actors/clocks; outputs discriminate available content
from redaction. A currently authorized empty fact returns an empty page, while
denied or unknown projects return the same fixed 404. Capabilities require a
matching identity role and current project/portfolio grant. No operational role
gains implicit evidence access. OIDC remapping and all replay paths reauthorize.

`tests/project-evidence.integration.test.ts` exercises real HTTP/PostgreSQL:
typed history and paging, changed values, current/revoked scopes, source states,
immutable captures, policy changes, expiry/conflict, concurrency and role remapping.
`tests/evidence-api-errors.test.ts`, `tests/evidence-responses.test.ts` and the
complete API contract suite verify bounded shapes and sanitized failure output.
`tests/e2e/project-evidence.spec.ts` exercises four real browser journeys for
review/retry, authority and historical links, disclosure/session loss and uncertain
source-access replacement. Synthetic screenshots accompany successful CI evidence.

The packaged customer helper uses real TLS/OIDC and the shipped API in both
bundled and external PostgreSQL profiles. It retains bounded original response
projections and screenshot hashes, reopens the saved link after application
recreation, then checks revocation in the same session. All new evidence-fixture
writes precede the backup projection. After recreation the harness deliberately
revokes the project grant and verifies current denial; restore compares the earlier
complete backup. Quarantined restore compares the complete 31-table projection;
it does not enable runtime access on the restored target. Host receipt validation
has no package dependency before the images are built.

Native development history: initial absent canonical tables in the preserved
local database caused setup failures. Its synthetic operator grant fixture had
run; no schema reset/migration or data deletion was applied there. Browser testing
then used a separate migrated synthetic database. Failed runs remain private.
The first unconstrained unit run had two existing process-startup timeouts under
concurrent load; final validation uses bounded workers without relaxing deadlines.

## Impact and remaining scope

No database migration, table, grant or connector scope is added. All four existing
migration files remain unchanged. The web shares domain types through an erased
workspace import, enforced by the architecture check; no external runtime version
changes. No AI call, external write or real-data activation is introduced.

AC-EVD-004/GOLDEN-003 canonical milestone/work-item reconciliation, full STORY-012,
trusted ingestion, PM engagement, leadership Q&A and reporting remain pending.
The five distribution/customer release gates remain open. Recovery is a compatible
application revert preserving additive evidence or the existing encrypted backup
restore into a fresh quarantined target.

## Executable acceptance mapping

Test catalogue status means implementation coverage; execution results are the
candidate CI and original artifacts above. Existing IDs and behaviors are unchanged.

| Accepted criterion | Registered tests | Executable evidence |
|---|---|---|
| AC-EVD-001 | INT-EVD-001 | Same-source changed-value HTTP history and both packaged original response projections; immutable prior source, value and times. |
| AC-EVD-002 | UNIT-EVD-002, GOLDEN-013, FAIL-028 | Temporal/domain and authority tests, HTTP captures and browser stale/conflict journey retain all dimensions and the unchanged older snapshot. |
| AC-EVD-003 | UNIT-EVD-003, E2E-EVD-003 | Deterministic validity boundaries, configured expiry in both packaged profiles and browser elapsed-expiry warning without rewriting the historical result. |
| AC-ADM-003 | INT-ADM-003 | Real PMO policy replacement/replay, subsequent captures, disabled/scheduled rules and unchanged original history/assessment. |

Original evidence artifacts: database `10276944481`, browser `10276699958`,
production `10278137309`, distribution `10277902111`, all on Foundation run
`34634884717`. The production JSON SHA256 is
`ed22739715c19fe68b45d489b9704fbfd6304a8b72fd75d45f72c77a655c296b`;
the distribution manifest SHA256 is
`3c284db4bb4e053299fba1264d42c6aa09a357ed1e0ee2a416779842cc30e328`.
Original screenshots in the browser artifact show source-reader management and
the historical stale/conflict result; both packaged profile screenshots match
their original receipt hashes. The public gate record retains all archive hashes.

AC-EVD-004's INT-EVD-004, GOLDEN-003 and FAIL-009 remain planned. A scalar
reconciliation-needed flag does not implement the canonical contradiction and PM
request. No shared health, Q&A, engagement or reporting criterion is accepted here.
