# EXEC-042: Observe a human-origin milestone state disagreement

Status: design and implementation in progress; not accepted. This is a
read-only, human-origin step toward the source-backed scenario in EXEC-039. It
does not implement source publication, enable live Jira onboarding or comment
reads, create a PM request, or complete GOLDEN-003. Original19/20 capture remains
stopped. Spreadsheet commits continue to save reviewed proposals only.

Expose a same-fact authority disagreement for a visible canonical milestone
only when a complete bounded current human-v1 prefix has an applicable equal-tier
policy and at least two distinct current state values. Preserve every selected-tier
version, evidence and source association; never choose a winner or call this the
confirmed milestone-versus-required-work conflict. An absent policy, stale or
ambiguous input, inaccessible contributor, incomplete prefix, unsupported origin
or inconsistent graph must fail closed rather than omit an alternative. Output
is a bounded presentation contract, not independent proof of authorization.
An applicable current stream head with stale or unknown validity withholds the
entire observation; superseded historical versions are not rejected merely
for historical freshness. Future and nonapplicable versions remain subject to
the existing resolver. Every stored source in the prefix still requires current
reader access, including superseded or unselected history.

The repository must hold the scoped project and current leadership grant locks,
validate the sealed canonical milestone binding, authorize every source in the
entire stored prefix and use the existing authority resolver. It must preserve
exact fact/version/evidence/source identity and recheck graph coherence while
the project lock is held. No read may create an assessment, conflict record,
reconciliation request, audit event or other business mutation. Record the
precise database-role, race, API, browser and recovery evidence that actually
exists; a synthetic human statement cannot establish Jira or sheet provenance.

Before merge, independently review the final design and exact candidate; test
both full and denied scopes, duplicate and stale inputs, no-policy versus a
policy tie, bounded complete histories, binding identity, revocation races and
absence of writes using synthetic data and native PostgreSQL. The existing
cross-object evaluator must remain unchanged and return UNKNOWN for unresolved
individual states. Complete the applicable hosted and post-merge gates. The
approved story and release acceptance totals remain unchanged.

The current local draft includes a presentation contract, a read-only
repository, ten focused schema/reader tests and a synthetic PostgreSQL test with
two human writers, source-reader removal in both transaction orderings, and a
disabled-policy check. The focused tests passed in an isolated copied test
setup, and the repository and focused tests typechecked there. The PostgreSQL
test has not run; its races, database role/ACL checks and no-write snapshots are
not execution evidence. The repository relies on the current v1 writers'
project-gate triggers, not arbitrary privileged trigger-bypassing maintenance;
the reviewed source lock graph still requires native verification.
This draft has no API route or UI wiring. The prepared race covers application
source-reader removal, not direct-SQL writer enforcement, policy or grant
revocation races, or global deadlock freedom. Those remain open.
