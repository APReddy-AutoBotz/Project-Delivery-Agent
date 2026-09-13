# Milestone consistency kernel validation

Issue: [#6](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/6).
Plan: [EXEC-007](../04-delivery/exec-plans/EXEC-007-milestone-reconciliation.md).
Partial requirements: FR-EVD-004/009/010/012, FR-ADM-005; recorder repair:
NFR-SEC-004/005, NFR-REL-001/002, SEC-SECRET-001. ADR-009/010/014 apply.

## Current continuation status (2026-09-13)

The sections below retain the original Stage 1 kernel scope and evidence. Stages
1 and 2 have since merged; Stage 3 durable requests, assignment history and PM
proof delivery are an unmerged candidate. See EXEC-007 for the approved design,
current original-run identifiers and failed attempts retained during validation.
Historical statements below that introduce no database or UI describe Stage 1
only, not the complete current candidate.

The Stage 3 candidate passed the full native database suite (107/107), exact
39-table recovery, three native browser journeys, full build/typecheck and schema
comparison. Composite runtime `pdaa-acceptance-1789286752740-5e77eda8` passed six
actual-API-role race scenarios and ten native COMMIT controls on a new TLS fixture
and all five genuine upgrade prefixes. All six original receipt sets also passed
independent host readers. The composite explicitly mounts current code and is not
intact packaged-image evidence. The expanded run
`pdaa-acceptance-1789287570689-b33b7dc9` subsequently passed twelve native COMMIT
controls (three positive/nine negative), six races and all five genuine upgrade
prefixes. Every original receipt set passed both host readers. The new negatives
isolate changed-identity REUSED and coherent predecessor-time corruption and prove
fourteen-family rollback; prior ten-case receipts cannot satisfy this contract.

The full serial unit run passed 1,039 tests before subsequent reader refinements;
later focused runs passed 37 harness controls and 138 receipt-reader controls
separately. The final complete serial suite then passed 1,089/1,089 in 46 files
(262.79 seconds), with no deadline changes. Both packaged PM
profiles, current exact-candidate review and required remote CI remain pending.
No additional story, customer activation, release gate or external delivery is
accepted. Accepted totals remain R0 3/5 and R1 2/33.

## Implemented boundary

`evaluateMilestoneConsistency` accepts an internal trusted complete canonical
target/binding set and raw authority snapshots with one as-of. It reuses the
existing source-authority resolver; canonical configured state and literal fact
keys are never inferred evidence bindings. COMPLETE versus required OPEN or
IN_PROGRESS yields a cross-fact CONFLICTING finding only when every linked state
independently resolves. All agreeing support, original scalar dimensions and the
complete evaluated dependency set remain available. Deterministic contributor
identity excludes retry actor, capture time, assignee and policy revision.

Missing policy/binding, noncurrent or ambiguous/scalar-conflicting evidence,
CANCELLED and zero required items yield UNKNOWN. NOT_DETECTED applies only to this
rule at the supplied time; it is not overall completion or resolution of an old
case. Restricted/invalid evidence withholds the whole finding, including IDs,
counts and dedupe identity. Disabled and incomplete results are minimal envelopes.
All outputs are detached and deeply frozen. Invalid input uses one fixed error.

The shared preflight limits are 51 targets, 1000 versions/sources/recorded
conflicts, 64000 evidence rows/references and a conservative 64000 derived conflict
reference budget. Length checks precede deep parsing. Recorded edges, including
inactive conflicts, and both possible generated scalar conflict groups consume
that derived budget before any resolver runs. Overflow is INCOMPLETE with no
partial proof. The scalar resolver and its individual limits remain unchanged.

## Disclosure repair and evidence

Main `9cc0873bfd8bf0a0d21541f59cdbbe21a87a83a2` Foundation run 34641338774 passed
application verification but failed packaged disclosure during post-upgrade
revocation. Its continuation error remains a failed run with unknown original
response contents. The recorder closed its context before draining queued CDP
captures. It now drains and checks completeness before destroying the context,
still closes on pre-close failure, and retains the drain/check after close.
New arrivals at the close boundary can still fail; no error is suppressed.

Focused native validation passes 60 evaluator cases and 14 disclosure cases.
Two real Chromium tests pass, including a late native response held before its
continuation while close begins and an injected secret that must be rejected.
The fixture keeps original network bytes; no response is rewritten. Unit controls
also cover delayed body reads, newly queued responses, secret headers, a 10-second
deadline, cleanup and late-close failure. Initial fixture failures for incomplete
token fields and missing native base64 decoding were corrected before these passes.

Full native validation, separate immutable candidate review, required remote CI,
both-profile original packaged evidence review and merge are pending. These
focused results do not supersede those gates or reclassify the failed main run.

## Acceptance and recovery limits

This is partial AC-EVD-004/GOLDEN-003/FAIL-009/INT-EVD-004 work. No durable binding,
cross-fact database proof, reconciliation request, PM assignment/delivery, API or
product UI is introduced. Those test specifications remain planned; STORY-012 and
Issue #6 remain open. Accepted totals remain R0 3/5 and R1 2/33. All customer and
distribution release gates and real-data activation remain open.

No database migration, runtime dependency, permission, secret, connector scope or
external write changes. Revert this compatible code/test increment to recover;
preserve existing data, volumes and encrypted recovery evidence. Later schema and
delivery work requires the separate reviewed contracts in EXEC-007.
