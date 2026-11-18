# Reviewed CSV import software acceptance

Status: acceptance decision pending this record's independent review, required
checks and verified merge.
Story: STORY-009 / EPIC-02.
Requirements: FR-CON-006 and FR-CON-007.
Criterion: AC-CON-005. Tests: E2E-CON-005 and FAIL-006.
Issue: [#7](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/7).

## Scope and authority

FR-CON-006 and AC-CON-005 allow either Excel or CSV. The implemented CSV
journey satisfies this story's approved format alternative. The Product Owner
selected durable reviewed proposals as the result of saving chosen rows. The
controller records the software acceptance under the existing delegation.
[Requirements](../02-requirements/FRD.md) ·
[Acceptance criteria](../04-delivery/ACCEPTANCE_CRITERIA.md) ·
[Product Owner decision](../00-governance/DECISION_LOG.md#exec-009-reviewed-spreadsheet-import-semantics-2026-09-24) ·
[Delegation](../00-governance/DOCUMENT_CONTROL.md#delegated-approval-and-merge-gate)

## Executed behavior

| Requirement or test | Evidence from the merged implementation |
| --- | --- |
| FR-CON-006 | A PMO administrator configured the source mapping, uploaded CSV through the installed application and saved one explicitly selected eligible proposal. Native tests use the restricted API role and enforce current customer, project and source-reader permissions. |
| FR-CON-007 | Before saving, the application showed the configured columns, field and date mapping, row validation and planned changes. Both packaged profiles exercised real CREATE and INVALID rows, then separately UPDATE and UNCHANGED under the trusted server baseline. |
| AC-CON-005 and E2E-CON-005 | In both packaged profiles, the first journey saved only CREATE ordinal 3 and left the invalid row and the other eligible row unselected. The comparison journey saved only UPDATE ordinal 1 from its exact parent preview. Canonical snapshots matched before and after saving and replay. The API-mocked browser test additionally exercised CREATE, INVALID and UPDATE together in one preview. |
| FAIL-006 | Connected rename and move previews withheld proposals for the affected rows and disabled selection. Separate domain and native tests cover duplicate identities and stable retained record binding. |

The original browser acknowledgement for the selected CREATE save was lost
after the server durably committed it. Explicit retry sent the same command
and selected ordinal, reused the receipt, and left a single durable review.
The comparison journey also replayed the exact preview and reviewed-row
selection after environment recreation, with stable receipt IDs and the same
native state. Recovery confirmed retained receipts, source-scoped data and
lineage before mutation probes in quarantined bundled and external restores.
[Stage 5 proof](INGESTION_ASSURANCE_VALIDATION.md) ·
[Stage 6 evidence](../04-delivery/exec-plans/EXEC-009-trusted-csv-baseline.md#merge-and-post-merge-evidence)

## Review and hosted gates

An independent whole-story audit matched FR-CON-006/007, AC-CON-005,
E2E-CON-005 and FAIL-006 against the merged source and original evidence. The
audit found the approved CSV functionality covered. The reviewed head
`72505ef10250a85c860f749a82aef37ff08f9379` and its prior main base
`71cc0effee68e7e32308806c3eec2093cacf3d8f` are the second and first parents,
respectively, of merge `ab2745c4ed7b47e2a91667f1c085421952b4ee3f`. Its tree
`121f833a179bde0cff86b2af4c54abc5fe6ca2c2` equals the exact tested synthetic
merge tree. [Implementation PR #168](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/168)

- Required candidate checks passed. The first verify job timed out on the
  history-capacity test. Its unchanged-head retry passed the test, 2,889 units,
  386 native tests with one skip, recovery, browser tests and dependency audit.
  Candidate packaged acceptance passed in its first attempt. [Foundation](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/44185618881) · [Documentation](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/44185618987)
- Independent reviewers accepted the original fixture receipts, all ten CSV
  screenshot hashes, source-scoped replay and native restoration in both
  profiles. The 28 migration checksums and 87 business tables matched, with
  API and worker access quarantined. [Packaged evidence](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/44185618881/artifacts/14374174894)
- Both post-merge workflows passed on their first attempts against the actual
  merge. Their verification includes the history-capacity test, browser and
  packaged workflows, and recovery. [Foundation](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/44194349593) · [Documentation](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/44194349534)

## Recovery and acceptance boundary

Revert application changes through review while retaining applied migrations
and all immutable receipt history. Restore into a separate quarantined database.
The acceptance record itself introduces no runtime or database change.

This decision takes effect after the acceptance record's exact-source review,
required checks and verified merge. Issue #7 remains open for STORY-006/007
and their unfinished criteria. The separate XLSX implementation and source
publication work remain open. OD-013/014 apply, five distribution holds remain
open, and Original19/20 capture remains stopped.
