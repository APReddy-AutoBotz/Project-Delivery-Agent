# EXEC-017: Deterministic advice and queue core

Status: In Progress; independent design review approved the limited groundwork.
Owner: Implementation controller
Target release: R1
Date: 2026-10-21
Issue: https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/11
Requirements: FR-ADV-001, FR-ADV-002, FR-ADV-006, FR-ADV-007, FR-ADV-008,
FR-RPT-002, BR-013, NFR-REL-003, NFR-SEC-001.
Criteria: AC-ADV-001..005 and AC-RPT-003 (partial internal groundwork only).

## Objective and dependency boundary

Implement a pure, typed, runtime-validated recommendation builder and deterministic
queue ranker in the domain package, on verified main c52ab15c29f5f5a00049e395f38e06a9d364a93a.
This independent groundwork uses the merged health evaluator. It does not depend
on the unfinished EXEC-016 runtime or its stopped research-artifact capture.
Keep that capture stopped. Preserve existing work and retained evidence.

EPIC-06 remains a dependency for the complete EPIC-07 product journey. This batch
adds no repository reader, API, browser page, provider adapter, network call,
approval execution, scheduler or database migration. The CI repair below patches
existing dependencies. This increment cannot accept
Issue #11 or claim SEC-RPT-003/E2E-ADV-002 coverage. Preserve the Antigravity UI.
OD-013 continues to disable public OAuth/live Jira activation; spreadsheet commits
remain reviewed proposals. Accepted totals remain 5/38 stories.

## Internal contract and authorization prerequisite

One bounded pure function takes an explicit as-of instant; an intended recipient
(subject and project-manager or leadership audience); current readable project IDs;
current assigned project IDs; and project snapshots. Each snapshot contains an
explicit project ID, validity deadline, the existing delivery-health evaluator's
input and preauthorized pending approval metadata. All values are runtime checked;
errors contain a fixed message without submitted data.

These are trusted application inputs, not credentials or a model/public request.
The future server reader must load current customer, identity, role, project,
assignment, source/evidence disclosure and approval-review permissions itself in
one consistent scope, and derive snapshot validity from active policies. The
pure function's filtering is defense in depth, not a server authorization boundary.
It grants no approval capability. Project managers see only the intersection of
readable and assigned projects. Leadership sees readable projects. Approval items
also require an exact, currently authorized reviewer subject supplied by the reader.
Do not disclose hidden-project health or approval content in results or errors.

At most 25 project snapshots, 500 total signals and 100 total pending approvals
are admitted. Reject duplicate project/signal/proposal identities and ambiguous
scope entries, rather than truncating. Validate canonical UTC instants and bounded
identifiers. Reject future assessments/approval creation, mismatched project IDs,
nonpositive snapshot validity intervals and duplicate fact references. Expired
snapshots/approvals are withheld at the exact deadline. No persistent cache exists.

## Rule mapping and evidence

Recompute the supplied snapshot through the existing assessDeliveryHealth function;
do not trust a caller-supplied calculated RAG or altered result. Preserve reported
RAG, source facts, source record revisions, rule parameters and as-of time. Advice
is a RULE_BASED_SUGGESTION, not a newly confirmed fact or source-authority decision.
No cause or personal blame is inferred. Source text is retained only inside the
preauthorized trigger data, never interpolated into action/outcome templates.

Version advice rules and rank policy as advice-core@1. ACTIVE blocker-age signals
produce escalation/forecast review suggestions for PMs and intervention decisions
for leadership. ACTIVE overdue milestones/work items produce schedule review;
ACTIVE freshness/completeness signals produce update follow-up. ACTIVE
SCHEDULE_COVERAGE produces evidence review. UNASSESSABLE
signals produce LOW-urgency evidence review, never a verified delivery claim.
CLEAR signals produce no item. A reported/calculated mismatch produces a separate
reconciliation suggestion retaining both values and the original contradiction rule.
No new date, severity threshold, source-authority rule or automatic action is added.

Pending approvals preserve immutable proposal ID/revision, existing urgency,
raised/expiry times, rule and exact fact/version/evidence references with independent
provenance, freshness, conflict and assessment time. They suggest review only and
cannot approve or execute. Fixed wording requests reconciliation if needed, without
treating human confirmation as authoritative publication.

Every item contains concern identity, project, recipient, trigger, triggering rule,
urgency, suggested action, expected outcome, approval requirement, validity and
as-of metadata. The same concern identity is used across audiences. Output is
deeply immutable and detached from caller inputs. No AI configuration or provider
is needed, so deterministic output remains available when AI is disabled.
The approval requirement describes review before taking the suggested action;
it is not a grant, an executed approval, or a claim that reading advice writes data.

## Ranking policy

Order by CRITICAL, HIGH, MEDIUM, LOW; then intervention, pending approval review,
update follow-up, reconciliation, schedule review, evidence review; then original
trigger time oldest first; then a stable ordinal string identity. Use code-unit
comparison, not host locale. Preserve all admitted eligible items. Ordering,
templates and identity are deterministic under input permutation.

## Validation and review gates

Independent nonauthor design review precedes implementation. Add focused unit
tests for every mapping, role wording, complete evidence, AI independence, sorting,
permutation, immutability, deadlines, malformed/bounded inputs, exact reviewer,
assignment and hidden-project exclusion. These are internal unit tests, not
claims of full golden/model/browser/server authorization acceptance.

Run applicable lint, typecheck, unit, build, architecture and documentation checks
using pinned dependencies. Run no database, Docker or capture utility for this
pure batch. Record exact results and limitations. A separate nonauthor source and
coverage review must bind the immutable final candidate before publication/merge;
required exact-head remote checks and verified merge-tree gates still apply.

## Recovery and next stages

Revert the additive domain/export/documentation change through review; there is
no schema or data recovery impact. Next: current-scope repository readers and
approval integration after EPIC-06 contracts; then API/browser workflow with
server revocation/denial tests and full Issue #11 acceptance evidence.

## Progress log

- 2026-10-21: Reconciled main through PR #109. Created an isolated checkout without
  changing the unfinished EXEC-016 tree. Existing lockfile hashes match; reused
  pinned dependencies through local junctions, with no installation. Independent
  nonauthor design review found no blockers. Recorded both review clarifications:
  exhaustive SCHEDULE_COVERAGE handling and non-authorizing approval metadata.
- 2026-10-21: Implemented the bounded pure core and 56 advice tests. All eight
  packages build/typecheck; 63 advice/health tests pass. Source review found and
  corrected a P2 omission of clear-signal evidence in reconciliation. Coverage
  review's three guard-isolation improvements are implemented. Full final
  regression, immutable candidate re-review and remote merge gates remain open.
- 2026-10-21: Corrected source candidate `652bb30b197b3159858d583d174e2592d04f9574`
  passed full lint, new-test lint, domain rebuild, architecture/docs checks and
  all 1,804 unit tests/105 files (two workers, unchanged deadlines). Both independent
  source/coverage reviewers approve it without remaining findings. Earlier failed
  and interrupted validation attempts are retained and supply no passing credit.
  Final record-only review, exact-head remote checks and verified merge remain gates.

## Required CI dependency repair design, 2026-10-21

NFR-MNT-004 / CI-MNT-004: the first normal PR #110 Foundation run
39647616494 passes build/contracts/lint/types/all 1,804 unit tests and registration,
then fails the unchanged high-severity audit gate. Its original log is retained.
Primary publisher advisories identify existing proxy-addr <2.0.8
(GHSA-jqcg-44mw-7w3h), source-map-js <1.2.2 (GHSA-68fv-2mgg-jv7q), and
Vite 7.3.6 (GHSA-587h-7wmj-h5pm). Upgrade to the minimal same-line publisher
patches 2.0.8, 1.2.2 and 7.3.7. Verify registry identity, permissive license,
tarball integrity and actual lock graph before adoption. Pin exact overrides
for all three paths and update the direct web Vite pin and existing machine-readable
adoption/override/notices records. Do not regenerate unrelated adoption decisions.

proxy-addr is runtime through Express; source-map-js and Vite are development/build
tooling. No first-party network/auth setting changes. Keep all audit thresholds and
tests; do not suppress findings. Moderate findings and the five release holds remain
separate. Preserve the reviewed advice implementation and stopped research capture.

Before installation, move only this checkout's created dependency links/directories
to ignored local backup paths, verifying absolute paths remain inside this checkout.
Create its own fresh dependency tree so installation cannot alter the unfinished
EXEC-016 checkout's modules. Retain the prior links/evidence. Refresh the lockfile
through the pinned package manager, inspect its complete diff, perform a frozen
install and publisher license inspection, audit, full build/types/unit/docs checks,
then independent exact-head source/coverage review and fresh required CI. The
runtime patch also requires the packaged/customer CI gates. Revert the exact
manifest/lock/register patch and rebuild through review for recovery; do not deploy
or mutate any customer/default database. Independent design review approved this
bounded repair with no blockers. The original shared dependency entries have been
preserved under ignored local backups; their targets remain unchanged.
Fresh frozen installation, physical license inspection, exact registry/lock SRI
comparison and 42-record registration pass. The unchanged audit reports zero high,
zero critical and four moderate findings. Only the three intended package identities
and associated references/peer pins change in the lock. All 39 unrelated adoption
records remain unchanged. Full patched-graph validation and exact-head reviews/CI
are in progress; no release hold or acceptance count changes.

Patched-graph final local checkpoint: actual `pnpm build`, `pnpm lint`,
`pnpm typecheck`, `pnpm test --maxWorkers=2` pass; the latter verifies all 1,804
tests/105 files in 172.06 seconds without changing deadlines. New-test lint,
architecture and documentation checks also pass. Both independent reviewers
approve exact dependency candidate `97c341c59b53bb8e637970b43130e7b762dbc904`
without findings. Final record-only review and fresh exact-head hosted/customer CI,
expected-head merge and actual merged-tree verification remain open.

## Distribution advisory metadata refresh design

NFR-SEC-010 / AC-MNT-004: the initial normal Foundation run's packaged production
and customer acceptance passed and uploaded its production record. The later
distribution collector failed the intentional exact-advisory check for
CVE-2026-8376. Its original complete job log is retained locally. The scanner
reports Debian fix metadata `state: fixed`, version `5.36.0-7+deb12u4`, with
availability `{version: 5.36.0-7+deb12u4, date: 2026-10-06, kind: first-observed}`;
the policy still expects `wont-fix` and no versions.

Primary [Debian tracker](https://security-tracker.debian.org/tracker/CVE-2026-8376)
and [DLA-4821-1](https://security-tracker.debian.org/tracker/DLA-4821-1) confirm
bookworm u3 remains vulnerable at the source-package level and security u4 is
fixed. The primary CNA record still identifies a 32-bit-build precondition.
This is source fix availability, not evidence that the pinned u3 image was patched.
The scanner's first-observed date is not treated as a publisher release date.

Refresh only the exact expected fix object in perl-disposition-policy.json after
independent review. Retain every exact package/material/layer/relationship,
source/advisory description, primary CNA, analysis hash, ELF64/8-byte build proof,
match-envelope, target/scope and not-applicable-precondition constraint. No matcher
relaxation, wildcard, base image change, new not-applicable rule or new subject
execution is allowed. The existing narrow architecture disposition is unchanged;
whole-image/embedded-runtime absence and release approval remain false. Other
CVEs remain open. Retain original scans and historical policies unchanged in Git.

Add regression checks for the exact new source fix metadata and rejection of old
wont-fix state, altered version/availability/date/kind and extra metadata. Re-run
the Perl/disposition tests, full unit suite, lint/docs and unchanged dependency
audit. Application source/dependency blobs are unchanged from fully validated
3ac3bea, but the new candidate still requires both exact-head independent reviews,
fresh complete normal CI including packaged/customer/distribution replay, and
verified expected-head merge. Do not treat the failed collector as a passing scan
or waive distribution/signing/security holds. Recovery is the reviewed policy/test
revert; no database or capture action is involved. Independent design review
approved this bounded refresh without blockers. The selected-description negative
now changes the new `fixed` state to `wont-fix`, preserving a genuine rejection.

Final refresh local checkpoint: focused Perl/gosu 174 tests and full unit 1,816
tests/105 files pass (86.60 seconds, two workers, unchanged deadlines). Required
lint, advice-test lint, architecture, 42-record dependency registration,
documentation and unchanged audit pass (zero high/critical, four moderate).
No application/dependency blob changes from the validated build/typecheck input.
Both exact-head independent reviews and fresh complete CI remain merge gates.

## Exact match-envelope metadata amendment, 2026-10-22

The reviewed fcfd4cd candidate's normal run 39655156471 passes native validation
(1,816 unit, 161 integration, 43 browser tests and exact 84-table recovery) and
packaged production/customer acceptance. Its later distribution collector accepts
the refreshed fix object, then rejects the independent match-envelope hash:
expected a5208dd3..., observed ccff737b.... No distribution passing credit or merge.

The envelope excludes the selected vulnerability object. Root initially inferred
otherwise, inspected the implementation and corrected that explanation. Retained
ordinary PR #49 scanner records reproduce all 20 existing envelope pins across
eight image/scope inputs. Applying exactly two Grype match-detail changes produces
ccff737b906311180c94021c466c81a276d0235b4ce94e526d515cd6f40359f0,
identical to the failed run's observed hash: `found.versionConstraint` changes
from `none (unknown)` to `< 5.36.0-7+deb12u4 (deb)`, and `fix.suggestedVersion`
becomes `5.36.0-7+deb12u4`. The direct-match profile's corresponding derived hash
is 22159dfe26671c56ed61b52810f3a3179bd5b001bb984a642ca3b0a332471d6e.
The latter still needs fresh live CI comparison; derivation is not a new scan.
Original NVD metadata confirms unchanged CVSS/CWE/reference semantics and is
retained with its original bytes. No stopped research evidence was accessed.

After independent design review, update only the 20 exact envelope pins to these
two derived hashes. This explicitly supersedes the earlier unchanged-envelope-pin
design boundary for these two reviewed fields only. Do not modify the matcher,
normalization, package/material/analysis/CNA/facts pins, disposition, source/image
versions, audit threshold or release holds. Preserve original scanner records,
raw match hashes and historic policies. No broad match or ignored-field rule.

Add small committed public-metadata fixtures for both original profiles and
regressions that reproduce old/new exact hashes, demonstrate the two-field-only
diff, require every target/scope/package pin to match the correct profile, and
reject unexpected match-detail changes. Keep all existing fix-object and physical
proof negatives. Run focused/full unit, lint/docs and unchanged audit, then both
exact-candidate reviews and fresh complete normal CI. Capture stays stopped.
Both independent reviewers approved design SHA256
`6a81e5fb69a9cee9eac46020fed53fcee36a8ff8aa4fd21fc63d35aeb15b5b88`
before implementation. The exact 20 pins and two original public metadata profiles
are now implemented with eight additional regressions. Focused Perl/gosu validation
passes 182 tests. Full final regression passes 1,824 tests/105 files in 104.17
seconds, with two workers and unchanged deadlines. Required lint, separate advice
test lint, architecture, 42-record dependency registration, documentation and
unchanged audit pass (zero high/critical, four moderate). Final immutable
source/coverage reviews and fresh complete CI remain merge gates. No application
or dependency blob changed from the hosted build/typecheck input.
