# EXEC-046: Unranked human-reported milestone states

Status: local implementation started; no endpoint or acceptance. Base is merged
PR #141 `374f2ee950599c62bf12d351459acbfa0ff3bf24`; its actual post-merge
Foundation and Documentation checks passed. Reconcile current main before any
publication. Original19/20 capture
remains stopped, OD-013/014 remain in force, and spreadsheet/connector proposals
do not become source facts. This slice does not complete GOLDEN-003.

The subsequent evidence ledger PR #142 merged as
`28852f306956f82946f8c77afea8a348cafab063`, tree
`ba4f7d096c981d8d0a2d0ab11fa1840fa14d3406`, with ordered parents
`374f2ee950599c62bf12d351459acbfa0ff3bf24` and reviewed head
`6a80e5b46c4a8359d6d6f7b23395ad0d2cb4fee8`. Candidate Foundation
`41215228464` and Documentation `41215228449`, and actual post-merge Foundation
`41217633613` and Documentation `41217633628`, passed. It changes no acceptance.

## Intended limited behavior

For leadership authorized to read a sealed canonical milestone and every
source in its complete human-statement history, a separately typed read-only
observation may show different explicitly unexpired applicable human-reported
states when the authority policy aggregate is truly absent. Show all qualifying
states with their own evidence and one database as-of, without ranking,
selecting a winner, calling the outcome an authority conflict, or issuing or
delivering a request. A disabled, scheduled, corrupt or inaccessible policy is
not proof that no policy exists. Missing, expired, ambiguous, restricted or
unsupported applicable history must fail closed; do not infer disagreement by
filtering inconvenient inputs. Stored human-reported provenance does not by
itself verify authorship or prove Jira or sheet origin. The initial binding
uses its binding receipt; native version constraints alone do not require a
matching append receipt for every later version, so do not imply otherwise or
silently add that eligibility requirement. Do not expose original statement
text in this diagnostic.

The first local change defines only a strict presentation shape. It requires
distinct alternatives and explicit future contributor expiry, bounds output,
and cannot establish policy absence, source access, temporal completeness or
any database invariant. No route or user-facing feature is enabled by it.
A local pure transformation now uses the existing temporal resolver to select
unambiguous, explicitly unexpired human-v1 heads from a caller-supplied complete
snapshot, rejecting unsupported approvals and inconsistent source/evidence
associations. Snapshot completeness, source access, actual absent policy and
stored graph integrity remain caller proof obligations, not conclusions of this
transformation. Its output bound is not an input, SQL or transport bound.
A local canonical-project preflight checks scoped receipt
metadata and the seven declared and actual collection counts. Focused mocked
metadata tests passed, as did a read-only API-role PostgreSQL smoke on one
previously created synthetic project using a `pg` query adapter. This does not
test Prisma transport, authorization ordering, programme and size boundaries,
concurrent changes or native proof validation after preflight. It does not
establish that the forthcoming read is safe to expose.
An internal, not-yet-exposed reader now composes this preflight with scoped
leadership checks, fact-prefix admission, native binding validation, complete
source access and graph checks, a coherence reread and the pure projection.
One local rollback-only API-role Prisma probe returned two evidence-linked
human states for a synthetic canonical milestone, denied a non-leader and
withheld the view after one source reader was removed. It checked selected
assessment, conflict and correlation-audit counts around two reads, then verified
scoped project/grant/audit rollback. It used a transaction shim and does not
prove normal transaction boundaries, complete no-write behavior or races.
An expanded run restored source access, created a synthetic active policy and
confirmed the no-policy reader withheld the view while the existing equal-tier
reader returned the same two evidence-linked states and exact policy revision.
This was also a single rolled-back, same-transaction case, not a policy-birth
race or a full regression suite.
Two targeted integration cases subsequently passed against a separate synthetic
PostgreSQL 17 database using normal repository transaction boundaries. They
cover exact evidence, source and version identities, selected authorization
denials, source-reader removal, creation of an active policy and the existing
equal-tier result, plus an expired source. Selected scoped data and audit
snapshots were unchanged by the reads. These cases do not prove all-table
no-write behavior, transaction ordering or the remaining negative cases. The
first local run used Node 22. All sixteen targeted cases described here were
subsequently rerun successfully on Node 24 against the same isolated synthetic
PostgreSQL 17 database. This is not the full integration suite or hosted proof.
Two more targeted cases passed on that synthetic database for first-policy
creation through the current repository writer. They observed the expected
project-lock blocker in both reader-first and writer-first orders, then checked
the unranked result or withholding and the created revision. They do not cover
arbitrary writers, source or grant revocation, fact append or deadlock freedom.
Eight further targeted cases passed for repository-mediated source-reader
removal and leadership-grant revocation, in both transaction orders and for
both unranked and existing equal-tier reads. They observed the expected lock
blockers and subsequent withholding or denial. They do not prove direct SQL
mutation behavior, complete no-write behavior or global deadlock freedom.
Two additional cases passed for a repository-mediated human fact append,
observing the project-lock blocker in both orders and checking the exact old
or new version, evidence and source as appropriate. This covers one source and
effective-time scenario, not arbitrary writers or all temporal edge cases.
Two sequential cases also passed for an existing disabled policy revision and
an enabled revision scheduled in the future: neither aggregate was treated as
absent, and selected scoped snapshots remained unchanged by the reads.
For FR-EVD-009/012 and FR-QA-007, an unregistered local controller boundary and
an unused browser decoder now validate the separate unranked DTO. Direct tests
cover scope, generic denial/unavailability and representative malformed and
oversized decoded objects. They do not demonstrate an HTTP route, response
headers, wire-byte limits, browser expiry or live authorization. The existing
equal-tier route is unchanged. Registration and presentation require the
remaining native, API and browser proofs and independent review.
Further native and independent review is required; there is no HTTP route or
user-facing view.
An internal fact-prefix admission helper checks bounded metadata,
contiguous revision identities, the absence of a policy aggregate and absence
of stored conflicts. Mocked metadata tests and one read-only API-role PostgreSQL
smoke cover rejection of an existing synthetic fact with a policy, via a `pg`
adapter. The broader no-policy and conflict paths, subsequent exact comparison,
source access and race behavior require further native tests.
A second local synthetic probe admitted one arbitrary no-policy fact using the
Prisma adapter and API role, then verified its fixture and audit rows were rolled
back. That transaction used a repository shim; it does not prove the canonical
milestone flow, full authorization, conflict rejection or concurrent behavior.
After extracting shared version admission, both this positive probe and the
read-only policy-present rejection probe passed again against the revised code.
An internal comparator checks that a later loaded prefix has the same ordered
version, scope, revision, source and evidence identities; it does not compare
fact contents or establish immutability, source access or a writer fence.
Its reusable version admission applies a 1 MiB per-fact limit; any future
multi-fact caller also needs a separately enforced aggregate budget. Applying
the existing total limit of 1,000 fact revisions across the observation remains
mandatory. Applying this new limit to an existing read may make formerly readable histories
unavailable and requires compatibility review.
An unwired policy-history preflight and comparator apply a per-history 4 MiB
admission limit and distinguish SQL NULL from a non-null definition. Mocked
tests and one read-only API-role PostgreSQL smoke via `pg` cover admission and
native history validation for one synthetic policy. They do not establish Prisma
transport, policy selection, authorization or concurrency behavior. Any
multi-fact caller must also preserve the existing combined 1,000-revision and
4 MiB limits across all policies, not just invoke the per-history limit.

## Remaining proof and integration

Use the existing project/leadership and full-prefix source-reader checks with
complete contiguous versions, canonical binding validation, human provenance,
finite resource limits and a coherent reread. Derive latest applicable stream
heads using the existing temporal semantics; do not use policy-selected
candidates or manufacture authority freshness. Avoid fact tuple locks after the
project gate. Verify no policy aggregate exists under the project gate; supported
first-policy creation and relevant source/fact mutations must conflict with that
gate. Prove both transaction orders and actual blockers in synthetic PostgreSQL,
including policy creation, fact updates, source-reader and grant revocations.
Test future, disabled and malformed policy, temporal ambiguity, expired or missing
validity, same-valued reports, inaccessible or nonhuman history, oversized data,
cross-tenant and role denials, and complete rollback/no-write snapshots. Design
and independently review bounded API serialization and as-of UI behavior,
including cancellation, stale responses, session changes and contributor expiry.
Exact-candidate review, hosted checks, merge and actual post-merge verification
remain required. No current statement changes any acceptance total.

For a future transport, use a separately authorized leadership route and
explicit action; never fall back to it based on an equal-tier error. Validate
strict route identity and DTO shape, cap the wire stream before parsing, return
generic unavailable errors, and apply no-store to success and every error.
Successful output reveals that no policy aggregate existed at its as-of and
that all required historical sources were accessible to that actor. Existing
authority reads expose a null policy identifier to project-authorized leaders,
but the combined disclosure still requires an explicit information-flow
review, especially for historical sources.

Present any result as a historical observation with no selected winner. Say
reports, policy or access may have changed and ask for refresh before reliance;
contributor expiry is not a guarantee of current authorization or policy.
The client must invalidate on selection/session changes, hide on backgrounding,
abort on refresh and enforce a finite body deadline. Use no periodic polling or
unbounded automatic retry. Track both wall and monotonic time and fail closed
on observed regression or contributor expiry; test sleep, clock changes,
page restoration and delayed bodies in real browsers. The existing polling
resource cannot be reused unchanged for this behavior.

Before adding the read, independently review a shared, transaction-owned
preparation seam with the existing equal-tier observation. Preserve its prior
authorization, error and resolver semantics for inputs within the reviewed
limits; any newly rejected over-budget history is an explicit availability
change. Run preflight only after the existing project and token-compatible grant
gate; preserve DENIED until the selected milestone is established visible, so an
oversized hidden project cannot become an existence oracle. Test both authorized
and unauthorized oversized inputs. Preflight before canonical-project and state-binding validators,
prefix or policy materialization, and other relevant detail reads. The state-binding validator scans
the fact's versions, and the existing prefix loader materializes values, so
check bounded version counts, continuity and aggregate value bytes before
either operation; bound conflict rows before invoking conflict validators. A
truly absent policy with stored authority-conflict history must fail closed.
For the existing equal-tier path, bound the complete policy revision count and
aggregate definition bytes before the prefix loader or authority-history
validator, including future and disabled revisions; do not validate only the
selected event. Cover admitted boundaries and the intended over-limit response
without weakening existing conflict or no-winner semantics.
Also account for the canonical-project validator, its child collections and
programme validation: preflight actual bounded scope and retain database
statement and lock timeouts. A bounded result alone does not bound database
scan, sort, I/O or a large value before byte accounting. These limits control
this path's requested work, not arbitrary SQL execution or
privileged trigger-bypassing maintenance. Validate the complete stored
version/evidence/source graph and a current reader for every historical source,
not merely each contributor shown in the output.
