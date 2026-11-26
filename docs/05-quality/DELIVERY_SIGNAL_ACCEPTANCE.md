# Delivery signal software acceptance

Status: this decision takes effect after the exact acceptance record passes
independent review, required hosted checks and verified merge.

## STORY-014 evidence

| Required criterion | Executed evidence |
| --- | --- |
| AC-HLT-003 | UNIT-HLT-003 checked open-period age, missing dates and closed blockers. E2E-HLT-003 checked a complete inventory with a source-authorized classification and opened date, and showed the calculated age and configured threshold. The separate unresolved inventory case showed unassessable coverage. |
| AC-HLT-005 | INT-HLT-005 and GOLDEN-003 checked the configured milestone contradiction and a durable reconciliation action for the named project manager. The reviewed workbook and three Jira observations retained their distinct versions and evidence. |
| AC-HLT-007 | UNIT-HLT-007 and INT-HLT-007 exercised configured deadlines, local calendar-day boundaries, exact canonical dates and rule revisions, and a populated upgrade. E2E-HLT-007 saved a project-local policy and verified its applied revision, timezone and target threshold in the assessment UI. Exact replay retains the original effective policy. |
| AC-HLT-006 | UNIT-HLT-006 recomputed the same schedule and blocker-age outputs with provider access disabled. Native integration tested a source-authorized combined assessment with the provider disabled and verified persistence and replay separately. |

The merged application displayed the verified blocker row with its source date
and an `AGED` result, with the applied threshold shown as `10 days`. The
same browser test verified the summary text “1 blocker(s) assessed; 1 meet or
exceed the threshold.” The saved overdue assessment retained its exact
selected due-date field, local date, timezone, threshold and rule revision.
[Blocker-age evidence](../04-delivery/exec-plans/EXEC-011-authority-backed-blocker-age.md) ·
[Overdue evidence](../04-delivery/exec-plans/EXEC-013-persisted-schedule-overdue.md#validation-evidence) ·
[Milestone contradiction evidence](EXEC_047_SOURCE_AUTHORITY_ACCEPTANCE.md)

FR-HLT-003 and FR-HLT-004 are covered by the configured overdue and blocker
calculations. FR-HLT-009 is covered by the frozen input and rule references
for each signal. FR-HLT-008 is covered by the bounded milestone contradiction.
FR-HLT-011 and NFR-REL-003 are covered by the deterministic calculation and
the provider-disabled evidence above. The story contributes to PR-005 and
BR-003 by exposing selected delivery concerns from current evidence. The
scheduled freshness and completeness path has separate STORY-013 evidence.
[STORY-013 acceptance](FRESHNESS_COMPLETENESS_ACCEPTANCE.md)

The blocker-age implementation merged in PR #88, and PR #89 added positive
browser acceptance. Persisted overdue and provider-disabled evidence merged
in PR #100. PR #184 supplied
the milestone evidence and PR #186 accepted the mapped criterion. The
actual PR #186 main run repeated both E2E-HLT-003 cases, E2E-HLT-007, the
blocker, schedule and overdue unit suites, the provider-disabled tests, the native assessment
suite and the packaged milestone workflow. [Current merged checks](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/44981086850) ·
[PR #88](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/88) ·
[PR #89](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/89) ·
[PR #100](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/100) ·
[PR #186](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/186)

## STORY-015 evidence

| Required criterion | Executed evidence |
| --- | --- |
| AC-HLT-004 | GOLDEN-002 used a saved project with reported Green, a configured critical overdue milestone, an open critical blocker backed by source authority, and a stale trusted update. It verified the separately calculated Red concern, exact selected inputs and rule revision, and the PM review recommendation. The saved result and replay preserved reported Green. The earlier schedule-only E2E-HLT-004 still provides its separate baseline. |
| AC-HLT-005 | INT-HLT-005 and GOLDEN-003 verified the configured completed-milestone versus mandatory-open-work contradiction and its durable reconciliation action for the assigned PM. [Accepted evidence](EXEC_047_SOURCE_AUTHORITY_ACCEPTANCE.md) |

The independent review covered the exact PR #188 head `8adea213`. The
merge `55853cfe` has the same tree and names that head as its second parent.
Foundation and Documentation passed on the exact head and the main push.
[Independent review](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/188#issuecomment-7121287787) ·
[Candidate Foundation](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45320163115) ·
[Candidate Documentation](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45320163082) ·
[Main Foundation](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45323815795) ·
[Main Documentation](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45323815862)

The main run passed the seven composed concern unit cases and the development
browser scenario. The packaged artifact contains the same browser scenario's
screenshot and JSON receipt for each customer database profile. Both receipts
report `passed`, rule revision `schedule-health@2+blocker-age@1+delivery-concern@1`,
critical-target policy revision 1, and `restoreVerified: true`. Recovery compared
the saved assessment, its command receipt and the policy history against the
original profile's storage digest.
[Development browser evidence](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45323815795/artifacts/14889961952) ·
[Packaged and recovery evidence](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45323815795/artifacts/14889469296)

The acceptance record changes documentation and traceability. Application
authorization, migrations and connector scopes follow the verified
implementation. Recover using the compatible evaluator and quarantined
encrypted restore, preserving applied migrations and assessment history.
OD-013 and OD-014 apply. Original19/20 capture is stopped.
