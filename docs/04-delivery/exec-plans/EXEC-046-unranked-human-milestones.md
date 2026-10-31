# EXEC-046: Unranked human-reported milestone states

Status: local implementation started; no endpoint or acceptance. Base is merged
PR #141 `374f2ee950599c62bf12d351459acbfa0ff3bf24`; its actual post-merge
Foundation check was still running at this checkpoint. Original19/20 capture
remains stopped, OD-013/014 remain in force, and spreadsheet/connector proposals
do not become source facts. This slice does not complete GOLDEN-003.

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
A local, currently unused canonical-project preflight checks scoped receipt
metadata and the seven declared and actual collection counts. Focused mocked
metadata tests passed, as did a read-only API-role PostgreSQL smoke on one
previously created synthetic project using a `pg` query adapter. This does not
test Prisma transport, authorization ordering, programme and size boundaries,
concurrent changes or native proof validation after preflight. It does not
establish that the forthcoming read is safe to expose.
An additional unused fact-prefix admission helper checks bounded metadata,
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
An unwired comparator checks that a later loaded prefix has the same ordered
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
