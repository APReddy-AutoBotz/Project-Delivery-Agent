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
filtering inconvenient inputs. Human reports do not prove Jira or sheet origin.

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
