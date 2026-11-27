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
| Atlas project access | After a leader's grant moves to a different project in the same customer, copied Atlas answer, comparison and report evidence URLs return the same denial as missing project URLs. | [PR #234 main database and browser job](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45959508138/job/140373707750) |
| INT-RPT-001 | The browser checks the same saved snapshot ID and fact highlights in the project report, leadership email preview and editable PowerPoint, including the linked authenticated project. The PM approves that exact snapshot before in-app distribution. | [PR #197 main browser job](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45785125378/job/139789853496) |
| INT-RPT-002 | The Linux browser downloads the editable approved PowerPoint and verifies the report period, generation timestamp, approval state, and the owner reply's recorded time and availability deadline. The dashboard and email preview show the same deadline. | [PR #223 main browser job](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45927676380/job/140272766229) |
| INT-RPT-004 | A later owner reply and newer receipt produce different live facts. The original approved snapshot and recipient inbox retain their earlier facts and report revision. | [PR #210 main browser job](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45876005787/job/140103130119) |
| SEC-UPD-003 | The real HTTP integration suite denies expired, invalid and unauthorized invitations and preserves response and content counts. The packaged restore then uses the same working pre-backup invitation to prove restored read and submit denial under runtime database quarantine. | [PR #127 main Foundation](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/40966514743) and [PR #209 main packaged restore evidence](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45874601256/artifacts/15145801163) |
| GOLDEN-006, FAIL-010 | PMO asks the owner for clarification after an ambiguous reply. The original reply cannot confirm the requested fact. The owner can correct it through the active invitation. A forecast-only request asks for the exact date. Confirmation of an independent fact preserves the focused question, including when the authorization change requires a replacement invitation. | [PR #215 main database and browser job](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45883519852/job/140128425260), [PR #226 fact-specific clarification](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45935364088/job/140297210252) |
| INT-EVD-006 | Each confirmation records the exact reviewer and audit time and links the original captured response to the confirmed fact version and evidence. The native test checks the retained original text under both reviewer-private and service-readable conditions. | [PR #224 main database and browser job](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45928632248/job/140275843064) |
| FAIL-016 | A renderer error or invalid deck leaves the Atlas report pending. A retry with a valid PowerPoint records the approval once. | [PR #214 main code checks](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45881407447/job/140121387791) |
| PILOT-001 synthetic calculations | The fixture verifies effort per cycle, completed and current verified update rates, and risk-detection lead time. Customer agreement and observed pilot results are pending. | [PR #212 main code checks](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45880585368/job/140118606576) |
| FR-ADV-002 blocker review | The assigned PM sees one ranked review for the project with current authorized aged blockers. Revoking the underlying source access removes the item after refresh. | [PR #222 main browser job](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45927603066/job/140272532555) |

The build uses PptxGenJS on a Linux runner and checks editable text and
report metadata in the generated deck. General reporting acceptance remains
open under Issue #13.

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
