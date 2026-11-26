# Atlas release evidence

The Atlas fixture exercises the synthetic, single-project path. These runs
register executable coverage for the scenarios below. The
[story registry](../../requirements/traceability/stories.yaml) and
[release plan](../04-delivery/RELEASE-1-VERTICAL-SLICE.md) track the
remaining acceptance criteria and customer release gates.

| Test | Executed behavior | Hosted evidence |
| --- | --- | --- |
| GOLDEN-001, E2E-QA-001 | Leadership gets baseline and forecast, the 14-day movement, the late start, the open synthetic Jira blocker, owner-confirmed pending access, the captured escalation, and PM-confirmed cause and medium forecast confidence. Each claim links to its supporting evidence. Unsupported blame and budget claims are absent. | [PR #197 main browser job](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45785125378/job/139789853496) |
| INT-QA-008 | An authorized leader compares a selected frozen snapshot with the current owner status and synthetic Jira receipt. The PM cannot open the leader's comparison and revoking the leader's access removes the comparison. | [PR #210 candidate browser job](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45871939384/job/140089291899) |
| INT-RPT-001 | The browser checks the same saved snapshot ID and fact highlights in the project report, leadership email preview and editable PowerPoint, including the linked authenticated project. The PM approves that exact snapshot before in-app distribution. | [PR #197 main browser job](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45785125378/job/139789853496) |
| INT-RPT-004 | A later owner reply and newer receipt produce different live facts. The original approved snapshot and recipient inbox retain their earlier facts and report revision. | [PR #210 candidate browser job](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45871939384/job/140089291899) |
| SEC-UPD-003 | The real HTTP integration suite denies expired, invalid and unauthorized invitations and preserves response and content counts. The packaged restore then uses the same working pre-backup invitation to prove restored read and submit denial under runtime database quarantine. | [PR #127 main Foundation](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/40966514743) and [PR #209 packaged restore](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45871058364/job/140086447239) |

The build uses PptxGenJS on a Linux runner and checks editable text and
report metadata in the generated deck. General report generation failure
and retry acceptance remains tracked under FAIL-016.
