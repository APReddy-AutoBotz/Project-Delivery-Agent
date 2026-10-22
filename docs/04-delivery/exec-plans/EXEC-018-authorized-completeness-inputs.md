# EXEC-018: Preserve existing evidence in completeness inputs

Status: In Progress; both independent design reviews approved
Owner: Implementation controller
Requirement IDs: FR-HLT-001, FR-HLT-002, FR-UPD-001, NFR-SEC-001, NFR-REL-003
GitHub issue: https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/8
Target release: R1
Last updated: 2026-10-22

## Objective

Correct the persisted freshness/completeness reader so existing authorized
canonical evidence remains UNCONFIRMED when authority cannot select a current
value. A genuinely absent canonical value remains MISSING. This is a correctness
increment for AC-HLT-001/002, independent of EXEC-016 research. Keep the original
research capture stopped and preserve its files and finite grants.

## In scope

Correct the count passed to assessProjectCompleteness; add native repository and
source-access regressions; verify persisted assessment, preview and API behavior;
record executed evidence and limitations. Keep Issue #8 and story acceptance open
until a separate complete criterion/story review establishes every applicable gate.

## Out of scope

No canonical publication from connector/import proposals, provider/model work,
Jira activation, source-authority selection changes, schema migration, new
dependency, new endpoint, UI redesign, external message or workflow activation.
The independently identified connector-to-obligation handoff remains a later
coherent increment; it is not implemented by this correction.

## Current state

At reviewed candidate fcfd4cd225744779dc2613ff78ab689b04b1dc9a,
DatabaseProjectUpdateRepository.assessInTransaction derives canonicalVersionCount
from candidateVersionIds/supportingVersionIds. Those are authority selections,
not evidence existence. NO_POLICY or UNKNOWN due to stale/ineligible evidence can
have existing authorized canonical versions and empty selection arrays. The pure
completeness evaluator then classifies that input as MISSING/NO_CANONICAL_VALUE.
EXEC-012 requires existing unresolved evidence to be UNCONFIRMED. Its pure tests
provide counts directly and do not expose this repository wiring defect.

The prepared authority result already includes assessed versions with explicit
available/restricted visibility. Raw prepared database versions include protected
rows and must not be counted directly. Historical assessment input/result and
evidence remain immutable. Current reads already recheck project scope and source
readers before disclosing selected values/evidence; do not widen those disclosures.

## Proposed design

Compute the admitted count from prepared.result.versions whose visibility equals
available, independently of selection eligibility. Use the existing complete,
bounded authority result at the same as-of instant; add no unrestricted read or
source query. Preserve INCOMPLETE/REVALIDATION_REQUIRED handling when authority
cannot establish a complete/readable prefix. Do not count restricted placeholders,
connector observations, import proposals or mere ProjectFact definitions as values.

Keep status/conflict, authority selection, trusted timestamp logic, known-position
and selected evidence unchanged. Existing but stale/no-policy/ineligible readable
evidence must yield UNCONFIRMED and the appropriate existing reason code; it must
not become CONFIRMED, refresh latestValidUpdateAt, satisfy an obligation or expose
an unresolved value. An actually empty canonical version set remains MISSING.

Stored historical completeness remains an as-of metadata assessment under existing
project-scope access. Do not rewrite past rows or expose counted IDs, source names,
raw values or new references. Verify current source denial/revocation still omits
protected known-position/preview values and identifiers and cannot make a new
assessment count a restricted version. If independent review finds this changes
the approved metadata-disclosure contract, resolve that conflict before code edits.

## Files and modules expected to change

- packages/data/src/project-updates.ts: the bounded authority-to-completeness input.
- Native project-update integration cases and, if needed, the existing database
  acceptance harness that owns source-authority fixtures.
- Relevant browser/API assertion only if needed to exercise the actual corrected
  persisted output; preserve existing Antigravity presentation.
- EXEC-018, validation/traceability records, document index and implementation status.

## Data model or migration impact

No migration, table or stored schema change. New immutable assessments record
correct counts using the existing shape and evaluator rule; old inputs/results
remain unchanged and replayable. No default local database operation is allowed.
Native checks use explicitly isolated synthetic targets or normal hosted CI.

## Security and privacy impact

Preserve current customer/project/role/service and source-reader enforcement.
Only already-authorized authority result entries count. Add explicit restricted,
revoked and cross-project assertions. Fixed errors and operational logs must not
include submitted evidence or protected source content. This correction grants no
new capability and never turns unknown evidence into a verified fact.

## Connector and permission impact

No connector calls, scopes or credentials. OD-013/014 remain in force and spreadsheet
saves remain reviewed proposals. Existing scheduled service identity/policy gates
remain required; no interactive identity is borrowed for a worker.

## Open-source dependency impact

No new dependency or version change. Preserve the reviewed PR #110 security patches,
exact advisory proof and all distribution/legal/signing/security release holds.

## Implementation stages

1. Bind this design to immutable content and obtain independent nonauthor review.
2. Prepare the bounded reader correction and meaningful regressions in a separate
   local branch from reviewed PR #110 candidate fcfd4cd while its CI runs. Reconcile
   against verified merged main before publication; preserve unfinished work.
3. Run applicable build, lint, typecheck, unit, native repository, API/browser,
   recovery and documentation gates without weakening assertions or deadlines.
4. Independent source and coverage review of the exact immutable final candidate,
   required exact-head CI, expected-head merge and actual merged-tree verification.
5. Record actual results and next work; do not accept a story from this fix alone.

## Test and evaluation plan

- With one existing readable canonical version and no authority policy, assert
  UNCONFIRMED/NO_APPLICABLE_AUTHORITY_POLICY, count one, no trusted update/value.
- With an applicable policy but only expired/ineligible readable versions, assert
  UNCONFIRMED/NO_CURRENT_AUTHORIZED_VALUE and no freshness or satisfaction credit.
- With a defined fact and zero versions, and with an absent required fact, assert
  MISSING/NO_CANONICAL_VALUE; connector/import proposals cannot change that count.
- With restricted/revoked source access, assert REVALIDATION_REQUIRED/unconfirmed
  behavior, zero count for hidden versions and no source/value/evidence disclosure.
- Mix available and restricted versions and count only the available entries.
  With readable stale versions and a recorded conflict but no selected value,
  preserve UNCONFIRMED/conflict rather than rejecting a fabricated zero-count input.
- Preserve current conflict/ambiguous/incomplete handling, exact freshness boundary,
  stable open-obligation identity, service denial, current grant revocation and
  persisted immutable history. Exercise actual repository wiring, not a pure test
  that supplies the corrected count manually. Verify returned, persisted and
  preview/API classifications agree where the workflow exposes them.
- Record exact commands/counts and retain failed attempts without passing credit.
  Full-story acceptance remains a separate review of all approved requirements.

## Rollback and recovery

Revert the reader/test/documentation correction through review and rebuild. Keep
all immutable assessments and obligation history. No data restoration or schema
rollback is required. Historical rows retain their recorded as-of classifications.

## Progress log

- 2026-10-22: Independent next-scope review identified the larger causal ingestion
  handoff gap. Separate STORY-013 coverage review then found this earlier concrete
  completeness defect; prioritize its truth-classification correction first.
  Both independent reviewers approve design content SHA256
  `43da45afb741369195c9eab3cbd1cb8d24fcfe5b09e13ce23d140ec2d8ec164a`.
  Local preparation runs on codex/authorized-completeness-inputs while unrelated
  PR #110 packaged CI finishes; publication requires reconciliation against main.
  This sequencing adjustment changes no design, authorization or merge gate.
  No story acceptance has occurred.

## Decisions made

Use existing available-version visibility as the evidence count boundary; keep
authority eligibility and existence distinct. Retain historical records and
existing disclosure semantics. Capture remains stopped.

## Risks and mitigations

Selection and existence can be confused again: native regressions must derive
both through real authority resolution. Counting raw database rows could leak
protected existence: count only available authority-result entries and test denial.
Treating stale evidence as a trusted update would suppress legitimate requests:
assert no known-position/freshness/satisfaction credit in unresolved cases.

## Validation evidence

Both independent reviewers approve the design hash above without blockers.
Build, required lint, explicit native/browser test lint and eight-package typecheck
pass. Full unit regression passes 1,824 tests/105 files in 111.10 seconds with two
workers and unchanged deadlines. Corrected native validation passes 169 tests/14
files in 255.53 seconds, including all eight new cases, populated prefix-nine
upgrade, 24-migration repeat/clean deployment and storage/retention checks.
Private work is reconciled onto verified merged main 8de60639586bd572d5e34257d07b25e683605b96.
All three project-update API/browser journeys pass in 22.1 seconds on a separate
clean synthetic target. The new classification screenshot is visually checked.
The shared browser helper awaits policy loading before edits; no deadline,
assertion, product form code or Antigravity style changed.
Final standard gates pass: eight-package build/typecheck, required/test lint,
1,824 unit tests/105 files in 82.32 seconds, architecture (eight packages/97 source
files), 42 exact dependency records, documentation (142 specifications) and unchanged
audit (zero high/critical, four moderate). Exact-candidate review and complete fresh
hosted validation remain pending.
The new native file is registered explicitly in the existing harness.
See [validation](../../05-quality/AUTHORIZED_COMPLETENESS_VALIDATION.md) for
executed checks, retained failed environment attempts and privacy coverage.
Planned cases and early review are not passing execution evidence.

## Completion summary

Implementation and local validation are complete; exact-candidate reviews, fresh
hosted CI and merge remain pending. Main reconciliation is verified.
Accepted totals remain R0 3/5, R1 2/33, overall 5/38 (13.2%).
