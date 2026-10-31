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
test had not run at that initial checkpoint. The repository relies on the current v1 writers'
project-gate triggers, not arbitrary privileged trigger-bypassing maintenance;
the reviewed source lock graph still requires native verification.
The next local change adds an authenticated, read-only API route with strict
response validation and a separate leadership action for the selected milestone;
14 focused schema, reader and mocked-HTTP tests passed locally, and the generated
OpenAPI snapshot adds only that route. A synthetic browser test passed locally
for selection, denial, bounded response cancellation, expiry refresh, held
responses across selection and sign-out, and a transient-DOM observer canary.
The browser test uses intercepted responses and a bounded post-consumption
observation; it is not native authorization or a guarantee of real-time timer
execution while the browser is suspended. Native HTTP and hosted checks for the
additional code remain pending. The prepared race covers application
source-reader removal, not direct-SQL writer enforcement, policy or grant
revocation races, or global deadlock freedom. Those remain open.

Public draft head `515048ce56b27fad8bee70768a455e9e4bf79708` was tested with
main merge `6c5b30cbcece992135606c27f6fcca807c5e3694` in candidate
`2bac947e0dc025f4fc96c6b7ae44fffba7bf3a91`, tree
`333e2a634e76c362764a1b7e7f8b35062d21e6cd`. Foundation run `41199982388`'s
verify and production-boundary jobs passed, and documentation run `41199982490`
passed. The verify job included 28 milestone-reconciliation integration tests and
the 85-table native recovery check. That suite includes the role-switched
human-source, disabled-policy, no-write snapshot and two-order reader-removal
tests. Checks on the later API and UI changes remain pending;
no broader direct-writer, policy/grant race or acceptance claim follows.

The API/UI public candidate `07467a006cc181008cb500c5c65f6aab75cb2f0d`
failed the verify job `124540386903` of Foundation run `41202318544` at architecture validation: the browser
decoder imported a domain runtime schema. The local correction uses a
presentation-only decoder with a type-only domain import and moves the shared
request type into an acyclic module; the architecture checker and focused
decoder/API tests passed locally. The decoder tests exercise the same malformed
responses against both server and browser validation. Native HTTP and the
corrected candidate's hosted validation remain pending.

The next verify job `124542359067` of Foundation run `41202994446` passed
architecture and contract snapshot checks but failed the shared API-contract
coverage assertion because the new route was absent from that suite's exercised
successes. The local correction injects a synthetic disagreement repository
and validates an actual serialized 200 response against the published contract.
The 17-test shared API-contract file passed locally; hosted validation remains
required before acceptance.

The local follow-up also adds synthetic database tests for fact revisions and
policy disablement in both orderings with milestone disagreement reads. These
tests are not evidence of serialization until run under native PostgreSQL;
direct-SQL enforcement and leadership-grant races remain open.

A further local test draft exercises API-role direct SQL source-reader removal
and application-repository leadership-grant revocation in both orderings, designed to observe backend
process IDs and actual lock waits. These tests have not run against PostgreSQL;
their presence does not close either race or establish global deadlock freedom.

Another local native-test draft distinguishes absent policy from an equal-tier
tie and an expired alternative from a later current revision. It is not yet
PostgreSQL execution evidence.
