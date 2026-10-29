# EXEC-027: Current blocker-age advice

Status: PR #122 merged; post-merge Documentation and Foundation passed. The design was
reviewed independently before implementation. Its queue base merged as PR #120,
actual merge `d1f52f45da30925752095784aab0b91d5ece5bab`; candidate and
post-merge Foundation and Documentation checks passed. The separate evidence
PR #121 merged as `5aafae959b88fcd5e141ba8c7be909b1dee31f4a`; its actual
post-merge [Foundation 40927863307](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/40927863307)
and [Documentation 40927863262](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/40927863262)
checks passed. Requirements:
FR-HLT-004/009/011, FR-ADV-001/002/006/007/008, FR-RPT-002, NFR-SEC-001,
NFR-REL-003, BR-013; Issues #9 and #11. This is a partial increment and does
not accept a story or criterion.

The increment adds an assigned-PM blocker facet, an explicitly scoped
leadership endpoint, and separate role-specific presentation. Fifty-seven focused
domain/reader/queue tests and 18 synthetic HTTP contract tests passed; two
mocked Chromium journeys passed. Domain, data, API and web type checks, lint,
architecture and documentation validation passed using isolated dependencies.
Those local results alone do not establish native database permissions, source
or policy races, an authenticated API login, or full no-write behavior. The
reviewed hosted candidate subsequently passed 2,009 unit tests in 122 files,
239 native tests in 19 files, recovery and 50 browser tests, including the
synthetic live leadership journey. Native role tests use `SET LOCAL ROLE` in an
owned disposable database; that is not a separately authenticated API login.
No-write evidence covers its specified tables and proxied operations, not all
possible database paths or SELECT-called functions and triggers. Exact candidate
and merge identities are recorded below; actual post-merge checks passed.
No criterion, story, issue or release hold is accepted here.

## Result and boundaries

Add a current, source-authorized blocker-age observation and suggestions for
authorized assigned PMs, with an equivalent leadership decision-oriented view
where current project grants permit it. Reuse the existing deterministic UTC
calendar-day evaluator and the configured, revisioned customer threshold.
Show each observation's as-of time, coverage and rule; a known aged blocker
may be shown even with PARTIAL coverage, while COMPLETE, PARTIAL and
UNASSESSABLE remain distinct. Only show a positive item if the inventory is
currently attested and that item's classification and opened date are resolved,
current, readable and nonfuture. Do not describe partial or unavailable data as
an empty or clear inventory. Do not name an owner unless current authorized
evidence supports it. A threshold crossing is AGED, not a measure of severity
or proof of criticality. Any presentation order must be separately versioned and
clearly labeled; do not assert an age-derived CRITICAL priority or close
AC-ADV-002. Pending approvals, criticality and execution remain unavailable.
No migration, new dependency, business write or external action is intended.
Say "no open blockers" only for COMPLETE coverage when the trusted result
explicitly says `noOpenBlockers=true`. An attested open blocker below threshold
means no aged review item, not no open blocker; regression-test that distinction.

In the PM queue, render aged-blocker reviews in a separate section ordered by
project ID, target key and RAID ID using `blocker-review-order@1`; do not
interleave them with existing urgency-ranked suggestions or invent severity.
Preserve schedule and update sections and their separate as-of times. Show
target key and state, opened date and field, age in UTC calendar days, threshold
and revision, rule and evaluation time, action and expected outcome, and
authorized inventory/classification/opened-date proof references with access
and authority provenance. Do not claim a configured owner or take action.

The queue remains PM-only, including dual-role actors: the token must include
project_manager, a current matching scoped PM grant and the exact-subject
PROJECT_MANAGER responsibility. Add a separate project-scoped leadership read
whose route explicitly selects leadership wording and requires both the token
leadership role and a current same-customer project/portfolio leadership grant.
A dual-role actor uses that route only with the leadership grant; the PM queue
never falls back to leadership. The separate route's project ID is authorized;
callers never supply actor subjects, source evidence, time or a project list.

## Transaction and evidence boundary under review

Compose the existing blocker-age builder inside a bounded ReadCommitted read
transaction, never from a saved historical health assessment. Authenticate the
actor server-side, enforce current project/portfolio grant and assigned PM or
leadership audience, retain Project SHARE and relevant grant locks, and acquire
the customer shared `blocker-age-threshold:<customer>` advisory lock before
reading the threshold, including the absent-policy case. Hold project, grant,
threshold, authority and source-access gates through validated materialization
and commit. Lock queue Projects in sorted ID order, validate positive PM grants,
then acquire the shared customer threshold advisory/row gate once before any
per-project schedule-policy advisory lock. Retain that threshold gate through
all facets and commit. This follows saved health's threshold-before-schedule
order; do not append a threshold lock after existing schedule reads. Test
contention and fail the complete
response on timeouts or changes. Supported fact, authority, access and RAID
reopen writers acquire Project UPDATE; the supported threshold writer takes the
matching exclusive advisory lock. Sealed RAID state is not immutable: the
authorized reopen operation changes it under the Project gate. Arbitrary direct
SQL that bypasses these supported protocols is outside the consistency claim.
The existing final membership check is a bounded observation; uncommitted or
post-check grant insertions remain possible. Per-facet as-of times are not a
single simultaneous snapshot or a guarantee of post-commit access.

The helper can return broad dependency identifiers and proposed new conflicts.
Do not serialize either directly or persist conflicts, assessments, receipts,
audits, obligations, previews, engagements, stages or outbox records from this
read. Preserve the saved-health disclosure boundary by rechecking all relevant
dependencies against current AVAILABLE access and the actual reader. For every
published inventory, classification and opened-date proof, join each selected
version to its exact customer, project, fact, evidence and source, verify the
supporting evidence set and current access revision, and bind the matching
authority policy revision. Fail closed on incomplete, duplicated, mismatched,
restricted or over-budget proof; never expose hidden IDs or raw unknown reasons.
`blockerAgeDependencies` expects an outer `blockerAge` property: pass
`{ blockerAge: built.input }` to the existing check or introduce a strict shared
dependency-list helper that rejects missing/malformed input. Passing the raw
input must never count as a successful empty check. Add a negative regression
with a restricted nonempty dependency list.

If threshold is unavailable, inventory is anything other than a currently
RESOLVED boolean true (including false), any dependency is restricted, or the
helper proposes new conflicts, return the same nonleaking UNASSESSABLE blocker
facet with no items, raw IDs, hidden-existence reason or clear claim; do not
persist the conflicts. This ordinary facet state preserves usable schedule and
update observations. With true inventory attestation, all dependencies readable
and no new conflicts, unresolved candidates may yield PARTIAL; show only
individually resolved aged cases with coverage visible. Unexpected SQL errors,
inconsistent proofs, membership changes, lock timeouts or budget overflow fail
the whole response generically. Require active canonical RAID, resolved
`blocks_delivery=true`, finite current human-statement authority for inventory
and classification, current uninterrupted opened-at human evidence under
UNTIL_SUPERSEDED, no unresolved conflicts and readable supporting sources.
Create an initially closed fixture before testing the supported reopen; do not
invent a general close path.

Bound each project by the existing 50 RAID candidates and 1,000 each of fact
versions, conflicts and policy revisions; the 51st/1,001st fails closed. The
builder's internal over-limit UNASSESSABLE reasons trigger whole-response
failure; never serialize those internal reasons. Supported sealed canonical
creation caps RAID at 50, so test a 51st sentinel with a mocked/proxied read or
strictly isolated rolled-back corruption probe, not a claim that a committed
51-RAID graph is supported. A PM
response has at most 25 assigned projects, 500 total existing and blocker items,
262,144 UTF-8 bytes per sanitized blocker facet, 2 MiB combined JSON, and the
existing 20-second transaction and statement/lock deadlines. Aggregate work is
at most 25 times the per-project limits; never truncate. A leadership response
has one project and the same per-facet byte/work limits. Validate all limits
and complete references before either response is returned.

## Required review and verification

Independent design, source-authority, lock-order, privacy and coverage review
precedes implementation. Exercise attested empty, missing/stale/restricted or
conflicting inventory, exact threshold boundaries, partial coverage with a
known aged case, unresolved and future dates, close/reopen, threshold absence and
first insert, and source/authority conflicts. Prove both writer-first and
reader-first races for source revocation, threshold changes and reopen using
actual backend IDs and observed PostgreSQL blockers, then verify post-wait
data and fresh access. Add both lock orders for authority-policy and PM-grant
revocation, first threshold insert and lock timeout. Compare an old saved
assessment to live advice after threshold, access, authority and opened-period
changes; its historical proof remains frozen and separately access-controlled.
Exercise multi-project membership, 25/26 and aggregate
overflow, role/tenant scope, malformed evidence and no-write behavior. Include
real API/OpenAPI and browser scope/session/visibility/late-response checks.
Check the 50/51 RAID and 1,000/1,001 history boundaries, exact item/byte
limits, UTC threshold equality and finite versus UNTIL_SUPERSEDED provenance.
For no-write evidence compare relevant row contents and separately intercept
mutating operations, including nonpersisted conflict cases; counts alone do not
establish absence of changes or rolled-back attempts.
Run native tests only against a separately qualified owned disposable target;
localhost and a database name are not ownership proof. Do not run the local
wrapper against the default service; its complete target must first be
independently verified as isolated. Review the exact final
candidate and required hosted checks, merge with expected head, verify the merge
tree and post-merge checks, then update the evidence ledger. No acceptance claim
follows from an unexecuted fixture or mocked browser alone.

## Production diagnostic increment

The reviewed head `b716bb42a7b0cce4615623a6b3d6a56c327c163a` was tested
against base `5aafae959b88fcd5e141ba8c7be909b1dee31f4a`. Foundation run
40928798692's verify job passed. Production-boundary attempt 1 failed during the
external customer restore after entering `sessions_before_commit`; the public
log does not establish the underlying failure. One unchanged rerun, job
123654521327, failed at `loaded-details-disclosure` before the natural-expiry
wait and the final secret comparison. That stage covers several recorder and
page operations and does not establish a secret leak, expiry failure or cause.
These are separate retained failures, not passing evidence. A cancellation
interaction with the PM queue is a hypothesis only.

The next diagnostic preserves the original CDP response capture, disclosure
checks, natural expiry, authorization and database assertions and all existing
deadlines. On that one failure stage it emits only a fixed last-entered capture
subphase, saturated 0/1/2+ counters for known recorder failure categories,
unresolved and unprepared targets, and a token-seen boolean. No exception text,
request path, response, identifier, URL, body, token, secret or digest is
emitted. The snapshot is point-in-time and cannot identify a request or prove
causation. Diagnostics must not replace the primary failure or relax capture;
synthetic tests exercise counter classes, timeouts and canary redaction.
At that diagnostic checkpoint, independent review and exact-head hosted
validation remained required before merge. A diagnostic result is not a fix or
an acceptance decision.

## Reviewed candidate and merge

The final diagnostic candidate's public head was
`80ebfbbc2574c4a91d2134db6ff588131052c75e`, with reviewed tree
`d3e0dbd35ee8163970dad08f642f9878c5fb4d9f`. Foundation 40934477559 and
Documentation 40934477495 passed on that head. Their checkout was synthetic
merge `8acbc4c948e04238dcc12eb6b776439aaa8eb813`, with ordered parents
`5aafae959b88fcd5e141ba8c7be909b1dee31f4a` and the head and the same tree.
PR #122 merged as `d7194d6a97af59db125123dba1a6f77f19e312ee`; its actual
ordered parents and tree match that reviewed combination. Actual post-merge
Foundation 40938266008 and Documentation 40938266234 passed.
The earlier two failed production attempts and their unknown causes are retained
above. A later successful run demonstrates that run passed; it does not explain
or erase the failures. No story, criterion, issue or release hold is accepted.
