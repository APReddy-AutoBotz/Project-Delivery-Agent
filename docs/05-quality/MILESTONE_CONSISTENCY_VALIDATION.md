# Milestone reconciliation validation

Current scalar-gate update, 2026-09-22: PR54 now implements the formerly missing
generic reconciliation request and FAIL-009 recovery behavior. See the exact
[scalar merge and criterion disposition](SCALAR_RECONCILIATION_VALIDATION.md).
The older Stage3 checkpoints below remain historical; their scalar-gap statements
are superseded by that record. GOLDEN-003/STORY-012/Issue6 remain open with no
narrowing of the shared health/leadership-answer contract.

Issue: [#6](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/6).
Plan: [EXEC-007](../04-delivery/exec-plans/EXEC-007-milestone-reconciliation.md).
Partial requirements: FR-EVD-004/009/010/012, FR-ADM-005; recorder repair:
NFR-SEC-004/005, NFR-REL-001/002, SEC-SECRET-001. ADR-009/010/014 apply.

## Verified Stage 3 integration (2026-09-13)

[PR #51](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/51)
merged candidate `9b33dec67ff65c2e6e24fe139353780618ca3e85` as
`42bcd1104a709fc2adab5368f277144f390f42c9` at `2026-09-13T12:15:23Z`.
Tree `7f812b867ebfbda7c92b290cd34ded5a0865538a`, ordered parents
`1c92e92dac63d677b7d7e5d3e562cd53303ea27f` and that candidate, all 62 changed
raw Git files and all five unchanged released migrations were verified after
merge. Clean local HEAD/main/origin/main and authenticated remote main agreed.
The [public integration gate](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/51#issuecomment-5653200161)
and [observed merge record](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/51#issuecomment-5653230820)
preserve the exact source, reviews, original evidence and limits.

This follows Stage 1 [PR #49](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/49)
and Stage 2 [PR #50](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/50).
It completes the approved canonical milestone request increment, not the entire
source-conflict story. **STORY-012 and Issue #6 remain open; R0 is 3/5 and R1 is
2/33 accepted stories.** The remaining scalar-request gap is specified below.

### Required checks and original evidence

[Foundation 34754258547](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/34754258547)
and [Documentation 34754258540](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/34754258540)
passed on the exact candidate. CI checked out synthetic merge
`cede05a7b333a359dbebf9a60f155da71c704146`, whose tree and ordered parents match
the later verified integration. Evidence includes:

- 1,133 unit/contract tests in 49 files, 107 database/API tests in seven files,
  26 native browser tests, seven package builds, lint/types, architecture,
  generated OpenAPI matching, exact dependency checks and package audit.
- Documentation catalogs (245 requirements, 91 criteria, 38 stories, 135 tests)
  and all 13 documentation regression tests.
- Six migrations, clean/repeat deployment, exact 39-table plus ledger native
  recovery, five genuine populated-prior-schema upgrade paths, and primary plus
  bundled/external quarantined restore. The foundation-only prefix has no fact
  rows; data-bearing prefixes retain their original facts and ledger rows.
- Nineteen intact packaged groups, real TLS/OIDC and natural expiry, both shipped
  customer profiles, current permissions, disclosure completion and teardown.
  Mounted composite runs are separate development evidence, not these originals.
- Eleven independently validated native COMMIT matrices, each with three positive
  and nine negative cases (132 controls), and eight six-case actual-API-role race
  matrices (48 cases). Restored probes retain their reserved project identities,
  exact transport/effective roles and negative rollback fingerprints.

Original packaged fixture `pdaa-acceptance-1789298537994-04cff15d` completed at
`2026-09-13T11:42:25.050Z`. Its 3,243,796-byte production JSON has SHA-256
`0c356a24b0ffcb13615d17c81e1824b2b58a2db59e679ecb32f878a2eb1820bd`.
It is byte-identical inside the schema-11 distribution evidence. Authenticated
GitHub artifacts are database `10315919165`, evidence-browser `10316198715`,
PM-browser `10316103796`, production `10317555520` and distribution `10317420940`.
Separate non-author reviewers checked all five ZIP digests and all 106 members,
including the 87-file distribution manifest and original profile screenshots.

Retained SHA-256 anchors: source review
`472bc422df15c86595e9d9638ba0bb5777c9b3b8576d637c1b5f9f35ca124a03`;
acceptance attestation
`bb0174bc401a27c658104908a0fa4e3c659421af219254874459e4e33db39634`;
distribution attestation
`b43b52dcb1124b0d0ff7b966098e91649f45bf9754c7946a81edeb56ce69aedd`;
premerge result
`05e8e01c43a5ca1f3305efe2155bd612eb4bec380373ab8e6fe2abc4b5285fdb`;
postmerge closure
`418836e3236ca60f19afade49b6cf17e664e1c68bf60389fca94ca43e7c79c12`.
The independent gate's 237 synthetic controls are private verification-tool
tests, not additional product/acceptance test counts or reviewer authentication.

Post-merge Documentation 34756594363 passed. Foundation 34756594365 was still in
progress at this record's initial preparation. Its automatic main repeat has a
separate outcome; candidate success does not establish that repeat's result.

### Implemented user and authorization boundary

Both real authenticated PM workflows retain a COMPLETE milestone plus three
explicitly linked mandatory OPEN work items, with four typed state bindings,
original contributor/source revisions and independent provenance/freshness/conflict.
The creator and configured PM are distinct identities. The request remains OPEN,
historical and unresolved; human statements remain HUMAN_CONFIRMED, not verified
connector observations. No value is silently selected or source record changed.

Atomic request dedupe compares the complete contributor identity as well as its
hash. Command retries and assignment history are separate from the business case.
Exactly one configured eligible PM is required; missing/ambiguous/ineligible
assignment remains explicitly unassigned. Management permissions do not substitute
for the actual recipient's current IdP role, matching grant and all original source
permissions. A later negative check does not close an earlier request.

Original HTTP-body and screenshot hashes bind source withdrawal/regrant, saved-link
reopening after API recreation and project withdrawal. Both scope-denial images
prove removal of the explicitly refreshed PM request article and captured COMPLETE
value with a fixed HTTP 404 alert. They still show other previously loaded project
panels and the old queue row: they do not prove immediate whole-page clearance or
eventual broader polling from a static image. Server authorization applies on every
read. A GET/queue view proves neither human reading nor notification or approval.

### Criterion/test disposition and remaining acceptance gate

| Contract | Executable contribution and disposition |
|---|---|
| AC-ADM-003 / AC-EVD-003 | Already accepted through PR #47; historical authority and freshness evidence remains in [project evidence validation](PROJECT_EVIDENCE_WORKFLOW_VALIDATION.md). |
| AC-EVD-004 / INT-EVD-004 | Literal conflict preservation and no silent selection are implemented: `tests/source-authority.test.ts`, `tests/authority-persistence.integration.test.ts`, `tests/project-evidence.integration.test.ts`, and `tests/e2e/project-evidence.spec.ts`; canonical proof/request adds `tests/milestone-reconciliation.integration.test.ts`, `tests/e2e/milestone-reconciliation.spec.ts` and both-profile `scripts/acceptance/milestone-reconciliation-workflow.mjs`. INT-EVD-004 is implemented; complete criterion acceptance remains withheld pending FAIL-009. |
| FAIL-009 | Remains planned. Its referenced [recovery specification](FAILURE_AND_RECOVERY_TESTS.md) requires a reconciliation request for source conflict. Canonical requests are proven, but generic scalar conflicts still only expose `reconciliationRequired`; the evidence UI explicitly says no request was created. |
| GOLDEN-003 | Remains planned. The canonical COMPLETE/three-OPEN PM-presentation contribution is proven, but the shared catalog also requires the health/leadership-answer behavior of AC-HLT-005 / AC-QA-005. This PM view is not that answer. |
| STORY-012 / Issue #6 | Not accepted/closed. FAIL-009 belongs solely to AC-EVD-004, unlike the shared golden test. Do not discard its recovery requirement because its shorter YAML behavior mentions only retained values. No requirement, test definition or ownership is narrowed. |

The scalar resolver's `REQUEST_RECONCILIATION` policy currently sets a flag; it
creates no durable request. A scalar-CONFLICTING target cannot be routed through
the canonical milestone rule: that rule requires every scalar target RESOLVED,
otherwise returns UNKNOWN and the repository records NO_REQUEST. Reusing a
milestone request with an invented milestone or weakening that predicate is not
an acceptable completion. Next is a separately reviewed generic scalar-conflict
request design, with explicit creation permission, proof/dedupe identity, current
PM/source authorization, additive integrity/ACLs and migration/recovery contracts.

### Preserved failures, release and recovery limits

The fe2010c packaged expiry failure, rejected 83ccfa1 awaited-body P1 and its
post-close disclosure failure, ac54be7 external-restore failure of unknown cause,
and earlier local/composite failures remain historical failed or limited evidence.
Current success is separate evidence, not a waiver. The denial fix consumes
discarded bodies without delaying known status handling; graceful fixture logout
retains both unchanged recorder assertions. Fixed restore-phase diagnostics label
the first entered failing phase, not an independently proven root cause. No
assertion, deadline, warning rejection or recorder completion gate was relaxed.

Distribution retains 2,798 scanner-match occurrences, 840 High/Critical
occurrences, 112 existing dispositions and 728 unresolved High/Critical occurrences.
These are scoped occurrences, not unique CVEs. Package coordinates are unchanged
from PR #50; eight existing PCRE2 finding metadata variants now report a fixed
version without changing the installed package or granting a disposition. All five
inventory/licensing/vulnerability/distributed-layer/signing release gates remain
open under ADR-014. No customer release, real-data activation, connector scope,
AI call, external messaging/write, acknowledgement or source resolution is added.

Migration 6 adds three append-only histories (39 business tables), mutual
check/capture integrity and a transactional source-temporal index; the five released
migrations stay byte-identical. Finite runtime ACLs give the worker no reconciliation
access. Use a compatible application revert while preserving additive history, or
the matching reviewed operations image and encrypted backup into a fresh target
whose runtime CONNECT access remains quarantined. The default development database,
retained fixtures and user volumes were not reset or deleted.

## Historical premerge continuation status (2026-09-13)

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
