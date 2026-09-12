# Milestone consistency kernel validation

Issue: [#6](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/6).
Plan: [EXEC-007](../04-delivery/exec-plans/EXEC-007-milestone-reconciliation.md).
Partial requirements: FR-EVD-004/009/010/012, FR-ADM-005; recorder repair:
NFR-SEC-004/005, NFR-REL-001/002, SEC-SECRET-001. ADR-009/010/014 apply.

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
