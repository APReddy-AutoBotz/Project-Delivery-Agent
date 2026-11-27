# Atlas release evidence

The Atlas fixture exercises the synthetic, single-project path. These runs
register executable coverage for the scenarios below. The
[story registry](../../requirements/traceability/stories.yaml) and
[release plan](../04-delivery/RELEASE-1-VERTICAL-SLICE.md) track the
remaining acceptance criteria and customer release gates.

| Test | Executed behavior | Hosted evidence |
| --- | --- | --- |
| GOLDEN-001, E2E-QA-001 | Leadership gets baseline and forecast, the 14-day movement, the late start, the open synthetic Jira blocker, owner-confirmed pending access, the captured escalation, and PM-confirmed cause and medium forecast confidence. Each claim links to its supporting evidence. Unsupported blame and budget claims are absent. | [PR #197 main browser job](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45785125378/job/139789853496) |
| E2E-HERO-001 source intake | The read-only Jira connector saves the project, issue and source revision cited in the delay answer. The answer uses the authorized Jira observation for the open blocker and removes its claim and citation when source access is revoked. The reviewed portfolio CSV receipt contains the displayed baseline and forecast as proposals. Spreadsheet field authority for this journey remains open. | [PR #219 intake](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45919132431/job/140245390213), [PR #220 CSV](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45919191553/job/140245590776), [PR #227 Jira authority](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45938724907/job/140307848095) |
| INT-QA-008 | An authorized leader compares a selected frozen snapshot with the current owner status and synthetic Jira receipt. The PM cannot open the leader's comparison and revoking the leader's access removes the comparison. | [PR #210 main browser job](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45876005787/job/140103130119) |
| FR-QA-006 saved freshness | The leadership answer identifies the same saved stale-update assessment, age basis and open update obligation available to the assigned PM. | [PR #228 main database and browser job](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45938830290/job/140308182834) |
| GOLDEN-004 | The leadership answer flags a complete nine-day-old PM update under the seven-day policy, identifies the active clarification and continues to show the current system-verified Jira blocker. When source access is revoked, the saved freshness metadata is withheld. | [PR #233 main database and browser job](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45959361661/job/140373243211) |
| GOLDEN-005 | The leadership answer shows a verified delay and an unknown cause with Jira evidence withheld. Leadership submits the question to the assigned PM's Atlas panel. Replay returns the same request. Cause confirmation closes it even after an owner replaces their reply on that schedule. | [PR #232 main database and browser job](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45951850756/job/140349291397) |
| SEC-EVD-005, SEC-QA-007 | After a leader's grant moves to a different project in the same customer, copied Atlas answer, comparison and report evidence URLs return the same denial as missing project URLs. The normal leadership question also denies the formerly authorized project and answers only for the selected authorized project. | [PR #234 main database and browser job](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45959508138/job/140373707750), [PR #235 main database and browser job](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45971299850/job/140412121922) |
| INT-RPT-001 | The browser checks the same saved snapshot ID and fact highlights in the project report, leadership email preview and editable PowerPoint, including the linked authenticated project. The PM approves that exact snapshot before in-app distribution. | [PR #197 main browser job](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45785125378/job/139789853496) |
| INT-RPT-002 | The Linux browser downloads the editable approved PowerPoint and verifies the report period, generation timestamp, approval state, and the owner reply's recorded time and availability deadline. The dashboard and email preview show the same deadline. | [PR #223 main browser job](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45927676380/job/140272766229) |
| INT-RPT-004 | A later owner reply and newer receipt produce different live facts. The original approved snapshot and recipient inbox retain their earlier facts and report revision. | [PR #210 main browser job](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45876005787/job/140103130119) |
| E2E-ACC-005 | The existing GOLDEN-002 browser journey checks the text labels for reported GREEN and calculated RED, explains the overdue milestone, blocker and stale update inputs, and shows the recommended PM review. | [PR #238 main database and browser job](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45988298558/job/140469403105) |
| SEC-UPD-003 | The real HTTP integration suite denies expired, invalid and unauthorized invitations and preserves response and content counts. The packaged restore then uses the same working pre-backup invitation to prove restored read and submit denial under runtime database quarantine. | [PR #127 main Foundation](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/40966514743) and [PR #209 main packaged restore evidence](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45874601256/artifacts/15145801163) |
| GOLDEN-006, FAIL-010 | PMO asks the owner for clarification after an ambiguous reply. The original reply cannot confirm the requested fact. The owner can correct it through the active invitation. A forecast-only request asks for the exact date. Confirmation of an independent fact preserves the focused question, including when the authorization change requires a replacement invitation. | [PR #215 main database and browser job](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45883519852/job/140128425260), [PR #226 fact-specific clarification](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45935364088/job/140297210252) |
| INT-EVD-006 | Each confirmation records the exact reviewer and audit time and links the original captured response to the confirmed fact version and evidence. The native test checks the retained original text under both reviewer-private and service-readable conditions. | [PR #224 main database and browser job](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45928632248/job/140275843064) |
| FAIL-016 | A renderer error or invalid deck leaves the Atlas report pending. A retry with a valid PowerPoint records the approval once. | [PR #214 main code checks](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45881407447/job/140121387791) |
| PILOT-001 synthetic calculations | The fixture verifies effort per cycle, completed and current verified update rates, and risk-detection lead time. Customer agreement and observed pilot results are pending. | [PR #212 main code checks](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45880585368/job/140118606576) |
| FR-ADV-002 blocker review | The assigned PM sees one ranked review for the project with current authorized aged blockers. Revoking the underlying source access removes the item after refresh. | [PR #222 main browser job](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45927603066/job/140272532555) |

The build uses PptxGenJS on a Linux runner and checks editable text and
report metadata in the generated deck. General reporting acceptance remains
open under Issue #13.

## Versioned report software acceptance

STORY-031 covers the frozen fact set used by the project report, leadership
email preview and editable PowerPoint. This decision takes effect after the
acceptance record receives independent review and passes required hosted checks
and verified merge.

| Criterion | Executed evidence |
| --- | --- |
| AC-RPT-001 | Atlas uses one saved report ID across the dashboard, email preview and editable deck. The normal project view repeats the same check on a second canonical project, including the revision and original generation time. The assigned PM approves that same ID. [Atlas browser](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45785125378/job/139789853496) · [Normal project browser](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45988298558/job/140469403105) |
| AC-RPT-004 | The finalized Atlas snapshot and its recipient inbox keep their earlier access status and comment receipt after a newer owner reply and receipt arrive. The normal project snapshot retains its original presentation after the active update policy changes, and a current source revocation blocks reopening a protected snapshot. [Atlas browser](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45876005787/job/140103130119) · [Normal project browser](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45988298558/job/140469403105) |

The normal project evidence is from the verified PR #238 merge `b2b0e59f`.
The snapshot uses existing append-only audit storage. Recovery retains those
records if the application route is reverted. Portfolio dashboards, report
content and customer release gates remain open under their existing decisions.
[Main Foundation](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45988298558) ·
[Main Documentation](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45988298547)

## Selected-project PowerPoint software acceptance

STORY-032 covers editable selected-project PowerPoint reports and the related
metadata and accessibility criteria. This acceptance takes effect after the
record passes independent review and required hosted checks and merges.
Portfolio dashboards and customer release approval remain open.

| Criterion | Executed evidence |
| --- | --- |
| AC-RPT-001 | The project view, email preview and editable deck use the same saved report ID and fact highlights through approval and delivery. [Main browser](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/46012061356/job/140549796330) |
| AC-RPT-002 | The hosted Linux browser opens editable slide XML and checks period, generation time, saved identity, approval state and source freshness. The normal approved and delivered decks display Confidential. If rendering fails or returns an invalid deck, the request remains pending and a valid retry can approve it once. [Freshness and timestamps](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45927676380/job/140272766229) · [Classification and delivery](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/46012061356/job/140549796330) · [Renderer failure and retry](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45881407447/job/140121387791) |
| AC-RPT-005 | GOLDEN-002 explains the reported and calculated health labels and the overdue, blocker and freshness inputs in the project view. [Health browser evidence](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45988298558/job/140469403105) |

The normal project proof is from the independently reviewed PR #242 merge
`953d5e66`. Its actual main checks passed. Reverting the renderer change
preserves saved report IDs, facts and approval receipts.
[Main Foundation](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/46012061356) ·
[Main Documentation](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/46012061330)

## Selected-project question evidence

| Criterion | Executed evidence |
| --- | --- |
| AC-QA-006 | A measured delay with unavailable cause evidence shows an unknown cause. Leadership can record a request for the current schedule and the assigned PM can open it. A retry returns the same request. The normal project path also confirms an authorized cause and withholds it when its source grant is revoked. [Atlas workflow](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45951850756/job/140349291397) · [Normal project workflow](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/46012061356/job/140549796330) |
| AC-QA-008 | A leader can compare a selected saved snapshot with the current project facts. The comparison keeps the earlier snapshot ID and excludes unreadable or out-of-project evidence. [Atlas comparison](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45876005787/job/140103130119) · [Normal project comparison](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45999905312/job/140508579631) |

The comparison scope is selected saved snapshots. The remaining leadership
requirements stay open under [Issue #12](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/12).

The [Atlas browser journey](../../tests/escalation-browser/atlas-approval.spec.ts)
checks that the owner invitation shows the last reported status for ATLAS-248
and asks for the missing forecast information. The assigned PM reads the newer
status selected by the project authority policy and sees ATLAS-248 in the
ranked blocker review alongside the pending comment approval.

The leadership date view also compares an authorized current date with a
saved authority assessment for the same fact. The reader and HTTP tests
check the exact assessment binding and deny unavailable historical access.
The browser checks both dates and clears the comparison when the selection
changes. [PR #217 code checks](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45898212812/job/140177282682)
and [PR #217 browser checks](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45898212812/job/140177282758).

## Selected-project email digest software acceptance

STORY-033 covers the selected-project email preview. The preview compares the
current report with the latest readable delivered snapshot, summarizes schedule
and update freshness changes, and lists open decision needs. It links to the
authenticated project and uses the same frozen report facts as the editable
deck. The browser checks the link, open and completed decisions, the exact
prior snapshot, unchanged schedule dates, and the change from current to
unavailable freshness in the preview and deck. It also
checks that revoking access to the earlier evidence withholds the dependent
draft and blocks its approval. This record takes effect after required hosted
checks, independent review and merge.
[Main browser evidence](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/46024420243/job/140592001303)

## Assigned PM queue access acceptance

AC-RPT-003 is covered by the PM action queue tests on the same exact main
revision. Native checks verify that PM assignments and matching project or
portfolio grants are both required, including revocation, dual-role and
cross-customer cases. The HTTP tests check that the queue rejects caller-supplied
scope. Browser checks cover session changes and a PM opening a pending project
report from the queue after another request was approved. Queue coverage is
part of [STORY-030 and Issue #13](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/13).
[Main native and browser checks](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/46024420243/job/140592001303) ·
[Main code checks](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/46024420243/job/140592001224)
