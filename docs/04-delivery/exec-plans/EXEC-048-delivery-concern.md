# EXEC-048: Delivery concern and PM review

Status: In Progress
Owner: Implementation controller
Requirement IDs: FR-HLT-007, FR-HLT-008, FR-HLT-009, FR-MOD-006
GitHub issue: https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/8
Target release: R1
Last updated: 2026-11-23

## Objective

Complete STORY-015 and GOLDEN-002 through a reproducible assessment that records a reported Green and an independently calculated concern. The completed-milestone contradiction uses the existing AC-HLT-005 and GOLDEN-003 acceptance evidence.

## Current state

Main at `8a5ab52df7791e4bcbe03587624dcdd58c7a92af` preserves reported status, schedule calculation and blocker age separately. The prior RED browser case covers schedule evidence. It is still useful as a regression but does not exercise GOLDEN-002 end to end.

## In scope and proposed design

Add an optional critical-target classification to the saved project schedule policy revision. A PMO administrator selects exact canonical milestone and RAID item IDs already in the sealed project. Policy changes require both the pmo_admin token role and a current matching pmo_admin grant on this project or its portfolio. A token with multiple roles cannot use a different role grant for this write. The selection is classification for this delivery rule. It does not update milestone or RAID source records, attest blocker inventory or establish which records block delivery. A RAID item must still be open and backed by the existing verified blocker proof to support a positive signal. Check the exact scoped RAID state under the Project gate. A missing candidate in the age output cannot prove closure. Require explicit inventory attestation even when the age evaluator returned an assessed item. Require a complete policy value on a change, using project grant, sealed graph, optimistic revision, lock and audit gates already used by schedule policy. An omitted field from an existing client preserves the prior selection. Explicit null disables the new calculation. Existing projects and historical policy revisions start unconfigured. Store a bounded, sorted, duplicate-free selection. Validate each configured ID inside the exact project and target type at write time and revalidate its identity when assessed. Freeze the applied revision with the result.

Configuring an explicit empty set means the project has designated no critical targets of that type. It conveys no evidence about the completeness of source data. Age, descriptive text and model output do not establish criticality. A closed, cancelled or explicitly excluded RAID item cannot cause a critical blocker signal. Missing, contradictory, stale or inaccessible evidence for an open configured candidate remains unassessable. The existing blocker logic requires an attested inventory and a current delivery-blocking classification and open-period date before it presents an assessed item. Preserve those requirements. An assessed open critical blocker contributes regardless of whether it also crosses the existing age threshold.

## Same-time assessment

Extend the existing manual save and latest/replay service with a separately versioned delivery-concern facet. Preserve the current schedule calculation and blocker-age displays, fields and frozen results. Read the configured policy, schedule, blockers and update inputs in the same scoped transaction under the existing Project and authority/source access gates. Bind all inputs to one database assessment instant. Schedule days use the project schedule time zone, blocker age uses its existing UTC rule, and update freshness uses the cadence policy's elapsed seconds. Preserve those rule inputs and time zones on the assessment. Never compose a prior saved schedule, blocker or freshness result.

Reuse the cadence observation and its timestamp selection in a read-only internal method. A valid selected update timestamp follows the existing freshness boundary. When no trusted update timestamp is available, show that freshness could not be assessed for this rule. Do not label the project's creation date as an actual update. This distinction applies to the concern facet. The cadence workflow retains its existing creation-date fallback and obligation semantics. Keep authorized cadence policy revision, time basis, applied window, dates and supporting source references. Recheck all source dependencies needed for the calculation on create/latest/replay, including alternative versions read for the authority decision. If current scope or dependency access is missing, the entire frozen envelope must be withheld. A policy change alone does not recompute a replay. Preserve the current retention, audit and content budget.

The explicit calculation applies these bands:

- An overdue configured critical milestone or an authority-backed configured open critical blocker is a red-band signal. A critical milestone follows the existing forecast-then-planned date and minimum overdue-day rule. Label its inputs as configured canonical schedule evidence.
- A stale trusted update is amber. A missing required observation prevents a settled Green or Amber. Independently proven Red stays Red with the applicable limitations shown.
- When every configured signal is covered and none is elevated, the calculated concern is Green. With no opt-in policy, show only the existing schedule and blocker-age facets.
- Reported Green with calculated Red or Amber recommends a PM review. Show the recommendation alongside the assessment result and the applicable source signals. It is read-only guidance and never sends a request or changes the reported Green.

Use the existing deterministic delivery engine for severity bands and retain exact input values, ordered identities, rule revision, rationale and a separate recommendation. The calculation snapshot enumerates every configured signal, including explicit unassessable entries. Enumeration does not imply that every source was assessable. Propagate query, integrity and transaction failures. Use the existing saved assessment receipt, authorization, retention, immutable result, audit and UI request model. Unknown coverage, inaccessible inputs and capacity limits must remain visible without exposing restricted evidence. Do not silently truncate or publish a concern from a discarded input family. Keep the blocker inventory and existing advice rank contract as documented in EXEC-011 and EXEC-027. This is a named delivery calculation, separate from the existing schedule RAG.

## Implementation and evidence

1. Add an append-only schema migration for the optional policy and new saved-assessment rule revision. Keep old policy/assessment rows readable; keep API and worker privileges at the existing table boundaries. Update the production upgrade/recovery inventory and schemas as applicable.
2. Add a domain result and input schema, authorized policy write/read and exact-clock composition in the assessment transaction. Validate saved/latest/replay disclosure, policy races and revocation on cadence and blocker evidence. Expose policy controls to the existing scoped administrator and show the calculated result, evidence and PM recommendation on the existing project health page using its layout.
3. Add a real synthetic browser/native GOLDEN-002 fixture with the same project reporting Green, a designated critical overdue milestone, authority-backed open designated critical blockers and a genuinely stale trusted update. Use real packaged API and native persistence. Assert separate reported/calculated values, exact target IDs and date/threshold/provenance, identical as-of time, current-access denial, immutable replay and the PM review recommendation. Test fresh/absent update, inaccessible or conflicting blocker, young critical blocker, closed critical target, noncritical aged blocker, missing dates, unconfigured policy, timeout/size behavior, cross-project IDs, mixed-role grant denial and simultaneous classification changes. Keep the existing E2E-HLT-004 and GOLDEN-003 cases.
4. Run lint, typecheck, build, contracts, unit, native, production/recovery, browser and documentation checks. Obtain separate non-author exact-source and test-coverage review. Verify hosted checks on the candidate and the resulting main commit. Record immutable evidence and only then assess STORY-015 and the GOLDEN-002 registry entry.

If rollout must be stopped, use an authorized policy revision to disable the delivery facet for the affected project. Preserve historical rows. Deploy compatible API, web, assessment readers and policy writers together. A pre-feature writer cannot preserve a configured classification, and a pre-feature reader cannot decode a saved delivery-concern revision. During rollback, stop incompatible writers and retain compatible readers or use a forward fix. Use the established quarantined backup and restore procedure if database recovery is necessary.

## Scope limits and impact

The migration adds a nullable field and a supported assessment revision to existing tables. Retain the current table privileges, retention and immutable audits. The scope adds no dependency, external message, connector capability, write-back, AI provider access or release activation. The implementation uses synthetic evidence. Original19/20 capture remains stopped.

## Decisions and progress

- 2026-11-23: Independent non-author review approved corrected design SHA256 `E0D2F0B6A935D643195AB28A74B1B5813BD23CB2D6089E0032EA92F4FE172E26`. The review required a matching scoped PMO grant, explicit inventory attestation, distinct closed and unknown states, whole-envelope access rechecks and compatible rollout.
- 2026-11-23: Development added the separate concern calculation, revisioned policy, persistence, the project health UI and synthetic test cases. Exact-source review and hosted verification remain pending.
- 2026-11-23: The same GOLDEN-002 browser assertions now drive the synthetic development stack and both packaged customer test profiles. The customer restore check compares the saved assessment, its receipt and the policy history against the original storage digest.

## Validation evidence and completion

This plan records implementation and design progress. Software acceptance requires the complete browser/native scenario, exact-candidate and post-merge gates, and a verified evidence ledger.
