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
approval execution, scheduler, database migration or dependency. It cannot accept
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
